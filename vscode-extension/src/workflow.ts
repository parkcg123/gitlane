import type { FlowConfig } from './config';
import { GitClient } from './git';
import { buildTaskBranchName, formatLocalDate, isProtectedBranch, validateTaskName } from './naming';

export interface PendingConflictContext {
  targetBranch: string;
  sourceBranch: string;
  returnBranch: string;
  deleteSourceOnComplete: boolean;
  kind: 'mergeToDevelop' | 'releaseToMaster';
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
  confirmExistingBranch(branchName: string): Promise<'checkout' | 'cancel'>;
  confirmMergeToDevelop(
    taskBranch: string,
    developBranch: string,
    commitCount: number
  ): Promise<'delete' | 'keep' | 'cancel'>;
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
      await this.git.pullFastForwardOnly(this.config.remote, branch);
    }
  }

  private async pushIfRemoteExists(branch: string): Promise<boolean> {
    if (await this.git.hasRemote(this.config.remote)) {
      await this.git.push(this.config.remote, branch);
      return true;
    }
    return false;
  }

  private async cleanupTaskBranch(taskBranch: string): Promise<void> {
    await this.git.deleteLocalBranch(taskBranch);
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
   * Action 1: Sync develop and create `YYYYMMDD_<task>` branch.
   */
  async startTask(): Promise<WorkflowResult> {
    const blocked = await this.checkInProgressState();
    if (blocked) {
      return blocked;
    }

    if (await this.git.hasUncommittedChanges()) {
      const dirtyChoice = await this.ui.confirmDirtyStart();
      if (dirtyChoice === 'cancel') {
        return { status: 'cancelled', message: '작업 시작을 취소했습니다.' };
      }
      await this.git.stashPush('gitlane: auto-stash before startTask');
    }

    const originalBranch = await this.git.getCurrentBranch();
    await this.syncBranch(this.config.developBranch);

    const now = this.nowProvider();
    const datePrefix = `${formatLocalDate(now)}${this.config.separator || '_'}`;
    const rawName = await this.ui.promptTaskName(datePrefix);

    if (rawName === undefined) {
      if (originalBranch && originalBranch !== this.config.developBranch) {
        await this.restoreBranchIfExists(originalBranch);
      }
      return { status: 'cancelled', message: '작업 시작을 취소했습니다.' };
    }

    const validationError = validateTaskName(rawName, this.config.separator);
    if (validationError) {
      if (originalBranch && originalBranch !== this.config.developBranch) {
        await this.restoreBranchIfExists(originalBranch);
      }
      await this.ui.showError(validationError);
      return { status: 'blocked', message: validationError };
    }

    const taskBranch = buildTaskBranchName(rawName, this.config, now);

    if (await this.git.branchExistsLocal(taskBranch)) {
      const existingChoice = await this.ui.confirmExistingBranch(taskBranch);
      if (existingChoice === 'cancel') {
        if (originalBranch && originalBranch !== this.config.developBranch) {
          await this.restoreBranchIfExists(originalBranch);
        }
        return { status: 'cancelled', message: '작업 시작을 취소했습니다.' };
      }
      await this.git.checkout(taskBranch);
      const msg = `기존 작업 브랜치 '${taskBranch}'로 이동했습니다.`;
      await this.ui.showInfo(msg);
      return { status: 'success', branch: taskBranch, message: msg };
    }

    await this.git.checkoutNewBranch(taskBranch);
    const msg = `새 작업 브랜치 '${taskBranch}'를 '${this.config.developBranch}'에서 생성했습니다.`;
    await this.ui.showInfo(msg);
    return { status: 'success', branch: taskBranch, message: msg };
  }

  /**
   * Action 2: Merge current task branch into develop and push.
   */
  async mergeToDevelop(): Promise<WorkflowResult> {
    const blocked = await this.checkInProgressState();
    if (blocked) {
      return blocked;
    }

    const taskBranch = await this.git.getCurrentBranch();
    if (!taskBranch) {
      const msg = 'Detached HEAD 상태에서는 스테이지 반영을 진행할 수 없습니다.';
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }

    if (isProtectedBranch(taskBranch, this.config)) {
      const msg = `보호 브랜치('${taskBranch}')에서는 스테이지 반영을 실행할 수 없습니다. 작업 브랜치로 이동해 주세요.`;
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }

    if (await this.git.hasUncommittedChanges()) {
      const msg = '커밋되지 않은 변경사항이 있습니다. 먼저 커밋하거나 Stash한 뒤 다시 시도해 주세요.';
      await this.ui.showWarning(msg);
      return { status: 'blocked', message: msg };
    }

    await this.syncBranch(this.config.developBranch);
    const aheadCommits = await this.git.getAheadCommits(this.config.developBranch, taskBranch);

    if (aheadCommits.length === 0) {
      await this.git.checkout(taskBranch);
      const msg = `${this.config.developBranch}에 병합할 새 커밋이 없습니다.`;
      await this.ui.showInfo(msg);
      return { status: 'noop', branch: taskBranch, message: msg };
    }

    const choice = await this.ui.confirmMergeToDevelop(
      taskBranch,
      this.config.developBranch,
      aheadCommits.length
    );

    if (choice === 'cancel') {
      await this.git.checkout(taskBranch);
      return { status: 'cancelled', branch: taskBranch, message: '스테이지 반영을 취소했습니다.' };
    }

    const mergeResult = await this.git.merge(taskBranch, this.config.useNoFastForwardMerge);
    if (mergeResult.conflicted) {
      return this.handleMergeConflict(
        {
          targetBranch: this.config.developBranch,
          sourceBranch: taskBranch,
          returnBranch: taskBranch,
          deleteSourceOnComplete: choice === 'delete',
          kind: 'mergeToDevelop',
          initialConflictedFiles: mergeResult.conflictedFiles,
        },
        mergeResult.conflictedFiles
      );
    }

    const pushed = await this.pushIfRemoteExists(this.config.developBranch);

    if (choice === 'delete') {
      await this.cleanupTaskBranch(taskBranch);
    } else {
      await this.git.checkout(taskBranch);
    }

    await this.ui.setPendingConflict(undefined);
    const pushSuffix = pushed ? ' 및 푸시' : ' (로컬 전용)';
    const branchSuffix = choice === 'delete' ? `, '${taskBranch}' 삭제` : `, '${taskBranch}' 유지`;
    const msg = `'${taskBranch}' → '${this.config.developBranch}' 병합${pushSuffix} 완료${branchSuffix}`;
    await this.ui.showInfo(msg);
    return {
      status: 'success',
      branch: choice === 'delete' ? this.config.developBranch : taskBranch,
      message: msg,
    };
  }

  /**
   * Action 3: Merge verified develop branch into master and push.
   */
  async releaseToMaster(): Promise<WorkflowResult> {
    const blocked = await this.checkInProgressState();
    if (blocked) {
      return blocked;
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

    let finalBranch = targetBranch ?? undefined;
    if (ctx?.kind === 'mergeToDevelop') {
      if (ctx.deleteSourceOnComplete) {
        await this.cleanupTaskBranch(ctx.sourceBranch);
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
}
