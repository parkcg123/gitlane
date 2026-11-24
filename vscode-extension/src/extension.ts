import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConflictManagerPanel } from './conflictPanel';
import { FlowConfig, loadRepoConfig } from './config';
import { GitClient, GitError } from './git';
import { isProtectedBranch, sanitizeTaskName, validateTaskName } from './naming';
import {
  buildRepoLabels,
  DiscoveredRepo,
  findContainingRepo,
  findGitRootForPath,
  scanNestedGitRepos,
} from './repoDiscovery';
import { FlowStatusBar, RepoStatusTarget } from './statusBar';
import {
  MergeTargetChoice,
  PendingConflictContext,
  WorkflowService,
  WorkflowUI,
} from './workflow';

const PENDING_CONFLICT_KEY_PREFIX = 'gitlane.pendingConflict:';

interface BuiltinGitApi {
  repositories?: Array<{ rootUri?: vscode.Uri }>;
  onDidOpenRepository?: vscode.Event<unknown>;
  onDidCloseRepository?: vscode.Event<unknown>;
}

function getBuiltinGitApi(onActivated?: () => void): BuiltinGitApi | undefined {
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) {
      return undefined;
    }
    if (!ext.isActive) {
      if (onActivated) {
        void Promise.resolve(ext.activate()).then(
          () => onActivated(),
          () => undefined
        );
      }
      return undefined;
    }
    const exportsObj = ext.exports as { getAPI?: (version: number) => BuiltinGitApi } | undefined;
    return exportsObj?.getAPI?.(1);
  } catch {
    return undefined;
  }
}

function getActiveEditorFilePath(): string | null {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  return activeUri && activeUri.scheme === 'file' ? activeUri.fsPath : null;
}

function discoverWorkspaceRepos(onGitActivated?: () => void): DiscoveredRepo[] {
  const roots: string[] = [];
  const workspaceRoots: string[] = [];

  const gitApi = getBuiltinGitApi(onGitActivated);
  for (const repo of gitApi?.repositories ?? []) {
    if (repo.rootUri?.scheme === 'file') {
      roots.push(repo.rootUri.fsPath);
    }
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === 'file') {
      workspaceRoots.push(folder.uri.fsPath);
      roots.push(...scanNestedGitRepos(folder.uri.fsPath, 2));
    }
  }

  const activeFilePath = getActiveEditorFilePath();
  if (activeFilePath) {
    const root = findGitRootForPath(activeFilePath);
    if (root) {
      roots.push(root);
    }
  }

  return buildRepoLabels(roots, workspaceRoots);
}

function resolveActiveRepo(
  repos: DiscoveredRepo[],
  lastSelectedRepoRoot: string | undefined
): DiscoveredRepo | undefined {
  if (repos.length === 0) {
    return undefined;
  }
  const activeFilePath = getActiveEditorFilePath();
  const containing = findContainingRepo(activeFilePath, repos);
  if (containing) {
    return containing;
  }
  if (lastSelectedRepoRoot) {
    const remembered = repos.find((repo) => repo.root === lastSelectedRepoRoot);
    if (remembered) {
      return remembered;
    }
  }
  return repos[0];
}

function readIdeConfigOverrides(): Partial<FlowConfig> {
  const cfg = vscode.workspace.getConfiguration('gitlane');
  return {
    useDevelopBranch: cfg.get<boolean>('useDevelopBranch'),
    developBranch: cfg.get<string>('developBranch'),
    masterBranch: cfg.get<string>('masterBranch'),
    remote: cfg.get<string>('remote'),
    returnToDevelopAfterRelease: cfg.get<boolean>('returnToDevelopAfterRelease'),
    useNoFastForwardMerge: cfg.get<boolean>('useNoFastForwardMerge'),
  };
}

class VscodeWorkflowUI implements WorkflowUI {
  constructor(
    private readonly repoRoot: string,
    private readonly separator: string,
    private readonly useDevelopBranch: boolean,
    private readonly workspaceState: vscode.Memento,
    private readonly onOpenConflictManager?: () => Promise<void>,
    private readonly repoLabel?: string
  ) {}

  private titleWithRepo(baseTitle: string): string {
    if (!this.repoLabel) {
      return baseTitle;
    }
    return baseTitle.includes('—')
      ? baseTitle.replace('GitLane —', `GitLane [${this.repoLabel}] —`)
      : `[${this.repoLabel}] ${baseTitle}`;
  }

  private prefixMessage(message: string): string {
    return this.repoLabel ? `[${this.repoLabel}] ${message}` : message;
  }

  private get pendingStateKey(): string {
    return `${PENDING_CONFLICT_KEY_PREFIX}${this.repoRoot}`;
  }

  async promptTaskName(datePrefix: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const inputBox = vscode.window.createInputBox();
      inputBox.title = this.titleWithRepo('GitLane — ① 작업 시작');
      inputBox.placeholder = '예: login_fix 또는 로그인_오류_수정';
      inputBox.prompt = `생성될 브랜치: ${datePrefix}<작업명>`;
      inputBox.ignoreFocusOut = true;

      let settled = false;
      const finish = (value: string | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        inputBox.dispose();
        resolve(value);
      };

      inputBox.onDidChangeValue((value) => {
        const error = validateTaskName(value, this.separator);
        const sanitized = sanitizeTaskName(value, this.separator);
        inputBox.validationMessage = value.trim().length > 0 && error ? error : undefined;
        inputBox.prompt = sanitized
          ? `생성될 브랜치: ${datePrefix}${sanitized}`
          : `생성될 브랜치: ${datePrefix}<작업명>`;
      });

      inputBox.onDidAccept(() => {
        const error = validateTaskName(inputBox.value, this.separator);
        if (error) {
          inputBox.validationMessage = error;
          return;
        }
        finish(inputBox.value);
      });

      inputBox.onDidHide(() => finish(undefined));
      inputBox.show();
    });
  }

  async confirmDirtyStart(): Promise<'stash' | 'cancel'> {
    const picked = await vscode.window.showWarningMessage(
      this.prefixMessage('커밋되지 않은 변경사항이 있습니다. 임시 저장(Stash) 후 새 작업을 시작할까요?'),
      { modal: true },
      '임시 저장(Stash) 후 진행'
    );
    return picked === '임시 저장(Stash) 후 진행' ? 'stash' : 'cancel';
  }

  async confirmExistingBranch(branchName: string): Promise<'checkout' | 'cancel'> {
    const picked = await vscode.window.showInformationMessage(
      this.prefixMessage(`'${branchName}' 브랜치가 이미 존재합니다. 해당 브랜치로 이동할까요?`),
      { modal: true },
      '기존 브랜치로 이동'
    );
    return picked === '기존 브랜치로 이동' ? 'checkout' : 'cancel';
  }

  async promptMergeTarget(
    taskBranch: string,
    developBranch: string,
    masterBranch: string
  ): Promise<MergeTargetChoice> {
    interface TargetQuickPickItem extends vscode.QuickPickItem {
      target: MergeTargetChoice;
    }

    const items: TargetQuickPickItem[] = [
      {
        label: `$(git-merge) ${developBranch} (스테이지에만 반영)`,
        description: `${taskBranch} → ${developBranch}`,
        detail: '일반 작업 흐름: 스테이지(develop)에만 병합하고 푸시합니다.',
        target: 'develop',
      },
      {
        label: `$(rocket) ${masterBranch} (운영에만 반영)`,
        description: `${taskBranch} → ${masterBranch}`,
        detail: '스테이지를 거치지 않고 운영(master)에만 병합하고 푸시합니다.',
        target: 'master',
      },
      {
        label: `$(checklist) ${developBranch} + ${masterBranch} (둘 다 반영)`,
        description: `${taskBranch} → ${developBranch} & ${masterBranch}`,
        detail: '작업 브랜치를 develop과 master에 각각 병합하고 푸시합니다.',
        target: 'both',
      },
      {
        label: '$(close) 취소',
        description: '현재 브랜치에 머무릅니다.',
        target: 'cancel',
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: this.titleWithRepo(`② 작업 반영 대상 선택 (${taskBranch})`),
      placeHolder: '반영할 대상 브랜치를 선택하세요',
      ignoreFocusOut: true,
    });

    return picked?.target ?? 'cancel';
  }

  async confirmMergeToDevelop(
    taskBranch: string,
    developBranch: string,
    commitCount: number
  ): Promise<'delete' | 'keep' | 'cancel'> {
    interface MergeQuickPickItem extends vscode.QuickPickItem {
      action: 'delete' | 'keep' | 'cancel';
    }

    const isMultiTarget = developBranch.includes(' + ');
    const items: MergeQuickPickItem[] = [
      {
        label: '$(trash) 병합 + 푸시 + 브랜치 삭제',
        description: `${taskBranch} → ${developBranch} (${commitCount}개 커밋)`,
        detail: isMultiTarget || !this.useDevelopBranch
          ? '병합 및 푸시 완료 후 작업 브랜치를 정리합니다.'
          : '반영 후 작업 브랜치를 정리합니다.',
        action: 'delete',
      },
      {
        label: '$(git-branch) 병합 + 푸시 (브랜치 유지)',
        description: `${taskBranch} → ${developBranch} (${commitCount}개 커밋)`,
        detail: isMultiTarget || !this.useDevelopBranch
          ? '추가 수정이 필요하면 작업 브랜치를 유지합니다.'
          : '확인 중 추가 수정이 필요하면 작업 브랜치를 유지합니다.',
        action: 'keep',
      },
      {
        label: '$(close) 취소',
        description: '현재 브랜치로 돌아갑니다.',
        action: 'cancel',
      },
    ];

    const baseTitle = this.useDevelopBranch
      ? `② 작업 반영 (${taskBranch} → ${developBranch})`
      : `② 운영 바로 반영 (${taskBranch} → ${developBranch})`;
    const picked = await vscode.window.showQuickPick(items, {
      title: this.titleWithRepo(baseTitle),
      placeHolder: `반영 방식 선택 (최대 ${commitCount}개 커밋)`,
      ignoreFocusOut: true,
    });

    return picked?.action ?? 'cancel';
  }

  async confirmDeleteAlreadyMergedBranch(
    taskBranch: string,
    targetSummary: string
  ): Promise<boolean> {
    const picked = await vscode.window.showInformationMessage(
      this.prefixMessage(
        `'${taskBranch}'는 이미 '${targetSummary}'에 반영되어 병합할 새 커밋이 없습니다. 작업 브랜치를 삭제할까요?`
      ),
      { modal: true },
      '브랜치 삭제'
    );
    return picked === '브랜치 삭제';
  }

  async confirmDeleteTaskBranch(
    taskBranch: string,
    unmergedCommitCount: number,
    returnBranch: string
  ): Promise<boolean> {
    const message =
      unmergedCommitCount > 0
        ? `'${taskBranch}'에 아직 병합되지 않은 커밋이 ${unmergedCommitCount}개 있습니다. 강제 삭제(-D)하고 '${returnBranch}'로 이동할까요?`
        : `'${taskBranch}' 브랜치를 삭제하고 '${returnBranch}'로 이동할까요?`;
    const confirmLabel = unmergedCommitCount > 0 ? '강제 삭제' : '브랜치 삭제';
    const picked = await vscode.window.showWarningMessage(
      this.prefixMessage(message),
      {
        modal: true,
        detail:
          unmergedCommitCount > 0
            ? '로컬 및 원격 작업 브랜치가 삭제되며, 병합되지 않은 커밋은 복구하기 어려울 수 있습니다.'
            : '로컬 및 원격(존재 시) 작업 브랜치를 정리합니다.',
      },
      confirmLabel
    );
    return picked === confirmLabel;
  }

  async confirmReleaseToMaster(
    developBranch: string,
    masterBranch: string,
    aheadCommits: string[]
  ): Promise<'release' | 'cancel'> {
    const previewLines = aheadCommits.slice(0, 5).map((line) => `• ${line}`);
    if (aheadCommits.length > 5) {
      previewLines.push(`... 외 ${aheadCommits.length - 5}건`);
    }

    const picked = await vscode.window.showWarningMessage(
      this.prefixMessage(`'${developBranch}'의 ${aheadCommits.length}개 커밋을 운영('${masterBranch}')에 반영할까요?`),
      {
        modal: true,
        detail: previewLines.join('\n'),
      },
      '운영(master)에 병합 및 푸시'
    );

    return picked === '운영(master)에 병합 및 푸시' ? 'release' : 'cancel';
  }

  async confirmAbortMerge(targetBranch: string): Promise<boolean> {
    const picked = await vscode.window.showWarningMessage(
      this.prefixMessage(`'${targetBranch}' 병합을 취소하고 원래 상태로 복구할까요?`),
      { modal: true },
      '머지 취소 (원복)'
    );
    return picked === '머지 취소 (원복)';
  }

  async promptConflictAction(
    context: PendingConflictContext,
    conflictedFiles: string[]
  ): Promise<'open' | 'abort' | 'later'> {
    if (this.onOpenConflictManager) {
      await this.onOpenConflictManager();
      void vscode.window.showWarningMessage(
        this.prefixMessage(
          `'${context.sourceBranch}' → '${context.targetBranch}' 병합 중 ${conflictedFiles.length}개 파일에서 충돌이 발생했습니다. 충돌 관리 창에서 해결을 진행해 주세요.`
        )
      );
      return 'later';
    }

    const previewFiles = conflictedFiles.slice(0, 5).map((f) => `• ${f}`);
    if (conflictedFiles.length > 5) {
      previewFiles.push(`... 외 ${conflictedFiles.length - 5}개 파일`);
    }

    const picked = await vscode.window.showWarningMessage(
      this.prefixMessage(
        `'${context.sourceBranch}' → '${context.targetBranch}' 병합 중 충돌이 발생했습니다 (${conflictedFiles.length}개 파일).`
      ),
      {
        detail: previewFiles.join('\n'),
      },
      '충돌 파일 열기',
      '머지 취소 (원복)'
    );

    if (picked === '충돌 파일 열기') {
      return 'open';
    }
    if (picked === '머지 취소 (원복)') {
      return 'abort';
    }
    return 'later';
  }

  async showInfo(message: string): Promise<void> {
    await vscode.window.showInformationMessage(this.prefixMessage(message));
  }

  async showWarning(message: string): Promise<void> {
    await vscode.window.showWarningMessage(this.prefixMessage(message));
  }

  async showError(message: string): Promise<void> {
    await vscode.window.showErrorMessage(this.prefixMessage(message));
  }

  async openMergeEditorFile(relPath: string): Promise<void> {
    const fullPath = path.resolve(this.repoRoot, relPath);
    if (!fs.existsSync(fullPath)) {
      return;
    }
    const uri = vscode.Uri.file(fullPath);
    try {
      await vscode.commands.executeCommand('git.openMergeEditor', uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: false });
    }
  }

  async openTextFile(relPath: string): Promise<void> {
    const fullPath = path.resolve(this.repoRoot, relPath);
    if (!fs.existsSync(fullPath)) {
      return;
    }
    const uri = vscode.Uri.file(fullPath);
    await vscode.window.showTextDocument(uri, { preview: false });
  }

  async openConflictedFiles(files: string[]): Promise<void> {
    for (const relPath of files) {
      await this.openMergeEditorFile(relPath);
    }
  }

  getPendingConflict(): PendingConflictContext | undefined {
    return this.workspaceState.get<PendingConflictContext>(this.pendingStateKey);
  }

  async setPendingConflict(context: PendingConflictContext | undefined): Promise<void> {
    await this.workspaceState.update(this.pendingStateKey, context);
  }
}

function buildStatusTargets(repos: DiscoveredRepo[]): RepoStatusTarget[] {
  const ideOverrides = readIdeConfigOverrides();
  return repos.map((repo) => {
    const { config } = loadRepoConfig(repo.root, ideOverrides);
    return {
      root: repo.root,
      label: repo.label,
      config,
    };
  });
}

async function refreshGitUi(
  statusBar: FlowStatusBar,
  conflictPanel: ConflictManagerPanel | undefined,
  getLastSelectedRoot: () => string | undefined,
  onGitActivated?: () => void
): Promise<void> {
  try {
    await vscode.commands.executeCommand('git.refresh');
  } catch {
    // Built-in git extension might not be active yet.
  }

  const repos = discoverWorkspaceRepos(onGitActivated);
  const targets = buildStatusTargets(repos);
  const activeRepo = resolveActiveRepo(repos, getLastSelectedRoot());
  await statusBar.update(targets, activeRepo?.root ?? null);
  await conflictPanel?.refreshIfOpen();
}

interface RepoWorkflowMenuItem extends vscode.QuickPickItem {
  run?: () => Promise<void>;
}

async function withWorkflowContext(
  context: vscode.ExtensionContext,
  statusBar: FlowStatusBar,
  conflictPanel: ConflictManagerPanel,
  getLastSelectedRoot: () => string | undefined,
  setLastSelectedRoot: (root: string) => void,
  onGitActivated: (() => void) | undefined,
  runner: (
    service: WorkflowService,
    git: GitClient,
    ui: VscodeWorkflowUI,
    config: FlowConfig,
    openConflictPanel: () => Promise<void>
  ) => Promise<void>,
  explicitRepo?: DiscoveredRepo,
  isMultiRepo?: boolean
): Promise<void> {
  const repos = discoverWorkspaceRepos(onGitActivated);
  const targetRepo = explicitRepo ?? resolveActiveRepo(repos, getLastSelectedRoot());
  if (!targetRepo) {
    await vscode.window.showWarningMessage(
      '열려 있는 Git 저장소를 찾을 수 없습니다. 프로젝트 폴더를 열어 주세요.'
    );
    return;
  }

  setLastSelectedRoot(targetRepo.root);
  const multiRepo = isMultiRepo ?? repos.length >= 2;
  const repoLabel = multiRepo ? targetRepo.label : undefined;

  const { config, warning } = loadRepoConfig(targetRepo.root, readIdeConfigOverrides());
  if (warning) {
    void vscode.window.showWarningMessage(
      repoLabel ? `[${repoLabel}] ${warning}` : warning
    );
  }

  const git = new GitClient(targetRepo.root);
  let service!: WorkflowService;
  let ui!: VscodeWorkflowUI;
  const openConflictPanel = async (): Promise<void> => {
    await conflictPanel.showOrReveal({
      repoRoot: targetRepo.root,
      repoLabel,
      git,
      service,
      getPendingConflict: () => ui.getPendingConflict(),
      openMergeEditorFile: (relPath) => ui.openMergeEditorFile(relPath),
      openTextFile: (relPath) => ui.openTextFile(relPath),
      onStateMutated: () =>
        refreshGitUi(statusBar, conflictPanel, getLastSelectedRoot, onGitActivated),
    });
  };
  ui = new VscodeWorkflowUI(
    targetRepo.root,
    config.separator,
    config.useDevelopBranch,
    context.workspaceState,
    openConflictPanel,
    repoLabel
  );
  service = new WorkflowService(git, ui, config);

  try {
    await runner(service, git, ui, config, openConflictPanel);
  } catch (err) {
    const message =
      err instanceof GitError || err instanceof Error ? err.message : String(err);
    const prefix = repoLabel ? `[${repoLabel}] ` : '';
    await vscode.window.showErrorMessage(`GitLane 오류: ${prefix}${message}`);
  } finally {
    await refreshGitUi(statusBar, conflictPanel, getLastSelectedRoot, onGitActivated);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new FlowStatusBar();
  const conflictPanel = new ConflictManagerPanel();
  context.subscriptions.push(statusBar, conflictPanel);

  let lastSelectedRepoRoot: string | undefined;
  let boundGitApi = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const bindGitApiListeners = () => {
    if (boundGitApi) {
      return;
    }
    const gitApi = getBuiltinGitApi();
    if (!gitApi) {
      return;
    }
    boundGitApi = true;
    if (gitApi.onDidOpenRepository) {
      context.subscriptions.push(gitApi.onDidOpenRepository(() => scheduleRefresh()));
    }
    if (gitApi.onDidCloseRepository) {
      context.subscriptions.push(gitApi.onDidCloseRepository(() => scheduleRefresh()));
    }
  };

  const onGitActivated = () => {
    bindGitApiListeners();
    scheduleRefresh();
  };

  const scheduleRefresh = () => {
    bindGitApiListeners();
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      void (async () => {
        const repos = discoverWorkspaceRepos(onGitActivated);
        const targets = buildStatusTargets(repos);
        const activeRepo = resolveActiveRepo(repos, lastSelectedRepoRoot);
        await statusBar.update(targets, activeRepo?.root ?? null);
        await conflictPanel.refreshIfOpen();
      })();
    }, 150);
  };

  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    },
  });

  const gitHeadWatcher = vscode.workspace.createFileSystemWatcher('**/.git/{HEAD,MERGE_HEAD,index}');
  gitHeadWatcher.onDidCreate(scheduleRefresh);
  gitHeadWatcher.onDidChange(scheduleRefresh);
  gitHeadWatcher.onDidDelete(scheduleRefresh);
  context.subscriptions.push(gitHeadWatcher);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(scheduleRefresh),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
    vscode.workspace.onDidSaveTextDocument(() => {
      void conflictPanel.refreshIfOpen();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitlane')) {
        scheduleRefresh();
      }
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        scheduleRefresh();
      }
    })
  );

  const getLastRoot = () => lastSelectedRepoRoot;
  const setLastRoot = (root: string) => {
    lastSelectedRepoRoot = root;
  };

  const openMenuForSingleRepo = async (repo: DiscoveredRepo): Promise<void> => {
    await withWorkflowContext(
      context,
      statusBar,
      conflictPanel,
      getLastRoot,
      setLastRoot,
      onGitActivated,
      async (service, git, ui, config, openConflictPanel) => {
        const merging = await git.isMergeInProgress();
        if (merging) {
          const conflictItems: Array<RepoWorkflowMenuItem & { run: () => Promise<void> }> = [
            {
              label: '$(layout) 충돌 관리 창 열기 (IntelliJ 스타일)',
              description: '파일별 적용/병합 창 열기 및 해결 현황 확인',
              run: async () => {
                await openConflictPanel();
              },
            },
            {
              label: '$(warning) 충돌 파일 열기',
              description: 'Merge Editor에서 충돌 해결하기',
              run: async () => {
                const files = await git.getConflictedFiles();
                if (files.length === 0) {
                  await ui.showInfo('남아 있는 충돌 파일이 없습니다. 완료를 실행해 주세요.');
                  return;
                }
                await ui.openConflictedFiles(files);
              },
            },
            {
              label: '$(check) 충돌 해결 완료 (커밋 & 푸시)',
              description: '충돌을 모두 해결하고 저장한 뒤 실행하세요',
              run: async () => {
                await service.continueAfterConflict();
              },
            },
            {
              label: '$(discard) 머지 취소 (원복)',
              description: '병합을 중단하고 이전 브랜치로 돌아갑니다',
              run: async () => {
                await service.abortMerge();
              },
            },
          ];

          const picked = await vscode.window.showQuickPick(conflictItems, {
            title: 'GitLane — 머지 충돌 해결 중',
            placeHolder: '실행할 작업을 선택하세요',
          });
          if (picked?.run) {
            await picked.run();
          }
          return;
        }

        const rawBranch = await git.getCurrentBranch();
        const currentBranch = rawBranch ?? 'HEAD 분리됨';
        const onTaskBranch = rawBranch !== null && !isProtectedBranch(rawBranch, config);
        const menuItems: Array<RepoWorkflowMenuItem & { run: () => Promise<void> }> = [
          {
            label: '$(git-branch) ① 작업 시작 (브랜치 생성)',
            description: `${config.useDevelopBranch ? config.developBranch : config.masterBranch} → YYYYMMDD${config.separator}작업명`,
            run: async () => {
              await service.startTask();
            },
          },
        ];

        if (onTaskBranch) {
          menuItems.push(
            {
              label: config.useDevelopBranch
                ? '$(git-merge) ② 작업 반영 (병합 / 완료)'
                : `$(rocket) ② 운영 반영 (${config.masterBranch} 바로 병합)`,
              description: config.useDevelopBranch
                ? `현재 작업(${currentBranch}) → ${config.developBranch} / ${config.masterBranch} 선택`
                : `현재 작업(${currentBranch}) → ${config.masterBranch}`,
              run: async () => {
                await service.mergeToDevelop();
              },
            },
            {
              label: '$(trash) 작업 브랜치 삭제',
              description: `현재 작업(${currentBranch}) 삭제 후 복귀`,
              run: async () => {
                await service.deleteTaskBranch();
              },
            }
          );
        }

        if (config.useDevelopBranch) {
          menuItems.push({
            label: `$(rocket) ③ 운영 반영 (${config.developBranch} → ${config.masterBranch})`,
            description: `${config.developBranch} → ${config.masterBranch}`,
            run: async () => {
              await service.releaseToMaster();
            },
          });
        }

        const picked = await vscode.window.showQuickPick(menuItems, {
          title: `GitLane (현재: ${currentBranch})`,
          placeHolder: '실행할 워크플로우를 선택하세요',
        });
        if (picked?.run) {
          await picked.run();
        }
      },
      repo,
      false
    );
  };

  const openMenuForMultipleRepos = async (repos: DiscoveredRepo[]): Promise<void> => {
    const activeRepo = resolveActiveRepo(repos, lastSelectedRepoRoot);
    const ideOverrides = readIdeConfigOverrides();
    const repoStates = await Promise.all(
      repos.map(async (repo) => {
        const { config } = loadRepoConfig(repo.root, ideOverrides);
        const git = new GitClient(repo.root);
        try {
          const [merging, branch] = await Promise.all([
            git.isMergeInProgress(),
            git.getCurrentBranch(),
          ]);
          return { repo, config, merging, branch };
        } catch {
          return { repo, config, merging: false, branch: null as string | null };
        }
      })
    );

    const items: RepoWorkflowMenuItem[] = [];
    for (const state of repoStates) {
      const { repo, config, merging, branch } = state;
      const isActive = repo.root === activeRepo?.root;
      const statusText = merging
        ? '머지 충돌 중'
        : branch === null
          ? 'HEAD 분리됨'
          : branch === config.masterBranch
            ? `${branch} (운영)`
            : config.useDevelopBranch && branch === config.developBranch
              ? `${branch} (스테이지)`
              : branch;

      items.push({
        label: `${repo.label} · ${statusText}${isActive ? ' (현재)' : ''}`,
        kind: vscode.QuickPickItemKind.Separator,
      });

      const runOnRepo = (
        runner: (
          service: WorkflowService,
          git: GitClient,
          ui: VscodeWorkflowUI,
          cfg: FlowConfig,
          openConflictPanel: () => Promise<void>
        ) => Promise<void>
      ) =>
        withWorkflowContext(
          context,
          statusBar,
          conflictPanel,
          getLastRoot,
          setLastRoot,
          onGitActivated,
          runner,
          repo,
          true
        );

      if (merging) {
        items.push(
          {
            label: `$(layout) [${repo.label}] 충돌 관리 창 열기`,
            description: `${repo.label} · 파일별 해결 및 3-Way Merge`,
            run: () => runOnRepo(async (_s, _g, _u, _c, openPanel) => openPanel()),
          },
          {
            label: `$(warning) [${repo.label}] 충돌 파일 열기`,
            description: `${repo.label} · Merge Editor에서 충돌 해결`,
            run: () =>
              runOnRepo(async (_s, git, ui) => {
                const files = await git.getConflictedFiles();
                if (files.length === 0) {
                  await ui.showInfo('남아 있는 충돌 파일이 없습니다. 완료를 실행해 주세요.');
                  return;
                }
                await ui.openConflictedFiles(files);
              }),
          },
          {
            label: `$(check) [${repo.label}] 충돌 해결 완료 (커밋 & 푸시)`,
            description: `${repo.label} · 머지 커밋 생성 및 푸시`,
            run: () => runOnRepo(async (service) => void (await service.continueAfterConflict())),
          },
          {
            label: `$(discard) [${repo.label}] 머지 취소 (원복)`,
            description: `${repo.label} · 병합 중단 후 복구`,
            run: () => runOnRepo(async (service) => void (await service.abortMerge())),
          }
        );
        continue;
      }

      const currentBranch = branch ?? 'HEAD 분리됨';
      const baseBranch = config.useDevelopBranch ? config.developBranch : config.masterBranch;
      items.push({
        label: `$(git-branch) [${repo.label}] ① 작업 시작 (브랜치 생성)`,
        description: `${baseBranch} → YYYYMMDD${config.separator}작업명`,
        run: () => runOnRepo(async (service) => void (await service.startTask())),
      });

      const onTaskBranch = branch !== null && !isProtectedBranch(branch, config);
      if (onTaskBranch) {
        items.push(
          {
            label: config.useDevelopBranch
              ? `$(git-merge) [${repo.label}] ② 작업 반영 (병합 / 완료)`
              : `$(rocket) [${repo.label}] ② 운영 반영 (${config.masterBranch} 바로 병합)`,
            description: config.useDevelopBranch
              ? `${currentBranch} → ${config.developBranch} / ${config.masterBranch} 선택`
              : `${currentBranch} → ${config.masterBranch}`,
            run: () => runOnRepo(async (service) => void (await service.mergeToDevelop())),
          },
          {
            label: `$(trash) [${repo.label}] 작업 브랜치 삭제`,
            description: `${currentBranch} 삭제 후 복귀`,
            run: () => runOnRepo(async (service) => void (await service.deleteTaskBranch())),
          }
        );
      }

      if (config.useDevelopBranch) {
        items.push({
          label: `$(rocket) [${repo.label}] ③ 운영 반영 (${config.developBranch} → ${config.masterBranch})`,
          description: `${config.developBranch} → ${config.masterBranch}`,
          run: () => runOnRepo(async (service) => void (await service.releaseToMaster())),
        });
      }
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: `GitLane — 저장소 ${repos.length}개`,
      placeHolder: '저장소별 실행할 워크플로우를 선택하세요 (저장소명 검색 가능)',
    });
    if (picked?.run) {
      await picked.run();
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('gitlane.openMenu', async () => {
      const repos = discoverWorkspaceRepos(onGitActivated);
      if (repos.length === 0) {
        await vscode.window.showWarningMessage(
          '열려 있는 Git 저장소를 찾을 수 없습니다. 프로젝트 폴더를 열어 주세요.'
        );
        return;
      }
      if (repos.length === 1) {
        await openMenuForSingleRepo(repos[0]);
      } else {
        await openMenuForMultipleRepos(repos);
      }
    }),

    vscode.commands.registerCommand('gitlane.openConflictManager', () =>
      withWorkflowContext(
        context,
        statusBar,
        conflictPanel,
        getLastRoot,
        setLastRoot,
        onGitActivated,
        async (_service, git, ui, _config, openConflictPanel) => {
          if (!(await git.isMergeInProgress())) {
            await ui.showInfo('진행 중인 머지 충돌이 없습니다.');
            return;
          }
          await openConflictPanel();
        }
      )
    ),

    vscode.commands.registerCommand('gitlane.startTask', () =>
      withWorkflowContext(
        context,
        statusBar,
        conflictPanel,
        getLastRoot,
        setLastRoot,
        onGitActivated,
        async (service) => {
          await service.startTask();
        }
      )
    ),

    vscode.commands.registerCommand('gitlane.mergeToDevelop', () =>
      withWorkflowContext(
        context,
        statusBar,
        conflictPanel,
        getLastRoot,
        setLastRoot,
        onGitActivated,
        async (service) => {
          await service.mergeToDevelop();
        }
      )
    ),

    vscode.commands.registerCommand('gitlane.deleteTaskBranch', () =>
      withWorkflowContext(
        context,
        statusBar,
        conflictPanel,
        getLastRoot,
        setLastRoot,
        onGitActivated,
        async (service) => {
          await service.deleteTaskBranch();
        }
      )
    ),

    vscode.commands.registerCommand('gitlane.releaseToMaster', () =>
      withWorkflowContext(
        context,
        statusBar,
        conflictPanel,
        getLastRoot,
        setLastRoot,
        onGitActivated,
        async (service) => {
          await service.releaseToMaster();
        }
      )
    ),

    vscode.commands.registerCommand('gitlane.continueMerge', () =>
      withWorkflowContext(
        context,
        statusBar,
        conflictPanel,
        getLastRoot,
        setLastRoot,
        onGitActivated,
        async (service) => {
          await service.continueAfterConflict();
        }
      )
    ),

    vscode.commands.registerCommand('gitlane.abortMerge', () =>
      withWorkflowContext(
        context,
        statusBar,
        conflictPanel,
        getLastRoot,
        setLastRoot,
        onGitActivated,
        async (service) => {
          await service.abortMerge();
        }
      )
    )
  );

  scheduleRefresh();
}

export function deactivate(): void {
  // Subscriptions are disposed automatically by VS Code.
}
