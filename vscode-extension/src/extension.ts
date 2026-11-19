import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConflictManagerPanel } from './conflictPanel';
import { FlowConfig, loadRepoConfig } from './config';
import { GitClient, GitError } from './git';
import { sanitizeTaskName, validateTaskName } from './naming';
import { FlowStatusBar } from './statusBar';
import { PendingConflictContext, WorkflowService, WorkflowUI } from './workflow';

const PENDING_CONFLICT_KEY_PREFIX = 'gitlane.pendingConflict:';

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

async function resolveTargetRepoRoot(): Promise<string | null> {
  const candidates: string[] = [];

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri && activeUri.scheme === 'file') {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (activeFolder) {
      candidates.push(activeFolder.uri.fsPath);
    } else {
      candidates.push(path.dirname(activeUri.fsPath));
    }
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === 'file' && !candidates.includes(folder.uri.fsPath)) {
      candidates.push(folder.uri.fsPath);
    }
  }

  for (const candidate of candidates) {
    try {
      const git = new GitClient(candidate);
      return await git.getRepoRoot();
    } catch {
      // Try next workspace candidate
    }
  }

  return null;
}

class VscodeWorkflowUI implements WorkflowUI {
  constructor(
    private readonly repoRoot: string,
    private readonly separator: string,
    private readonly useDevelopBranch: boolean,
    private readonly workspaceState: vscode.Memento,
    private readonly onOpenConflictManager?: () => Promise<void>
  ) {}

  private get pendingStateKey(): string {
    return `${PENDING_CONFLICT_KEY_PREFIX}${this.repoRoot}`;
  }

  async promptTaskName(datePrefix: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const inputBox = vscode.window.createInputBox();
      inputBox.title = 'GitLane — ① 작업 시작';
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
      '커밋되지 않은 변경사항이 있습니다. 임시 저장(Stash) 후 새 작업을 시작할까요?',
      { modal: true },
      '임시 저장(Stash) 후 진행'
    );
    return picked === '임시 저장(Stash) 후 진행' ? 'stash' : 'cancel';
  }

  async confirmExistingBranch(branchName: string): Promise<'checkout' | 'cancel'> {
    const picked = await vscode.window.showInformationMessage(
      `'${branchName}' 브랜치가 이미 존재합니다. 해당 브랜치로 이동할까요?`,
      { modal: true },
      '기존 브랜치로 이동'
    );
    return picked === '기존 브랜치로 이동' ? 'checkout' : 'cancel';
  }

  async confirmMergeToDevelop(
    taskBranch: string,
    developBranch: string,
    commitCount: number
  ): Promise<'delete' | 'keep' | 'cancel'> {
    interface MergeQuickPickItem extends vscode.QuickPickItem {
      action: 'delete' | 'keep' | 'cancel';
    }

    const items: MergeQuickPickItem[] = [
      {
        label: '$(trash) 병합 + 푸시 + 브랜치 삭제',
        description: `${taskBranch} → ${developBranch} (${commitCount}개 커밋)`,
        detail: this.useDevelopBranch
          ? '스테이지 반영 후 작업 브랜치를 정리합니다.'
          : '운영 반영 후 작업 브랜치를 정리합니다.',
        action: 'delete',
      },
      {
        label: '$(git-branch) 병합 + 푸시 (브랜치 유지)',
        description: `${taskBranch} → ${developBranch} (${commitCount}개 커밋)`,
        detail: this.useDevelopBranch
          ? '스테이지 확인 중 추가 수정이 필요하면 이 옵션을 선택하세요.'
          : '추가 수정이 필요하면 이 옵션을 선택하세요.',
        action: 'keep',
      },
      {
        label: '$(close) 취소',
        description: '현재 브랜치로 돌아갑니다.',
        action: 'cancel',
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: this.useDevelopBranch
        ? `② 스테이지 반영 (${taskBranch} → ${developBranch})`
        : `② 운영 바로 반영 (${taskBranch} → ${developBranch})`,
      placeHolder: `반영 방식 선택 (${commitCount}개 커밋)`,
      ignoreFocusOut: true,
    });

    return picked?.action ?? 'cancel';
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
      `'${developBranch}'의 ${aheadCommits.length}개 커밋을 운영('${masterBranch}')에 반영할까요?`,
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
      `'${targetBranch}' 병합을 취소하고 원래 상태로 복구할까요?`,
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
        `'${context.sourceBranch}' → '${context.targetBranch}' 병합 중 ${conflictedFiles.length}개 파일에서 충돌이 발생했습니다. 충돌 관리 창에서 해결을 진행해 주세요.`
      );
      return 'later';
    }

    const previewFiles = conflictedFiles.slice(0, 5).map((f) => `• ${f}`);
    if (conflictedFiles.length > 5) {
      previewFiles.push(`... 외 ${conflictedFiles.length - 5}개 파일`);
    }

    const picked = await vscode.window.showWarningMessage(
      `'${context.sourceBranch}' → '${context.targetBranch}' 병합 중 충돌이 발생했습니다 (${conflictedFiles.length}개 파일).`,
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
    await vscode.window.showInformationMessage(message);
  }

  async showWarning(message: string): Promise<void> {
    await vscode.window.showWarningMessage(message);
  }

  async showError(message: string): Promise<void> {
    await vscode.window.showErrorMessage(message);
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

async function refreshGitUi(
  statusBar: FlowStatusBar,
  conflictPanel?: ConflictManagerPanel
): Promise<void> {
  try {
    await vscode.commands.executeCommand('git.refresh');
  } catch {
    // Built-in git extension might not be active yet.
  }

  const repoRoot = await resolveTargetRepoRoot();
  if (!repoRoot) {
    await statusBar.update(null, null);
    await conflictPanel?.refreshIfOpen();
    return;
  }
  const { config } = loadRepoConfig(repoRoot, readIdeConfigOverrides());
  await statusBar.update(repoRoot, config);
  await conflictPanel?.refreshIfOpen();
}

async function withWorkflowContext(
  context: vscode.ExtensionContext,
  statusBar: FlowStatusBar,
  conflictPanel: ConflictManagerPanel,
  runner: (
    service: WorkflowService,
    git: GitClient,
    ui: VscodeWorkflowUI,
    config: FlowConfig,
    openConflictPanel: () => Promise<void>
  ) => Promise<void>
): Promise<void> {
  const repoRoot = await resolveTargetRepoRoot();
  if (!repoRoot) {
    await vscode.window.showWarningMessage(
      '열려 있는 Git 저장소를 찾을 수 없습니다. 프로젝트 폴더를 열어 주세요.'
    );
    return;
  }

  const { config, warning } = loadRepoConfig(repoRoot, readIdeConfigOverrides());
  if (warning) {
    void vscode.window.showWarningMessage(warning);
  }

  const git = new GitClient(repoRoot);
  let service!: WorkflowService;
  let ui!: VscodeWorkflowUI;
  const openConflictPanel = async (): Promise<void> => {
    await conflictPanel.showOrReveal({
      repoRoot,
      git,
      service,
      getPendingConflict: () => ui.getPendingConflict(),
      openMergeEditorFile: (relPath) => ui.openMergeEditorFile(relPath),
      openTextFile: (relPath) => ui.openTextFile(relPath),
      onStateMutated: () => refreshGitUi(statusBar, conflictPanel),
    });
  };
  ui = new VscodeWorkflowUI(
    repoRoot,
    config.separator,
    config.useDevelopBranch,
    context.workspaceState,
    openConflictPanel
  );
  service = new WorkflowService(git, ui, config);

  try {
    await runner(service, git, ui, config, openConflictPanel);
  } catch (err) {
    const message =
      err instanceof GitError || err instanceof Error ? err.message : String(err);
    await vscode.window.showErrorMessage(`GitLane 오류: ${message}`);
  } finally {
    await refreshGitUi(statusBar, conflictPanel);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new FlowStatusBar();
  const conflictPanel = new ConflictManagerPanel();
  context.subscriptions.push(statusBar, conflictPanel);

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      void (async () => {
        const repoRoot = await resolveTargetRepoRoot();
        if (!repoRoot) {
          await statusBar.update(null, null);
          await conflictPanel.refreshIfOpen();
          return;
        }
        const { config } = loadRepoConfig(repoRoot, readIdeConfigOverrides());
        await statusBar.update(repoRoot, config);
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

  context.subscriptions.push(
    vscode.commands.registerCommand('gitlane.openMenu', () =>
      withWorkflowContext(
        context,
        statusBar,
        conflictPanel,
        async (service, git, ui, config, openConflictPanel) => {
          const merging = await git.isMergeInProgress();
          if (merging) {
            const conflictItems: Array<
              vscode.QuickPickItem & { run: () => Promise<void> }
            > = [
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
            if (picked) {
              await picked.run();
            }
            return;
          }

          const currentBranch = (await git.getCurrentBranch()) ?? 'HEAD 분리됨';
          const menuItems: Array<vscode.QuickPickItem & { run: () => Promise<void> }> = config.useDevelopBranch
            ? [
                {
                  label: '$(git-branch) ① 작업 시작 (브랜치 생성)',
                  description: `${config.developBranch} → YYYYMMDD${config.separator}작업명`,
                  run: async () => {
                    await service.startTask();
                  },
                },
                {
                  label: '$(git-merge) ② 스테이지 반영 (develop 병합)',
                  description: `현재 작업(${currentBranch}) → ${config.developBranch}`,
                  run: async () => {
                    await service.mergeToDevelop();
                  },
                },
                {
                  label: '$(rocket) ③ 운영 반영 (develop → master)',
                  description: `${config.developBranch} → ${config.masterBranch}`,
                  run: async () => {
                    await service.releaseToMaster();
                  },
                },
              ]
            : [
                {
                  label: '$(git-branch) ① 작업 시작 (브랜치 생성)',
                  description: `${config.masterBranch} → YYYYMMDD${config.separator}작업명`,
                  run: async () => {
                    await service.startTask();
                  },
                },
                {
                  label: `$(rocket) ② 운영 반영 (${config.masterBranch} 바로 병합)`,
                  description: `현재 작업(${currentBranch}) → ${config.masterBranch}`,
                  run: async () => {
                    await service.mergeToDevelop();
                  },
                },
              ];

          const picked = await vscode.window.showQuickPick(menuItems, {
            title: `GitLane (현재: ${currentBranch})`,
            placeHolder: '실행할 워크플로우를 선택하세요',
          });
          if (picked) {
            await picked.run();
          }
        }
      )
    ),

    vscode.commands.registerCommand('gitlane.openConflictManager', () =>
      withWorkflowContext(
        context,
        statusBar,
        conflictPanel,
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
      withWorkflowContext(context, statusBar, conflictPanel, async (service) => {
        await service.startTask();
      })
    ),

    vscode.commands.registerCommand('gitlane.mergeToDevelop', () =>
      withWorkflowContext(context, statusBar, conflictPanel, async (service) => {
        await service.mergeToDevelop();
      })
    ),

    vscode.commands.registerCommand('gitlane.releaseToMaster', () =>
      withWorkflowContext(context, statusBar, conflictPanel, async (service) => {
        await service.releaseToMaster();
      })
    ),

    vscode.commands.registerCommand('gitlane.continueMerge', () =>
      withWorkflowContext(context, statusBar, conflictPanel, async (service) => {
        await service.continueAfterConflict();
      })
    ),

    vscode.commands.registerCommand('gitlane.abortMerge', () =>
      withWorkflowContext(context, statusBar, conflictPanel, async (service) => {
        await service.abortMerge();
      })
    )
  );

  scheduleRefresh();
}

export function deactivate(): void {
  // Subscriptions are disposed automatically by VS Code.
}
