import { DEFAULT_FLOW_CONFIG, FlowConfig, getTaskBaseBranch } from './config';
import { GitClient } from './git';
import { buildTaskBranchName, formatLocalDate, isProtectedBranch, validateTaskName } from './naming';

export type MergeTargetChoice = 'develop' | 'master' | 'both' | 'cancel';

export interface PendingConflictContext {
  targetBranch: string;
  sourceBranch: string;
  returnBranch: string;
  deleteSourceOnComplete: boolean;
  kind: 'mergeToDevelop' | 'mergeToMaster' | 'releaseToMaster';
  remainingTargets?: string[];
  initialConflictedFiles?: string[];
}

export type WorkflowStatus = 'success' | 'cancelled' | 'blocked' | 'conflict' | 'noop';

export interface WorkflowResult {
  status: WorkflowStatus;
  message: string;
  branch?: string;
  conflictedFiles?: string[];
}

export interface WorkflowUI {
  promptTaskName(datePrefix: string): Promise<string | undefined>;
  confirmDirtyStart(): Promise<'stash' | 'cancel'>;
  confirmPopStash(taskBranch: string): Promise<boolean>;
  confirmExistingBranch(branchName: string): Promise<'checkout' | 'cancel'>;
  promptMergeTarget(
    taskBranch: string,
    developBranch: string,
    masterBranch: string
  ): Promise<MergeTargetChoice>;
  confirmMergeToDevelop(
    taskBranch: string,
    developBranch: string,
    commitCount: number,
    aheadCommits: string[]
  ): Promise<'delete' | 'keep' | 'cancel'>;
  confirmDeleteAlreadyMergedBranch(taskBranch: string, targetSummary: string): Promise<boolean>;
  confirmDeleteTaskBranch(
    taskBranch: string,
    unmergedCommitCount: number,
    returnBranch: string
  ): Promise<boolean>;
  promptSelectBranchesToDelete(branches: string[]): Promise<string[] | undefined>;
  confirmReleaseToMaster(
    developBranch: string,
    masterBranch: string,
    aheadCommits: string[]
  ): Promise<'release' | 'cancel'>;
  confirmAbortMerge(targetBranch: string): Promise<boolean>;
  promptConflictAction(
    context: PendingConflictContext,
    conflictedFiles: string[]
  ): Promise<'open' | 'abort' | 'later'>;
  showInfo(message: string): Promise<void> | void;
  showWarning(message: string): Promise<void> | void;
  showError(message: string): Promise<void> | void;
  openConflictedFiles(files: string[]): Promise<void>;
  getPendingConflict(): Promise<PendingConflictContext | undefined> | PendingConflictContext | undefined;
  setPendingConflict(context: PendingConflictContext | undefined): Promise<void> | void;
}

export class WorkflowService {
  constructor(
    private readonly git: GitClient,
    private readonly ui: WorkflowUI,
    private readonly config: FlowConfig,
    private readonly nowProvider: () => Date = () => new Date()
  ) {}

  private async checkInProgressState(): Promise<WorkflowResult | null> {
    if (await this.git.isMergeInProgress()) {
      const msg = '진행 중인 머지가 있습니다. 먼저 충돌을 해결하거나 머지를 취소해 주세요.';
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }
    if (await this.git.isRebaseInProgress()) {
      const msg = '진행 중인 리베이스가 있습니다. 먼저 리베이스를 완료하거나 중단해 주세요.';
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }
    return null;
  }

  private async syncBranch(branch: string): Promise<void> {
    const hasRemote = await this.git.hasRemote(this.config.remote);
    if (hasRemote) {
      await this.git.fetch(this.config.remote);
    }

    const exists = await this.git.ensureLocalBranch(branch, this.config.remote);
    if (!exists) {
      throw new Error(
        `브랜치 '${branch}'를 로컬 또는 원격('${this.config.remote}')에서 찾을 수 없습니다.`
      );
    }

    await this.git.checkout(branch);

    if (hasRemote && (await this.git.branchExistsRemote(this.config.remote, branch))) {
      try {
        await this.git.pullFastForwardOnly(this.config.remote, branch);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (/fast-forward|diverg/i.test(detail)) {
          throw new Error(
            `로컬 '${branch}' 브랜치가 원격('${this.config.remote}/${branch}')과 분기되어 자동 최신화(--ff-only)할 수 없습니다. 로컬 변경을 정리하거나 수동으로 동기화한 뒤 다시 시도해 주세요.`
          );
        }
        throw err;
      }
    }
  }

  private async pushIfRemoteExists(branch: string): Promise<boolean> {
    if (await this.git.hasRemote(this.config.remote)) {
      try {
        await this.git.push(this.config.remote, branch);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (/non-fast-forward|fetch first|rejected/i.test(detail)) {
          throw new Error(
            `로컬 '${branch}' 병합은 완료되었으나 원격('${this.config.remote}/${branch}')에 다른 팀원의 새 커밋이 있어 푸시가 거절되었습니다. '${branch}'에서 최신 원격을 Pull(동기화)한 뒤 다시 푸시해 주세요.`
          );
        }
        throw err;
      }
      return true;
    }
    return false;
  }

  private async cleanupTaskBranch(taskBranch: string, force = false): Promise<void> {
    await this.git.deleteLocalBranch(taskBranch, force);
    if (
      (await this.git.hasRemote(this.config.remote)) &&
      (await this.git.branchExistsRemote(this.config.remote, taskBranch))
    ) {
      try {
        await this.git.deleteRemoteBranch(this.config.remote, taskBranch);
      } catch {
        // Remote branch deletion is best-effort after local cleanup.
      }
    }
  }

  private async restoreBranchIfExists(branch: string | null | undefined): Promise<void> {
    if (branch && (await this.git.branchExistsLocal(branch))) {
      await this.git.checkout(branch);
    }
  }

  private async executeAbort(ctx: PendingConflictContext | undefined): Promise<WorkflowResult> {
    await this.git.mergeAbort();
    await this.restoreBranchIfExists(ctx?.returnBranch);
    await this.ui.setPendingConflict(undefined);
    const msg = '머지를 취소하고 원래 상태로 복구했습니다.';
    await this.ui.showInfo(msg);
    return { status: 'success', branch: ctx?.returnBranch, message: msg };
  }

  private async handleMergeConflict(
    context: PendingConflictContext,
    conflictedFiles: string[]
  ): Promise<WorkflowResult> {
    await this.ui.setPendingConflict(context);
    const action = await this.ui.promptConflictAction(context, conflictedFiles);

    if (action === 'abort') {
      return this.executeAbort(context);
    }

    if (action === 'open') {
      await this.ui.openConflictedFiles(conflictedFiles);
    }

    const msg = `머지 충돌이 발생했습니다 (${conflictedFiles.length}개 파일). 충돌 해결 후 '충돌 해결 완료'를 실행해 주세요.`;
    return {
      status: 'conflict',
      message: msg,
      branch: context.targetBranch,
      conflictedFiles,
    };
  }

  /**
   * Action 1: Sync base branch (`develop` or `master` when `useDevelopBranch` is false) and create `YYYYMMDD_<task>` branch.
   */
  async startTask(): Promise<WorkflowResult> {
    const blocked = await this.checkInProgressState();
    if (blocked) {
      return blocked;
    }

    let stashed = false;
    if (await this.git.hasUncommittedChanges()) {
      const dirtyChoice = await this.ui.confirmDirtyStart();
      if (dirtyChoice === 'cancel') {
        return { status: 'cancelled', message: '작업 시작을 취소했습니다.' };
      }
      await this.git.stashPush('gitlane: auto-stash before startTask');
      stashed = true;
    }

    const baseBranch = getTaskBaseBranch(this.config);
    const originalBranch = await this.git.getCurrentBranch();
    await this.syncBranch(baseBranch);

    const now = this.nowProvider();
    const datePrefix = `${formatLocalDate(now)}${this.config.separator || '_'}`;
    const rawName = await this.ui.promptTaskName(datePrefix);

    if (rawName === undefined) {
      if (originalBranch && originalBranch !== baseBranch) {
        await this.restoreBranchIfExists(originalBranch);
      }
      return { status: 'cancelled', message: '작업 시작을 취소했습니다.' };
    }

    const validationError = validateTaskName(rawName, this.config.separator);
    if (validationError) {
      if (originalBranch && originalBranch !== baseBranch) {
        await this.restoreBranchIfExists(originalBranch);
      }
      await this.ui.showError(validationError);
      return { status: 'blocked', message: validationError };
    }

    const taskBranch = buildTaskBranchName(rawName, this.config, now);

    const tryPopStash = async (): Promise<void> => {
      if (!stashed) {
        return;
      }
      if (!(await this.ui.confirmPopStash(taskBranch))) {
        return;
      }
      try {
        await this.git.stashPop();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await this.ui.showWarning(
          `임시 저장(Stash) 복원 중 충돌 또는 오류가 발생했습니다. Stash 목록에서 수동으로 확인해 주세요: ${detail}`
        );
      }
    };

    if (await this.git.branchExistsLocal(taskBranch)) {
      const existingChoice = await this.ui.confirmExistingBranch(taskBranch);
      if (existingChoice === 'cancel') {
        if (originalBranch && originalBranch !== baseBranch) {
          await this.restoreBranchIfExists(originalBranch);
        }
        return { status: 'cancelled', message: '작업 시작을 취소했습니다.' };
      }
      await this.git.checkout(taskBranch);
      await tryPopStash();
      const msg = `기존 작업 브랜치 '${taskBranch}'로 이동했습니다.`;
      await this.ui.showInfo(msg);
      return { status: 'success', branch: taskBranch, message: msg };
    }

    await this.git.checkoutNewBranch(taskBranch);
    await tryPopStash();
    const msg = `새 작업 브랜치 '${taskBranch}'를 '${baseBranch}'에서 생성했습니다.`;
    await this.ui.showInfo(msg);
    return { status: 'success', branch: taskBranch, message: msg };
  }

  private resolveSelectedTargets(choice: MergeTargetChoice): string[] {
    if (choice === 'develop') {
      return [this.config.developBranch];
    }
    if (choice === 'master') {
      return [this.config.masterBranch];
    }
    if (choice === 'both') {
      return this.config.developBranch === this.config.masterBranch
        ? [this.config.masterBranch]
        : [this.config.developBranch, this.config.masterBranch];
    }
    return [];
  }

  private async executeTaskMergeTargets(params: {
    taskBranch: string;
    targets: string[];
    deleteSourceOnComplete: boolean;
    alreadySynced: boolean;
    completedTargets?: string[];
    anyPushedSoFar?: boolean;
  }): Promise<WorkflowResult> {
    const doneTargets = [...(params.completedTargets ?? [])];
    let anyPushed = params.anyPushedSoFar ?? false;

    for (let i = 0; i < params.targets.length; i++) {
      const target = params.targets[i];
      const remaining = params.targets.slice(i + 1);

      if (!params.alreadySynced) {
        await this.syncBranch(target);
        const remainingAhead = await this.git.getAheadCommits(target, params.taskBranch);
        if (remainingAhead.length === 0) {
          doneTargets.push(target);
          continue;
        }
      } else if ((await this.git.getCurrentBranch()) !== target) {
        await this.git.checkout(target);
      }

      const mergeResult = await this.git.merge(
        params.taskBranch,
        this.config.useNoFastForwardMerge
      );
      if (mergeResult.conflicted) {
        const kind = target === this.config.masterBranch ? 'mergeToMaster' : 'mergeToDevelop';
        return this.handleMergeConflict(
          {
            targetBranch: target,
            sourceBranch: params.taskBranch,
            returnBranch: params.taskBranch,
            deleteSourceOnComplete: params.deleteSourceOnComplete,
            kind,
            remainingTargets: remaining.length > 0 ? remaining : undefined,
            initialConflictedFiles: mergeResult.conflictedFiles,
          },
          mergeResult.conflictedFiles
        );
      }

      const pushed = await this.pushIfRemoteExists(target);
      anyPushed = anyPushed || pushed;
      doneTargets.push(target);
    }

    let finalBranch = params.targets[params.targets.length - 1];
    if (params.deleteSourceOnComplete) {
      // Delete while HEAD is still on the merged target so `git branch -d` succeeds even for master-only merges.
      await this.cleanupTaskBranch(params.taskBranch, false);
      if (
        this.config.useDevelopBranch &&
        this.config.returnToDevelopAfterRelease &&
        finalBranch === this.config.masterBranch &&
        (await this.git.branchExistsLocal(this.config.developBranch))
      ) {
        await this.git.checkout(this.config.developBranch);
        finalBranch = this.config.developBranch;
      }
    } else {
      await this.git.checkout(params.taskBranch);
      finalBranch = params.taskBranch;
    }

    await this.ui.setPendingConflict(undefined);
    const targetsLabel = doneTargets.join(' + ');
    const pushSuffix = anyPushed ? ' 및 푸시' : ' (로컬 전용)';
    const branchSuffix = params.deleteSourceOnComplete
      ? `, '${params.taskBranch}' 삭제`
      : `, '${params.taskBranch}' 유지`;
    const msg = `'${params.taskBranch}' → '${targetsLabel}' 병합${pushSuffix} 완료${branchSuffix}`;
    await this.ui.showInfo(msg);
    return {
      status: 'success',
      branch: finalBranch,
      message: msg,
    };
  }

  /**
   * Action 2: Merge current task branch into selected target branch(es) (`develop`, `master`, or both) and optionally delete it.
   */
  async mergeToDevelop(): Promise<WorkflowResult> {
    const blocked = await this.checkInProgressState();
    if (blocked) {
      return blocked;
    }

    const actionLabel = this.config.useDevelopBranch ? '작업 반영' : '운영 반영';

    const taskBranch = await this.git.getCurrentBranch();
    if (!taskBranch) {
      const msg = `Detached HEAD 상태에서는 ${actionLabel}을 진행할 수 없습니다.`;
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }

    if (isProtectedBranch(taskBranch, this.config)) {
      const msg = `보호 브랜치('${taskBranch}')에서는 ${actionLabel}을 실행할 수 없습니다. 작업 브랜치로 이동해 주세요.`;
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }

    if (await this.git.hasUncommittedChanges()) {
      const msg = '커밋되지 않은 변경사항이 있습니다. 먼저 커밋하거나 Stash한 뒤 다시 시도해 주세요.';
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }

    let selectedTargets: string[];
    if (this.config.useDevelopBranch) {
      const targetChoice = await this.ui.promptMergeTarget(
        taskBranch,
        this.config.developBranch,
        this.config.masterBranch
      );
      if (targetChoice === 'cancel') {
        return { status: 'cancelled', branch: taskBranch, message: `${actionLabel}을 취소했습니다.` };
      }
      selectedTargets = this.resolveSelectedTargets(targetChoice);
    } else {
      selectedTargets = [this.config.masterBranch];
    }

    const targetCounts: Array<{ branch: string; commits: string[] }> = [];
    for (const target of selectedTargets) {
      await this.syncBranch(target);
      const aheadCommits = await this.git.getAheadCommits(target, taskBranch);
      targetCounts.push({ branch: target, commits: aheadCommits });
    }

    const effectiveTargets = targetCounts.filter((item) => item.commits.length > 0);
    if (effectiveTargets.length === 0) {
      const targetSummary = selectedTargets.join(' + ');
      const shouldDelete = await this.ui.confirmDeleteAlreadyMergedBranch(taskBranch, targetSummary);
      if (shouldDelete) {
        const landingBranch =
          this.config.useDevelopBranch && selectedTargets.includes(this.config.developBranch)
            ? this.config.developBranch
            : selectedTargets[0];
        if ((await this.git.getCurrentBranch()) !== landingBranch) {
          await this.git.checkout(landingBranch);
        }
        await this.cleanupTaskBranch(taskBranch, false);
        const msg = `'${taskBranch}'는 이미 '${targetSummary}'에 반영되어 있어 브랜치를 삭제했습니다.`;
        await this.ui.showInfo(msg);
        return { status: 'success', branch: landingBranch, message: msg };
      }

      await this.git.checkout(taskBranch);
      const msg = `${targetSummary}에 병합할 새 커밋이 없습니다.`;
      await this.ui.showInfo(msg);
      return { status: 'noop', branch: taskBranch, message: msg };
    }

    const effectiveBranches = effectiveTargets.map((item) => item.branch);
    let previewTarget = effectiveTargets[0];
    for (const item of effectiveTargets) {
      if (item.commits.length > previewTarget.commits.length) {
        previewTarget = item;
      }
    }
    const maxCommitCount = previewTarget.commits.length;
    const choice = await this.ui.confirmMergeToDevelop(
      taskBranch,
      effectiveBranches.join(' + '),
      maxCommitCount,
      previewTarget.commits
    );

    if (choice === 'cancel') {
      await this.git.checkout(taskBranch);
      return { status: 'cancelled', branch: taskBranch, message: `${actionLabel}을 취소했습니다.` };
    }

    return this.executeTaskMergeTargets({
      taskBranch,
      targets: effectiveBranches,
      deleteSourceOnComplete: choice === 'delete',
      alreadySynced: true,
    });
  }

  /**
   * Standalone Action: Delete the current non-protected task branch (safe `-d` if merged, warning + `-D` if unmerged).
   */
  async deleteTaskBranch(): Promise<WorkflowResult> {
    const blocked = await this.checkInProgressState();
    if (blocked) {
      return blocked;
    }

    const taskBranch = await this.git.getCurrentBranch();
    if (!taskBranch) {
      const msg = 'Detached HEAD 상태에서는 브랜치 삭제를 진행할 수 없습니다.';
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }

    if (isProtectedBranch(taskBranch, this.config)) {
      const msg = `보호 브랜치('${taskBranch}')는 삭제할 수 없습니다.`;
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }

    if (await this.git.hasUncommittedChanges()) {
      const msg = '커밋되지 않은 변경사항이 있습니다. 먼저 커밋하거나 Stash한 뒤 다시 시도해 주세요.';
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }

    const candidateBases = this.config.useDevelopBranch
      ? [this.config.developBranch, this.config.masterBranch]
      : [this.config.masterBranch];

    let mergedTarget: string | undefined;
    for (const candidate of candidateBases) {
      if (await this.git.branchExistsLocal(candidate)) {
        const ahead = await this.git.getAheadCommits(candidate, taskBranch);
        if (ahead.length === 0) {
          mergedTarget = candidate;
          break;
        }
      }
    }

    const preferredBase = getTaskBaseBranch(this.config);
    let returnBranch: string | undefined;
    if (await this.git.branchExistsLocal(preferredBase)) {
      returnBranch = preferredBase;
    } else {
      for (const candidate of candidateBases) {
        if (await this.git.branchExistsLocal(candidate)) {
          returnBranch = candidate;
          break;
        }
      }
    }

    if (!returnBranch) {
      const created = await this.git.ensureLocalBranch(preferredBase, this.config.remote);
      if (created) {
        returnBranch = preferredBase;
      } else {
        throw new Error(`복귀할 기준 브랜치('${preferredBase}')를 찾을 수 없습니다.`);
      }
    }

    const unmergedCommitCount = mergedTarget
      ? 0
      : (await this.git.getAheadCommits(returnBranch, taskBranch)).length;

    const confirmed = await this.ui.confirmDeleteTaskBranch(
      taskBranch,
      unmergedCommitCount,
      returnBranch
    );
    if (!confirmed) {
      return { status: 'cancelled', branch: taskBranch, message: '브랜치 삭제를 취소했습니다.' };
    }

    if (mergedTarget) {
      await this.git.checkout(mergedTarget);
      await this.cleanupTaskBranch(taskBranch, false);
      if (returnBranch !== mergedTarget) {
        await this.git.checkout(returnBranch);
      }
    } else {
      await this.git.checkout(returnBranch);
      await this.cleanupTaskBranch(taskBranch, true);
    }

    const msg = `'${taskBranch}' 브랜치를 삭제하고 '${returnBranch}'로 이동했습니다.`;
    await this.ui.showInfo(msg);
    return { status: 'success', branch: returnBranch, message: msg };
  }

  /**
   * Action 3: Merge verified develop branch into master and push.
   */
  async releaseToMaster(): Promise<WorkflowResult> {
    const blocked = await this.checkInProgressState();
    if (blocked) {
      return blocked;
    }

    if (!this.config.useDevelopBranch) {
      const msg =
        '현재 저장소는 develop 브랜치를 사용하지 않는 모드(useDevelopBranch: false)입니다. 작업 브랜치에서 운영 바로 반영을 실행해 주세요.';
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }

    if (await this.git.hasUncommittedChanges()) {
      const msg = '커밋되지 않은 변경사항이 있습니다. 먼저 커밋하거나 Stash한 뒤 다시 시도해 주세요.';
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }

    const originalBranch = await this.git.getCurrentBranch();
    await this.syncBranch(this.config.developBranch);
    await this.syncBranch(this.config.masterBranch);

    const aheadCommits = await this.git.getAheadCommits(
      this.config.masterBranch,
      this.config.developBranch
    );

    if (aheadCommits.length === 0) {
      const restoreTarget =
        originalBranch && originalBranch !== this.config.masterBranch
          ? originalBranch
          : this.config.developBranch;
      await this.restoreBranchIfExists(restoreTarget);
      const msg = `${this.config.masterBranch}에 반영할 새 커밋이 없습니다.`;
      await this.ui.showInfo(msg);
      return { status: 'noop', branch: restoreTarget, message: msg };
    }

    const choice = await this.ui.confirmReleaseToMaster(
      this.config.developBranch,
      this.config.masterBranch,
      aheadCommits
    );

    if (choice === 'cancel') {
      const restoreTarget =
        originalBranch && originalBranch !== this.config.masterBranch
          ? originalBranch
          : this.config.developBranch;
      await this.restoreBranchIfExists(restoreTarget);
      return { status: 'cancelled', branch: restoreTarget, message: '운영 반영을 취소했습니다.' };
    }

    const mergeResult = await this.git.merge(
      this.config.developBranch,
      this.config.useNoFastForwardMerge
    );
    if (mergeResult.conflicted) {
      return this.handleMergeConflict(
        {
          targetBranch: this.config.masterBranch,
          sourceBranch: this.config.developBranch,
          returnBranch: originalBranch ?? this.config.developBranch,
          deleteSourceOnComplete: false,
          kind: 'releaseToMaster',
          initialConflictedFiles: mergeResult.conflictedFiles,
        },
        mergeResult.conflictedFiles
      );
    }

    const pushed = await this.pushIfRemoteExists(this.config.masterBranch);

    let finalBranch = this.config.masterBranch;
    if (this.config.returnToDevelopAfterRelease) {
      await this.git.checkout(this.config.developBranch);
      finalBranch = this.config.developBranch;
    }

    await this.ui.setPendingConflict(undefined);
    const pushSuffix = pushed ? ' 및 푸시' : ' (로컬 전용)';
    const msg = `'${this.config.developBranch}' → '${this.config.masterBranch}' 운영 반영${pushSuffix} 완료`;
    await this.ui.showInfo(msg);
    return { status: 'success', branch: finalBranch, message: msg };
  }

  /**
   * Conflict Action: Resolve a single unmerged file by choosing ours or theirs and staging it.
   */
  async resolveConflictFile(filePath: string, side: 'ours' | 'theirs'): Promise<WorkflowResult> {
    if (!(await this.git.isMergeInProgress())) {
      const msg = '진행 중인 머지가 없습니다.';
      return { status: 'blocked', message: msg };
    }

    await this.git.resolveConflictFile(filePath, side);
    return {
      status: 'success',
      message: `'${filePath}' 충돌을 해결했습니다.`,
    };
  }

  /**
   * Conflict Action: Complete merge commit and push after user resolves conflicts.
   */
  async continueAfterConflict(): Promise<WorkflowResult> {
    if (!(await this.git.isMergeInProgress())) {
      await this.ui.setPendingConflict(undefined);
      const msg = '진행 중인 머지가 없습니다.';
      await this.ui.showInfo(msg);
      return { status: 'noop', message: msg };
    }

    const conflictedFiles = await this.git.getConflictedFiles();
    if (conflictedFiles.length > 0) {
      const msg = `아직 해결되지 않은 충돌 파일이 ${conflictedFiles.length}개 있습니다. 모든 충돌을 해결하고 저장(Stage)한 뒤 다시 실행해 주세요.`;
      await this.ui.showWarning(msg);
      await this.ui.openConflictedFiles(conflictedFiles);
      return {
        status: 'conflict',
        message: msg,
        conflictedFiles,
      };
    }

    const ctx = await this.ui.getPendingConflict();
    const currentBranch = await this.git.getCurrentBranch();
    const targetBranch = ctx?.targetBranch ?? currentBranch;

    await this.git.commitMerge();
    const pushed = targetBranch ? await this.pushIfRemoteExists(targetBranch) : false;

    if (
      (ctx?.kind === 'mergeToDevelop' || ctx?.kind === 'mergeToMaster') &&
      ctx.remainingTargets &&
      ctx.remainingTargets.length > 0
    ) {
      await this.ui.setPendingConflict(undefined);
      return this.executeTaskMergeTargets({
        taskBranch: ctx.sourceBranch,
        targets: ctx.remainingTargets,
        deleteSourceOnComplete: ctx.deleteSourceOnComplete,
        alreadySynced: false,
        completedTargets: targetBranch ? [targetBranch] : [],
        anyPushedSoFar: pushed,
      });
    }

    let finalBranch = targetBranch ?? undefined;
    if (ctx?.kind === 'mergeToDevelop' || ctx?.kind === 'mergeToMaster') {
      if (ctx.deleteSourceOnComplete) {
        await this.cleanupTaskBranch(ctx.sourceBranch, false);
        if (
          ctx.kind === 'mergeToMaster' &&
          this.config.useDevelopBranch &&
          this.config.returnToDevelopAfterRelease &&
          (await this.git.branchExistsLocal(this.config.developBranch))
        ) {
          await this.git.checkout(this.config.developBranch);
          finalBranch = this.config.developBranch;
        }
      } else {
        await this.restoreBranchIfExists(ctx.returnBranch);
        finalBranch = ctx.returnBranch;
      }
    } else if (ctx?.kind === 'releaseToMaster' && this.config.returnToDevelopAfterRelease) {
      await this.git.checkout(this.config.developBranch);
      finalBranch = this.config.developBranch;
    }

    await this.ui.setPendingConflict(undefined);
    const pushSuffix = pushed ? ' 및 푸시' : '';
    const msg = `충돌 해결 후 '${targetBranch ?? '현재 브랜치'}' 병합 커밋${pushSuffix}를 완료했습니다.`;
    await this.ui.showInfo(msg);
    return { status: 'success', branch: finalBranch, message: msg };
  }

  /**
   * Conflict Action: Abort ongoing merge and restore previous branch.
   */
  async abortMerge(): Promise<WorkflowResult> {
    if (!(await this.git.isMergeInProgress())) {
      await this.ui.setPendingConflict(undefined);
      const msg = '취소할 머지가 없습니다.';
      await this.ui.showInfo(msg);
      return { status: 'noop', message: msg };
    }

    const ctx = await this.ui.getPendingConflict();
    const currentBranch = await this.git.getCurrentBranch();
    const confirmed = await this.ui.confirmAbortMerge(
      ctx?.targetBranch ?? currentBranch ?? '현재 브랜치'
    );

    if (!confirmed) {
      return { status: 'cancelled', message: '머지 취소를 보류했습니다.' };
    }

    return this.executeAbort(ctx);
  }

  /**
   * Bulk Cleanup: Find all non-current, non-protected local branches already merged into develop/master and delete selected ones.
   */
  async cleanupMergedBranches(): Promise<WorkflowResult> {
    const blocked = await this.checkInProgressState();
    if (blocked) {
      return blocked;
    }

    const currentBranch = await this.git.getCurrentBranch();
    const localBranches = await this.git.listLocalBranches();

    const candidateBases = this.config.useDevelopBranch
      ? [this.config.developBranch, this.config.masterBranch]
      : [this.config.masterBranch];

    const existingBases: string[] = [];
    for (const base of candidateBases) {
      if (await this.git.branchExistsLocal(base)) {
        existingBases.push(base);
      }
    }

    if (existingBases.length === 0) {
      const msg = '기준 보호 브랜치를 로컬에서 찾을 수 없어 완료된 브랜치를 판별할 수 없습니다.';
      await this.ui.showInfo(msg);
      return { status: 'noop', message: msg };
    }

    const mergedCandidates: string[] = [];
    for (const branch of localBranches) {
      if (branch === currentBranch || isProtectedBranch(branch, this.config)) {
        continue;
      }
      let isMerged = false;
      for (const base of existingBases) {
        const ahead = await this.git.getAheadCommits(base, branch);
        if (ahead.length === 0) {
          isMerged = true;
          break;
        }
      }
      if (isMerged) {
        mergedCandidates.push(branch);
      }
    }

    if (mergedCandidates.length === 0) {
      const msg = '정리할 완료된 작업 브랜치가 없습니다.';
      await this.ui.showInfo(msg);
      return { status: 'noop', message: msg };
    }

    const selected = await this.ui.promptSelectBranchesToDelete(mergedCandidates);
    if (!selected || selected.length === 0) {
      return { status: 'cancelled', message: '브랜치 정리를 취소했습니다.' };
    }

    const deleted: string[] = [];
    const failed: string[] = [];
    for (const branch of selected) {
      try {
        await this.cleanupTaskBranch(branch, false);
        deleted.push(branch);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failed.push(`${branch} (${detail})`);
      }
    }

    if (failed.length > 0) {
      const msg = `완료된 작업 브랜치 ${deleted.length}개 정리, ${failed.length}개 실패: ${failed.join(', ')}`;
      await this.ui.showWarning(msg);
      return { status: deleted.length > 0 ? 'success' : 'blocked', message: msg };
    }

    const msg = `완료된 작업 브랜치 ${deleted.length}개를 정리했습니다.`;
    await this.ui.showInfo(msg);
    return { status: 'success', message: msg };
  }
}

export async function detectRecommendedConfig(
  git: GitClient,
  remote = DEFAULT_FLOW_CONFIG.remote
): Promise<FlowConfig> {
  const hasRemote = await git.hasRemote(remote);
  const branchExists = async (name: string): Promise<boolean> => {
    if (await git.branchExistsLocal(name)) {
      return true;
    }
    return hasRemote ? git.branchExistsRemote(remote, name) : false;
  };

  const [hasDevelop, hasMaster, hasMain] = await Promise.all([
    branchExists('develop'),
    branchExists('master'),
    branchExists('main'),
  ]);

  const masterBranch = hasMaster ? 'master' : hasMain ? 'main' : 'master';
  return {
    ...DEFAULT_FLOW_CONFIG,
    useDevelopBranch: hasDevelop,
    developBranch: 'develop',
    masterBranch,
    remote,
  };
}
