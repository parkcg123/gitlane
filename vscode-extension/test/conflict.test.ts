import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DEFAULT_FLOW_CONFIG, FlowConfig } from '../src/config';
import {
  buildConflictPanelState,
  formatConflictKindLabel,
  getConflictSideLabels,
} from '../src/conflictModel';
import { GitClient } from '../src/git';
import { PendingConflictContext, WorkflowService, WorkflowUI } from '../src/workflow';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

interface ConflictFixture {
  rootDir: string;
  workDir: string;
  peerDir: string;
}

function createConflictFixture(extraFiles: Record<string, string> = {}): ConflictFixture {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlane-conflict-')));
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

  fs.writeFileSync(path.join(seedDir, 'app.txt'), 'line1\nbase\nline3\n', 'utf8');
  for (const [relPath, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(seedDir, relPath), content, 'utf8');
  }
  runGit(seedDir, ['add', '.']);
  runGit(seedDir, ['commit', '-m', 'chore: initial seed']);
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

  return { rootDir, workDir, peerDir };
}

class MockConflictUI implements WorkflowUI {
  pendingConflict: PendingConflictContext | undefined;
  taskName = 'task_conflict';
  mergeMode: 'delete' | 'keep' | 'cancel' = 'delete';

  async promptTaskName(): Promise<string | undefined> {
    return this.taskName;
  }
  async confirmDirtyStart(): Promise<'stash' | 'cancel'> {
    return 'stash';
  }
  async confirmExistingBranch(): Promise<'checkout' | 'cancel'> {
    return 'checkout';
  }
  async confirmMergeToDevelop(): Promise<'delete' | 'keep' | 'cancel'> {
    return this.mergeMode;
  }
  async confirmReleaseToMaster(): Promise<'release' | 'cancel'> {
    return 'release';
  }
  async confirmAbortMerge(): Promise<boolean> {
    return true;
  }
  async promptConflictAction(): Promise<'open' | 'abort' | 'later'> {
    return 'later';
  }
  showInfo(): void {}
  showWarning(): void {}
  showError(): void {}
  async openConflictedFiles(): Promise<void> {}
  getPendingConflict(): PendingConflictContext | undefined {
    return this.pendingConflict;
  }
  setPendingConflict(context: PendingConflictContext | undefined): void {
    this.pendingConflict = context;
  }
}

const FIXED_NOW = () => new Date(2026, 10, 19, 10, 0, 0);

describe('conflictModel unit tests', () => {
  it('derives explicit branch labels for mergeToDevelop, releaseToMaster, and external merges', () => {
    const devLabels = getConflictSideLabels(
      {
        targetBranch: 'develop',
        sourceBranch: '20261119_login',
        returnBranch: '20261119_login',
        deleteSourceOnComplete: true,
        kind: 'mergeToDevelop',
      },
      'develop'
    );
    assert.equal(devLabels.oursLabel, 'develop 유지 (스테이지)');
    assert.equal(devLabels.theirsLabel, '20261119_login 적용 (내 작업)');

    const masterLabels = getConflictSideLabels(
      {
        targetBranch: 'master',
        sourceBranch: 'develop',
        returnBranch: 'develop',
        deleteSourceOnComplete: false,
        kind: 'releaseToMaster',
      },
      'master'
    );
    assert.equal(masterLabels.oursLabel, 'master 유지 (운영)');
    assert.equal(masterLabels.theirsLabel, 'develop 적용 (스테이지)');

    const externalLabels = getConflictSideLabels(undefined, 'feature_x');
    assert.equal(externalLabels.oursLabel, '현재 브랜치 유지 (Ours)');
    assert.equal(externalLabels.theirsLabel, '병합 브랜치 적용 (Theirs)');
  });

  it('tracks unresolved, partially resolved, and completable panel states', () => {
    const context: PendingConflictContext = {
      targetBranch: 'develop',
      sourceBranch: '20261119_pay',
      returnBranch: '20261119_pay',
      deleteSourceOnComplete: true,
      kind: 'mergeToDevelop',
      initialConflictedFiles: ['a.ts', 'b.ts'],
    };

    const initial = buildConflictPanelState({
      merging: true,
      currentBranch: 'develop',
      context,
      unmergedEntries: [
        { path: 'b.ts', xy: 'DU' },
        { path: 'a.ts', xy: 'UU' },
      ],
    });
    assert.equal(initial.unresolvedCount, 2);
    assert.equal(initial.resolvedCount, 0);
    assert.equal(initial.canComplete, false);
    assert.deepEqual(
      initial.files.map((f) => `${f.path}:${f.status}:${f.conflictKind}`),
      ['a.ts:unresolved:UU', 'b.ts:unresolved:DU']
    );
    assert.equal(formatConflictKindLabel('DU'), '대상 삭제 / 병합 수정');

    const partial = buildConflictPanelState({
      merging: true,
      currentBranch: 'develop',
      context,
      unmergedEntries: [{ path: 'b.ts', xy: 'DU' }],
    });
    assert.equal(partial.unresolvedCount, 1);
    assert.equal(partial.resolvedCount, 1);
    assert.equal(partial.canComplete, false);
    assert.deepEqual(
      partial.files.map((f) => `${f.path}:${f.status}`),
      ['b.ts:unresolved', 'a.ts:resolved']
    );

    const allResolved = buildConflictPanelState({
      merging: true,
      currentBranch: 'develop',
      context,
      unmergedEntries: [],
    });
    assert.equal(allResolved.unresolvedCount, 0);
    assert.equal(allResolved.resolvedCount, 2);
    assert.equal(allResolved.canComplete, true);
  });
});

describe('conflict resolution end-to-end git integration', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(extraFiles: Record<string, string> = {}) {
    const fixture = createConflictFixture(extraFiles);
    tempRoots.push(fixture.rootDir);
    const git = new GitClient(fixture.workDir);
    const ui = new MockConflictUI();
    const config: FlowConfig = { ...DEFAULT_FLOW_CONFIG };
    const service = new WorkflowService(git, ui, config, FIXED_NOW);
    return { fixture, git, ui, service };
  }

  it('resolves UU content conflict with theirs (task branch) and ours (develop)', async () => {
    // 1) Resolve with theirs (keep task branch code)
    {
      const { fixture, git, ui, service } = setup();
      ui.taskName = 'uu_theirs';
      await service.startTask();

      fs.writeFileSync(path.join(fixture.peerDir, 'app.txt'), 'line1\nstage_val\nline3\n', 'utf8');
      runGit(fixture.peerDir, ['add', 'app.txt']);
      runGit(fixture.peerDir, ['commit', '-m', 'fix: stage']);
      runGit(fixture.peerDir, ['push', 'origin', 'develop']);

      fs.writeFileSync(path.join(fixture.workDir, 'app.txt'), 'line1\ntask_val\nline3\n', 'utf8');
      runGit(fixture.workDir, ['add', 'app.txt']);
      runGit(fixture.workDir, ['commit', '-m', 'fix: task']);

      const res = await service.mergeToDevelop();
      assert.equal(res.status, 'conflict');

      const resolveRes = await service.resolveConflictFile('app.txt', 'theirs');
      assert.equal(resolveRes.status, 'success');
      assert.equal((await git.getUnmergedEntries()).length, 0);
      assert.equal(
        fs.readFileSync(path.join(fixture.workDir, 'app.txt'), 'utf8'),
        'line1\ntask_val\nline3\n'
      );

      const done = await service.continueAfterConflict();
      assert.equal(done.status, 'success');
      runGit(fixture.peerDir, ['fetch', 'origin']);
      runGit(fixture.peerDir, ['reset', '--hard', 'origin/develop']);
      assert.equal(
        fs.readFileSync(path.join(fixture.peerDir, 'app.txt'), 'utf8'),
        'line1\ntask_val\nline3\n'
      );
    }

    // 2) Resolve with ours (keep develop branch code)
    {
      const { fixture, git, ui, service } = setup();
      ui.taskName = 'uu_ours';
      await service.startTask();

      fs.writeFileSync(path.join(fixture.peerDir, 'app.txt'), 'line1\nstage_val\nline3\n', 'utf8');
      runGit(fixture.peerDir, ['add', 'app.txt']);
      runGit(fixture.peerDir, ['commit', '-m', 'fix: stage']);
      runGit(fixture.peerDir, ['push', 'origin', 'develop']);

      fs.writeFileSync(path.join(fixture.workDir, 'app.txt'), 'line1\ntask_val\nline3\n', 'utf8');
      runGit(fixture.workDir, ['add', 'app.txt']);
      runGit(fixture.workDir, ['commit', '-m', 'fix: task']);

      const res = await service.mergeToDevelop();
      assert.equal(res.status, 'conflict');

      await service.resolveConflictFile('app.txt', 'ours');
      assert.equal((await git.getUnmergedEntries()).length, 0);
      assert.equal(
        fs.readFileSync(path.join(fixture.workDir, 'app.txt'), 'utf8'),
        'line1\nstage_val\nline3\n'
      );

      const done = await service.continueAfterConflict();
      assert.equal(done.status, 'success');
    }
  });

  it('resolves DU delete/modify conflict cleanly for both ours (rm) and theirs (keep)', async () => {
    // 1) Resolve DU with ours -> removes file via git rm -f
    {
      const { fixture, git, ui, service } = setup({ 'delete_me.txt': 'original\n' });
      ui.taskName = 'du_ours';
      await service.startTask();

      runGit(fixture.peerDir, ['rm', 'delete_me.txt']);
      runGit(fixture.peerDir, ['commit', '-m', 'chore: remove delete_me']);
      runGit(fixture.peerDir, ['push', 'origin', 'develop']);

      fs.writeFileSync(path.join(fixture.workDir, 'delete_me.txt'), 'modified in task\n', 'utf8');
      runGit(fixture.workDir, ['add', 'delete_me.txt']);
      runGit(fixture.workDir, ['commit', '-m', 'fix: modify delete_me']);

      const res = await service.mergeToDevelop();
      assert.equal(res.status, 'conflict');
      const unmerged = await git.getUnmergedEntries();
      assert.deepEqual(unmerged, [{ path: 'delete_me.txt', xy: 'DU' }]);

      await service.resolveConflictFile('delete_me.txt', 'ours');
      assert.equal(fs.existsSync(path.join(fixture.workDir, 'delete_me.txt')), false);
      assert.equal((await git.getUnmergedEntries()).length, 0);

      const done = await service.continueAfterConflict();
      assert.equal(done.status, 'success');
    }

    // 2) Resolve DU with theirs -> keeps task branch modified file
    {
      const { fixture, git, ui, service } = setup({ 'delete_me.txt': 'original\n' });
      ui.taskName = 'du_theirs';
      await service.startTask();

      runGit(fixture.peerDir, ['rm', 'delete_me.txt']);
      runGit(fixture.peerDir, ['commit', '-m', 'chore: remove delete_me']);
      runGit(fixture.peerDir, ['push', 'origin', 'develop']);

      fs.writeFileSync(path.join(fixture.workDir, 'delete_me.txt'), 'modified in task\n', 'utf8');
      runGit(fixture.workDir, ['add', 'delete_me.txt']);
      runGit(fixture.workDir, ['commit', '-m', 'fix: modify delete_me']);

      const res = await service.mergeToDevelop();
      assert.equal(res.status, 'conflict');

      await service.resolveConflictFile('delete_me.txt', 'theirs');
      assert.equal((await git.getUnmergedEntries()).length, 0);
      assert.equal(
        fs.readFileSync(path.join(fixture.workDir, 'delete_me.txt'), 'utf8'),
        'modified in task\n'
      );

      const done = await service.continueAfterConflict();
      assert.equal(done.status, 'success');
    }
  });

  it('handles UTF-8 Korean filenames without octal quoting during conflict detection and resolution', async () => {
    const koreanFile = '한글_테스트.txt';
    const { fixture, git, ui, service } = setup({ [koreanFile]: '초기\n' });
    ui.taskName = 'korean_conflict';
    await service.startTask();

    fs.writeFileSync(path.join(fixture.peerDir, koreanFile), '스테이지_변경\n', 'utf8');
    runGit(fixture.peerDir, ['add', koreanFile]);
    runGit(fixture.peerDir, ['commit', '-m', 'fix: peer korean']);
    runGit(fixture.peerDir, ['push', 'origin', 'develop']);

    fs.writeFileSync(path.join(fixture.workDir, koreanFile), '내작업_변경\n', 'utf8');
    runGit(fixture.workDir, ['add', koreanFile]);
    runGit(fixture.workDir, ['commit', '-m', 'fix: my korean']);

    const res = await service.mergeToDevelop();
    assert.equal(res.status, 'conflict');
    assert.deepEqual(res.conflictedFiles, [koreanFile]);

    const entries = await git.getUnmergedEntries();
    assert.deepEqual(entries, [{ path: koreanFile, xy: 'UU' }]);

    await service.resolveConflictFile(koreanFile, 'theirs');
    assert.equal((await git.getUnmergedEntries()).length, 0);
    assert.equal(fs.readFileSync(path.join(fixture.workDir, koreanFile), 'utf8'), '내작업_변경\n');

    const done = await service.continueAfterConflict();
    assert.equal(done.status, 'success');
  });
});
