import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { CONFIG_FILENAME, DEFAULT_FLOW_CONFIG, loadRepoConfig } from '../src/config';
import {
  buildTaskBranchName,
  formatLocalDate,
  isProtectedBranch,
  sanitizeTaskName,
  validateTaskName,
} from '../src/naming';

describe('naming utilities', () => {
  it('formats local calendar date as YYYYMMDD regardless of UTC boundary', () => {
    // 2026-11-19 00:15:00 local time
    const localMidnight = new Date(2026, 10, 19, 0, 15, 0);
    assert.equal(formatLocalDate(localMidnight), '20261119');

    const janSingleDigit = new Date(2026, 0, 5, 23, 59, 59);
    assert.equal(formatLocalDate(janSingleDigit), '20260105');
  });

  it('sanitizes whitespace and duplicate separators cleanly', () => {
    assert.equal(sanitizeTaskName('  login   fix  '), 'login_fix');
    assert.equal(sanitizeTaskName('결제 오류 수정'), '결제_오류_수정');
    assert.equal(sanitizeTaskName('__foo___bar__'), 'foo_bar');
    assert.equal(sanitizeTaskName('  hot   patch  ', '-'), 'hot-patch');
  });

  it('rejects empty or invalid git ref characters', () => {
    assert.ok(validateTaskName(''));
    assert.ok(validateTaskName('   '));
    assert.ok(validateTaskName('___'));
    assert.ok(validateTaskName('feat/login'));
    assert.ok(validateTaskName('foo..bar'));
    assert.ok(validateTaskName('foo@{1}'));
    assert.ok(validateTaskName('bad~name'));
    assert.ok(validateTaskName('bad^name'));
    assert.ok(validateTaskName('bad:name'));
    assert.ok(validateTaskName('bad?name'));
    assert.ok(validateTaskName('bad*name'));
    assert.ok(validateTaskName('bad[name'));
    assert.ok(validateTaskName('bad\\name'));
    assert.ok(validateTaskName('.hidden'));
    assert.ok(validateTaskName('trailing.'));
    assert.ok(validateTaskName('branch.lock'));
    assert.ok(validateTaskName('branch.LOCK'));
    assert.ok(validateTaskName('bad\x01char'));
  });

  it('accepts valid Korean and ASCII task names', () => {
    assert.equal(validateTaskName('login_fix'), null);
    assert.equal(validateTaskName('로그인-오류-수정'), null);
    assert.equal(validateTaskName('결제 v2.1 개선'), null);
  });

  it('builds YYYYMMDD_작업명 branch names using local date', () => {
    const fixedDate = new Date(2026, 10, 19, 9, 0, 0);
    assert.equal(
      buildTaskBranchName('  login   fix ', { separator: '_' }, fixedDate),
      '20261119_login_fix'
    );
    assert.equal(
      buildTaskBranchName('결제 오류 수정', { separator: '_' }, fixedDate),
      '20261119_결제_오류_수정'
    );
    assert.throws(() => buildTaskBranchName('bad/name', { separator: '_' }, fixedDate));
  });

  it('identifies protected branches', () => {
    const cfg = { developBranch: 'develop', masterBranch: 'master', useDevelopBranch: true };
    assert.equal(isProtectedBranch('develop', cfg), true);
    assert.equal(isProtectedBranch('master', cfg), true);
    assert.equal(isProtectedBranch('20261119_login_fix', cfg), false);

    const directCfg = { developBranch: 'develop', masterBranch: 'master', useDevelopBranch: false };
    assert.equal(isProtectedBranch('develop', directCfg), false);
    assert.equal(isProtectedBranch('master', directCfg), true);
  });
});

describe('loadRepoConfig', () => {
  it('merges defaults, IDE overrides, and repo config file in precedence order', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlane-cfg-'));
    try {
      const base = loadRepoConfig(tmpDir, { remote: 'upstream', useDevelopBranch: false });
      assert.equal(base.warning, undefined);
      assert.equal(base.config.developBranch, DEFAULT_FLOW_CONFIG.developBranch);
      assert.equal(base.config.remote, 'upstream');
      assert.equal(base.config.useDevelopBranch, false);

      fs.writeFileSync(
        path.join(tmpDir, CONFIG_FILENAME),
        JSON.stringify({
          useDevelopBranch: false,
          developBranch: 'staging',
          masterBranch: 'main',
          returnToDevelopAfterRelease: false,
        }),
        'utf8'
      );

      const loaded = loadRepoConfig(tmpDir, {
        remote: 'upstream',
        developBranch: 'dev',
        useDevelopBranch: true,
      });
      assert.equal(loaded.warning, undefined);
      assert.equal(loaded.config.useDevelopBranch, false);
      assert.equal(loaded.config.developBranch, 'staging');
      assert.equal(loaded.config.masterBranch, 'main');
      assert.equal(loaded.config.remote, 'upstream');
      assert.equal(loaded.config.returnToDevelopAfterRelease, false);

      fs.writeFileSync(path.join(tmpDir, CONFIG_FILENAME), '{ broken json', 'utf8');
      const malformed = loadRepoConfig(tmpDir, { remote: 'upstream' });
      assert.ok(malformed.warning);
      assert.equal(malformed.config.remote, 'upstream');
      assert.equal(malformed.config.developBranch, DEFAULT_FLOW_CONFIG.developBranch);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
