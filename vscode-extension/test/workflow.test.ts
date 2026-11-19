import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DEFAULT_FLOW_CONFIG, FlowConfig } from '../src/config';
import { GitClient } from '../src/git';
import { PendingConflictContext, WorkflowService, WorkflowUI } from '../src/workflow';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

interface TestRepoPair {
  rootDir: string;
  bareDir: string;
  workDir: string;
  peerDir: string;
}

function createRepoFixture(): TestRepoPair {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlane-e2e-')));
  const bareDir = path.join(rootDir, 'origin.git');
  const seedDir = path.join(rootDir, 'seed');
  const workDir = path.join(rootDir, 'work');
  const peerDir = path.join(rootDir, 'peer');

  fs.mkdirSync(bareDir);
  runGit(bareDir, ['init', '--bare']);
  runGit(bareDir, ['symbolic-ref', 'HEAD', 'refs/heads/master']);

  runGit(rootDir, ['clone', bareDir, seedDir]);
  runGit(seedDir, ['config', 'user.name', 'Seed Bot']);
  runGit(seedDir, ['config', 'user.email', 'seed@example.com']);
  runGit(seedDir, ['checkout', '-b', 'master']);

  fs.writeFileSync(path.join(seedDir, 'app.txt'), 'line1\nline2\nline3\n', 'utf8');
  runGit(seedDir, ['add', 'app.txt']);
  runGit(seedDir, ['commit', '-m', 'chore: initial commit']);
  runGit(seedDir, ['push', '-u', 'origin', 'master']);

  runGit(seedDir, ['checkout', '-b', 'develop']);
  runGit(seedDir, ['push', '-u', 'origin', 'develop']);

  runGit(rootDir, ['clone', bareDir, workDir]);
  runGit(workDir, ['config', 'user.name', 'Dev User']);
  runGit(workDir, ['config', 'user.email', 'dev@example.com']);
  runGit(workDir, ['checkout', 'develop']);

  runGit(rootDir, ['clone', bareDir, peerDir]);
  runGit(peerDir, ['config', 'user.name', 'Peer User']);
  runGit(peerDir, ['config', 'user.email', 'peer@example.com']);
  runGit(peerDir, ['checkout', 'develop']);

  return { rootDir, bareDir, workDir, peerDir };
}

class MockWorkflowUI implements WorkflowUI {
  pendingConflict: PendingConflictContext | undefined;
  infos: string[] = [];
  warnings: string[] = [];
  errors: string[] = [];
  openedFiles: string[] = [];

  onPromptTaskName: (datePrefix: string) => string | undefined = () => 'login_fix';
  onConfirmDirtyStart: () => 'stash' | 'cancel' = () => 'stash';
  onConfirmExistingBranch: () => 'checkout' | 'cancel' = () => 'checkout';
  onConfirmMergeToDevelop: () => 'delete' | 'keep' | 'cancel' = () => 'delete';
  onConfirmReleaseToMaster: () => 'release' | 'cancel' = () => 'release';
  onConfirmAbortMerge: () => boolean = () => true;
  onPromptConflictAction: () => 'open' | 'abort' | 'later' = () => 'open';

  async promptTaskName(datePrefix: string): Promise<string | undefined> {
    return this.onPromptTaskName(datePrefix);
  }

  async confirmDirtyStart(): Promise<'stash' | 'cancel'> {
    return this.onConfirmDirtyStart();
  }

  async confirmExistingBranch(): Promise<'checkout' | 'cancel'> {
    return this.onConfirmExistingBranch();
  }

  async confirmMergeToDevelop(): Promise<'delete' | 'keep' | 'cancel'> {
    return this.onConfirmMergeToDevelop();
  }

  async confirmReleaseToMaster(): Promise<'release' | 'cancel'> {
    return this.onConfirmReleaseToMaster();
  }

  async confirmAbortMerge(): Promise<boolean> {
    return this.onConfirmAbortMerge();
  }

  async promptConflictAction(): Promise<'open' | 'abort' | 'later'> {
    return this.onPromptConflictAction();
  }

  showInfo(message: string): void {
    this.infos.push(message);
  }

  showWarning(message: string): void {
    this.warnings.push(message);
  }

  showError(message: string): void {
    this.errors.push(message);
  }

  async openConflictedFiles(files: string[]): Promise<void> {
    this.openedFiles.push(...files);
  }

  getPendingConflict(): PendingConflictContext | undefined {
    return this.pendingConflict;
  }

  setPendingConflict(context: PendingConflictContext | undefined): void {
    this.pendingConflict = context;
  }
}

const FIXED_NOW = () => new Date(2026, 10, 19, 9, 30, 0);

describe('WorkflowService end-to-end git integration', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(configOverrides: Partial<FlowConfig> = {}) {
    const fixture = createRepoFixture();
    tempRoots.push(fixture.rootDir);
    const git = new GitClient(fixture.workDir);
    const ui = new MockWorkflowUI();
    const config: FlowConfig = { ...DEFAULT_FLOW_CONFIG, ...configOverrides };
    const service = new WorkflowService(git, ui, config, FIXED_NOW);
    return { fixture, git, ui, service, config };
  }

  it('startTask syncs remote develop and creates YYYYMMDD_작업명 branch', async () => {
    const { fixture, git, ui, service } = setup();

    // Peer pushes a new commit to origin/develop before startTask runs.
    fs.writeFileSync(path.join(fixture.peerDir, 'peer.txt'), 'remote update\n', 'utf8');
    runGit(fixture.peerDir, ['add', 'peer.txt']);
    runGit(fixture.peerDir, ['commit', '-m', 'feat: peer update on develop']);
    runGit(fixture.peerDir, ['push', 'origin', 'develop']);

    ui.onPromptTaskName = () => 'login fix';
    const res = await service.startTask();

    assert.equal(res.status, 'success');
    assert.equal(res.branch, '20261119_login_fix');
    assert.equal(await git.getCurrentBranch(), '20261119_login_fix');
    assert.equal(fs.existsSync(path.join(fixture.workDir, 'peer.txt')), true);
  });

  it('startTask handles dirty working tree stash vs cancel', async () => {
    const { fixture, git, ui, service } = setup();
    fs.writeFileSync(path.join(fixture.workDir, 'wip.txt'), 'dirty\n', 'utf8');

    ui.onConfirmDirtyStart = () => 'cancel';
    const cancelled = await service.startTask();
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(await git.hasUncommittedChanges(), true);

    ui.onConfirmDirtyStart = () => 'stash';
    ui.onPromptTaskName = () => 'stashed_work';
    const started = await service.startTask();
    assert.equal(started.status, 'success');
    assert.equal(await git.getCurrentBranch(), '20261119_stashed_work');
    assert.equal(await git.hasUncommittedChanges(), false);
    assert.ok(runGit(fixture.workDir, ['stash', 'list']).includes('auto-stash'));
  });

  it('mergeToDevelop (delete mode) merges with --no-ff, pushes origin/develop, and deletes task branch', async () => {
    const { fixture, git, ui, service } = setup();
    ui.onPromptTaskName = () => 'feat_delete';
    await service.startTask();

    fs.writeFileSync(path.join(fixture.workDir, 'feature.txt'), 'done\n', 'utf8');
    runGit(fixture.workDir, ['add', 'feature.txt']);
    runGit(fixture.workDir, ['commit', '-m', 'feat: implement feature']);

    ui.onConfirmMergeToDevelop = () => 'delete';
    const res = await service.mergeToDevelop();

    assert.equal(res.status, 'success');
    assert.equal(await git.getCurrentBranch(), 'develop');
    assert.equal(await git.branchExistsLocal('20261119_feat_delete'), false);

    // Verify remote develop has the merge commit (--no-ff)
    runGit(fixture.peerDir, ['fetch', 'origin']);
    const remoteLog = runGit(fixture.peerDir, ['log', '--oneline', '-n', '3', 'origin/develop']);
    assert.ok(remoteLog.includes("Merge branch '20261119_feat_delete'"));
  });

  it('mergeToDevelop (keep mode) merges, pushes origin/develop, and returns to task branch', async () => {
    const { fixture, git, ui, service } = setup();
    ui.onPromptTaskName = () => 'feat_keep';
    await service.startTask();

    fs.writeFileSync(path.join(fixture.workDir, 'stage.txt'), 'v1\n', 'utf8');
    runGit(fixture.workDir, ['add', 'stage.txt']);
    runGit(fixture.workDir, ['commit', '-m', 'feat: stage v1']);

    ui.onConfirmMergeToDevelop = () => 'keep';
    const res = await service.mergeToDevelop();

    assert.equal(res.status, 'success');
    assert.equal(await git.getCurrentBranch(), '20261119_feat_keep');
    assert.equal(await git.branchExistsLocal('20261119_feat_keep'), true);
    runGit(fixture.peerDir, ['fetch', 'origin']);
    assert.ok(
      runGit(fixture.peerDir, ['log', '--oneline', 'origin/develop']).includes('feat: stage v1')
    );
  });

  it('mergeToDevelop blocks protected branches and dirty working trees', async () => {
    const { fixture, ui, service } = setup();

    // Currently on develop
    const onDevelop = await service.mergeToDevelop();
    assert.equal(onDevelop.status, 'blocked');

    // On master
    runGit(fixture.workDir, ['checkout', 'master']);
    const onMaster = await service.mergeToDevelop();
    assert.equal(onMaster.status, 'blocked');

    // On task branch with uncommitted change
    ui.onPromptTaskName = () => 'dirty_guard';
    await service.startTask();
    fs.writeFileSync(path.join(fixture.workDir, 'dirty.txt'), 'uncommitted\n', 'utf8');
    const onDirty = await service.mergeToDevelop();
    assert.equal(onDirty.status, 'blocked');
  });

  it('releaseToMaster merges develop into master, pushes origin/master, and returns to develop', async () => {
    const { fixture, git, ui, service } = setup();
    ui.onPromptTaskName = () => 'release_item';
    await service.startTask();

    fs.writeFileSync(path.join(fixture.workDir, 'release.txt'), 'ready\n', 'utf8');
    runGit(fixture.workDir, ['add', 'release.txt']);
    runGit(fixture.workDir, ['commit', '-m', 'feat: ready for production']);

    ui.onConfirmMergeToDevelop = () => 'delete';
    await service.mergeToDevelop();

    ui.onConfirmReleaseToMaster = () => 'release';
    const res = await service.releaseToMaster();

    assert.equal(res.status, 'success');
    assert.equal(await git.getCurrentBranch(), 'develop');

    runGit(fixture.peerDir, ['fetch', 'origin']);
    const masterLog = runGit(fixture.peerDir, ['log', '--oneline', 'origin/master']);
    assert.ok(masterLog.includes("Merge branch 'develop'"));
    assert.ok(masterLog.includes('feat: ready for production'));
  });

  it('conflict flow (abort) stops cleanly and restores original task branch', async () => {
    const { fixture, git, ui, service } = setup();
    ui.onPromptTaskName = () => 'conflict_abort';
    await service.startTask();

    // Peer modifies app.txt line2 on develop and pushes
    fs.writeFileSync(path.join(fixture.peerDir, 'app.txt'), 'line1\npeer_change\nline3\n', 'utf8');
    runGit(fixture.peerDir, ['add', 'app.txt']);
    runGit(fixture.peerDir, ['commit', '-m', 'fix: peer line2']);
    runGit(fixture.peerDir, ['push', 'origin', 'develop']);

    // Local task branch modifies the same line2
    fs.writeFileSync(path.join(fixture.workDir, 'app.txt'), 'line1\nmy_change\nline3\n', 'utf8');
    runGit(fixture.workDir, ['add', 'app.txt']);
    runGit(fixture.workDir, ['commit', '-m', 'fix: my line2']);

    ui.onConfirmMergeToDevelop = () => 'delete';
    ui.onPromptConflictAction = () => 'open';
    const mergeRes = await service.mergeToDevelop();

    assert.equal(mergeRes.status, 'conflict');
    assert.deepEqual(mergeRes.conflictedFiles, ['app.txt']);
    assert.deepEqual(ui.openedFiles, ['app.txt']);
    assert.equal(await git.isMergeInProgress(), true);
    assert.ok(ui.pendingConflict);

    ui.onConfirmAbortMerge = () => true;
    const abortRes = await service.abortMerge();
    assert.equal(abortRes.status, 'success');
    assert.equal(await git.isMergeInProgress(), false);
    assert.equal(await git.hasUncommittedChanges(), false);
    assert.equal(await git.getCurrentBranch(), '20261119_conflict_abort');
    assert.equal(ui.pendingConflict, undefined);
  });

  it('conflict flow (resolve & continue) commits, pushes origin/develop, and deletes task branch', async () => {
    const { fixture, git, ui, service } = setup();
    ui.onPromptTaskName = () => 'conflict_resolve';
    await service.startTask();

    fs.writeFileSync(path.join(fixture.peerDir, 'app.txt'), 'line1\npeer_change\nline3\n', 'utf8');
    runGit(fixture.peerDir, ['add', 'app.txt']);
    runGit(fixture.peerDir, ['commit', '-m', 'fix: peer line2']);
    runGit(fixture.peerDir, ['push', 'origin', 'develop']);

    fs.writeFileSync(path.join(fixture.workDir, 'app.txt'), 'line1\nmy_change\nline3\n', 'utf8');
    runGit(fixture.workDir, ['add', 'app.txt']);
    runGit(fixture.workDir, ['commit', '-m', 'fix: my line2']);

    ui.onConfirmMergeToDevelop = () => 'delete';
    ui.onPromptConflictAction = () => 'open';
    const mergeRes = await service.mergeToDevelop();
    assert.equal(mergeRes.status, 'conflict');

    // Calling continue before resolving stays in conflict state
    const stillConflicted = await service.continueAfterConflict();
    assert.equal(stillConflicted.status, 'conflict');

    // User resolves conflict and stages file
    fs.writeFileSync(
      path.join(fixture.workDir, 'app.txt'),
      'line1\npeer_and_my_change\nline3\n',
      'utf8'
    );
    runGit(fixture.workDir, ['add', 'app.txt']);

    const continued = await service.continueAfterConflict();
    assert.equal(continued.status, 'success');
    assert.equal(await git.isMergeInProgress(), false);
    assert.equal(await git.getCurrentBranch(), 'develop');
    assert.equal(await git.branchExistsLocal('20261119_conflict_resolve'), false);
    assert.equal(ui.pendingConflict, undefined);

    runGit(fixture.peerDir, ['fetch', 'origin']);
    runGit(fixture.peerDir, ['reset', '--hard', 'origin/develop']);
    assert.equal(
      fs.readFileSync(path.join(fixture.peerDir, 'app.txt'), 'utf8'),
      'line1\npeer_and_my_change\nline3\n'
    );
  });

  it('supports direct-to-master workflow without develop when useDevelopBranch is false', async () => {
    const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlane-direct-e2e-')));
    try {
      const bareDir = path.join(rootDir, 'origin.git');
      const seedDir = path.join(rootDir, 'seed');
      const workDir = path.join(rootDir, 'work');
      const peerDir = path.join(rootDir, 'peer');

      fs.mkdirSync(bareDir);
      runGit(bareDir, ['init', '--bare']);
      runGit(bareDir, ['symbolic-ref', 'HEAD', 'refs/heads/master']);

      runGit(rootDir, ['clone', bareDir, seedDir]);
      runGit(seedDir, ['config', 'user.name', 'Seed Bot']);
      runGit(seedDir, ['config', 'user.email', 'seed@example.com']);
      runGit(seedDir, ['checkout', '-b', 'master']);
      fs.writeFileSync(path.join(seedDir, 'app.txt'), 'base\n', 'utf8');
      runGit(seedDir, ['add', 'app.txt']);
      runGit(seedDir, ['commit', '-m', 'chore: init master']);
      runGit(seedDir, ['push', '-u', 'origin', 'master']);

      runGit(rootDir, ['clone', bareDir, workDir]);
      runGit(workDir, ['config', 'user.name', 'Dev User']);
      runGit(workDir, ['config', 'user.email', 'dev@example.com']);

      runGit(rootDir, ['clone', bareDir, peerDir]);
      runGit(peerDir, ['config', 'user.name', 'Peer User']);
      runGit(peerDir, ['config', 'user.email', 'peer@example.com']);

      const git = new GitClient(workDir);
      const ui = new MockWorkflowUI();
      const service = new WorkflowService(
        git,
        ui,
        { ...DEFAULT_FLOW_CONFIG, useDevelopBranch: false },
        FIXED_NOW
      );

      // releaseToMaster is blocked in direct mode
      const blockedRelease = await service.releaseToMaster();
      assert.equal(blockedRelease.status, 'blocked');

      // startTask forks from master
      ui.onPromptTaskName = () => 'direct_hotfix';
      const started = await service.startTask();
      assert.equal(started.status, 'success');
      assert.equal(started.branch, '20261119_direct_hotfix');
      assert.equal(await git.getCurrentBranch(), '20261119_direct_hotfix');

      // Delete mode merges straight into master and pushes origin/master
      fs.writeFileSync(path.join(workDir, 'hotfix.txt'), 'fixed\n', 'utf8');
      runGit(workDir, ['add', 'hotfix.txt']);
      runGit(workDir, ['commit', '-m', 'fix: direct hotfix']);

      ui.onConfirmMergeToDevelop = () => 'delete';
      const mergedDelete = await service.mergeToDevelop();
      assert.equal(mergedDelete.status, 'success');
      assert.equal(mergedDelete.branch, 'master');
      assert.equal(await git.getCurrentBranch(), 'master');
      assert.equal(await git.branchExistsLocal('20261119_direct_hotfix'), false);
      assert.equal(
        runGit(workDir, ['rev-parse', 'master']),
        runGit(workDir, ['rev-parse', 'origin/master'])
      );

      // Keep mode merges into master and returns to task branch
      ui.onPromptTaskName = () => 'direct_keep';
      await service.startTask();
      fs.writeFileSync(path.join(workDir, 'keep.txt'), 'keep\n', 'utf8');
      runGit(workDir, ['add', 'keep.txt']);
      runGit(workDir, ['commit', '-m', 'feat: keep branch']);

      ui.onConfirmMergeToDevelop = () => 'keep';
      const mergedKeep = await service.mergeToDevelop();
      assert.equal(mergedKeep.status, 'success');
      assert.equal(mergedKeep.branch, '20261119_direct_keep');
      assert.equal(await git.getCurrentBranch(), '20261119_direct_keep');
      assert.equal(await git.branchExistsLocal('20261119_direct_keep'), true);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
