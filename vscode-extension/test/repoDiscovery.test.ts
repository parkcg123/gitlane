import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  buildRepoLabels,
  findContainingRepo,
  findGitRootForPath,
  scanNestedGitRepos,
} from '../src/repoDiscovery';

function initGitDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], {
    cwd: dir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

describe('repoDiscovery unit tests', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  it('scans sibling git repos and worktree .git pointer files while ignoring build/deps dirs', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlane-discovery-')));
    tempRoots.push(root);

    // Non-git parent folder containing multiple child repos + ignored dirs
    const frontend = path.join(root, 'frontend');
    const backend = path.join(root, 'backend');
    const worktreeChild = path.join(root, 'services', 'worker');
    const ignoredNodeModules = path.join(root, 'node_modules', 'pkg');
    const ignoredBuild = path.join(root, 'build', 'temp_repo');

    initGitDir(frontend);
    initGitDir(backend);
    fs.mkdirSync(worktreeChild, { recursive: true });
    fs.writeFileSync(path.join(worktreeChild, '.git'), 'gitdir: ../.git/worktrees/worker\n', 'utf8');
    initGitDir(ignoredNodeModules);
    initGitDir(ignoredBuild);

    const discovered = scanNestedGitRepos(root, 2);
    assert.deepEqual(discovered.sort(), [backend, frontend, worktreeChild].sort());

    const emptyRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlane-empty-')));
    tempRoots.push(emptyRoot);
    assert.deepEqual(scanNestedGitRepos(emptyRoot, 2), []);
  });

  it('deduplicates, disambiguates duplicate folder names, and matches deepest nested repo', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlane-labels-')));
    tempRoots.push(root);

    const appWeb = path.join(root, 'apps', 'web');
    const pkgWeb = path.join(root, 'packages', 'web');
    const parentRepo = path.join(root, 'mono');
    const submoduleRepo = path.join(parentRepo, 'libs', 'core');

    initGitDir(appWeb);
    initGitDir(pkgWeb);
    initGitDir(parentRepo);
    initGitDir(submoduleRepo);

    const labeled = buildRepoLabels([appWeb, pkgWeb, appWeb, parentRepo, submoduleRepo], [root]);
    const labelMap = new Map(labeled.map((item) => [item.root, item.label]));

    assert.equal(labeled.length, 4);
    assert.equal(labelMap.get(appWeb), 'apps/web');
    assert.equal(labelMap.get(pkgWeb), 'packages/web');
    assert.equal(labelMap.get(parentRepo), 'mono');
    assert.equal(labelMap.get(submoduleRepo), 'core');

    // Deep file inside submodule resolves to submoduleRepo rather than parentRepo
    const subFile = path.join(submoduleRepo, 'src', 'index.ts');
    fs.mkdirSync(path.dirname(subFile), { recursive: true });
    fs.writeFileSync(subFile, '// hi\n', 'utf8');

    const parentFile = path.join(parentRepo, 'README.md');
    fs.writeFileSync(parentFile, '# mono\n', 'utf8');

    assert.equal(findContainingRepo(subFile, labeled)?.root, submoduleRepo);
    assert.equal(findContainingRepo(parentFile, labeled)?.root, parentRepo);
    assert.equal(findContainingRepo(path.join(root, 'outside.txt'), labeled), undefined);

    assert.equal(findGitRootForPath(subFile), submoduleRepo);
    assert.equal(findGitRootForPath(path.join(root, 'outside.txt')), null);
  });
});
