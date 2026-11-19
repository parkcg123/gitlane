import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    args: string[],
    exitCode: number | null,
    stdout: string,
    stderr: string
  ) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export interface MergeResult {
  ok: boolean;
  conflicted: boolean;
  conflictedFiles: string[];
  output: string;
}

export interface UnmergedEntry {
  path: string;
  xy: string;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GitClient {
  private static readonly UNMERGED_STATUSES = new Set([
    'UU',
    'AA',
    'DD',
    'AU',
    'UA',
    'DU',
    'UD',
  ]);

  constructor(private readonly cwd: string) {}

  private runRaw(args: string[]): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd: this.cwd,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
          },
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, stdout, stderr });
            return;
          }

          const nodeErr = error as NodeJS.ErrnoException & { code?: number | string };
          if (typeof nodeErr.code === 'number') {
            resolve({ exitCode: nodeErr.code, stdout, stderr });
            return;
          }

          // Spawn error (e.g., git binary missing or ENOENT cwd)
          reject(
            new GitError(
              `git 명령 실행에 실패했습니다: ${nodeErr.message}`,
              args,
              null,
              stdout,
              stderr
            )
          );
        }
      );
    });
  }

  private async runOrThrow(args: string[]): Promise<ExecResult> {
    const res = await this.runRaw(args);
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).trim() || `exit code ${res.exitCode}`;
      throw new GitError(
        `git ${args.join(' ')} 실패: ${detail}`,
        args,
        res.exitCode,
        res.stdout,
        res.stderr
      );
    }
    return res;
  }

  async getRepoRoot(): Promise<string> {
    const res = await this.runOrThrow(['rev-parse', '--show-toplevel']);
    return res.stdout.trim();
  }

  async getGitDir(): Promise<string> {
    const res = await this.runOrThrow(['rev-parse', '--git-dir']);
    return path.resolve(this.cwd, res.stdout.trim());
  }

  /**
   * Returns current branch name, or null when HEAD is detached.
   */
  async getCurrentBranch(): Promise<string | null> {
    const res = await this.runRaw(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (res.exitCode === 0) {
      const branch = res.stdout.trim();
      return branch.length > 0 ? branch : null;
    }
    return null;
  }

  async isMergeInProgress(): Promise<boolean> {
    const res = await this.runRaw(['rev-parse', '--verify', '-q', 'MERGE_HEAD']);
    return res.exitCode === 0;
  }

  async isRebaseInProgress(): Promise<boolean> {
    const gitDir = await this.getGitDir();
    return (
      fs.existsSync(path.join(gitDir, 'rebase-merge')) ||
      fs.existsSync(path.join(gitDir, 'rebase-apply'))
    );
  }

  async getConflictedFiles(): Promise<string[]> {
    const res = await this.runOrThrow(['diff', '-z', '--name-only', '--diff-filter=U']);
    return res.stdout.split('\0').filter((line) => line.length > 0);
  }

  async getUnmergedEntries(): Promise<UnmergedEntry[]> {
    const res = await this.runOrThrow(['status', '--porcelain=v1', '-z']);
    const tokens = res.stdout.split('\0');
    const entries: UnmergedEntry[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.length < 4) {
        continue;
      }
      const xy = token.slice(0, 2);
      const filePath = token.slice(3);
      if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
        i += 1;
      }
      if (GitClient.UNMERGED_STATUSES.has(xy) && filePath.length > 0) {
        entries.push({ path: filePath, xy });
      }
    }

    return entries;
  }

  async resolveConflictFile(filePath: string, side: 'ours' | 'theirs'): Promise<void> {
    const entries = await this.getUnmergedEntries();
    const entry = entries.find((item) => item.path === filePath);
    if (!entry) {
      throw new Error(`충돌 상태가 아닌 파일입니다: ${filePath}`);
    }

    const deletedOrAbsentOnChosenSide =
      (side === 'ours' && (entry.xy === 'DU' || entry.xy === 'DD' || entry.xy === 'UA')) ||
      (side === 'theirs' && (entry.xy === 'UD' || entry.xy === 'DD' || entry.xy === 'AU'));

    if (deletedOrAbsentOnChosenSide) {
      await this.runOrThrow(['rm', '-f', '--', filePath]);
      return;
    }

    await this.runOrThrow(['checkout', `--${side}`, '--', filePath]);
    await this.runOrThrow(['add', '--', filePath]);
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const res = await this.runOrThrow(['status', '--porcelain']);
    return res.stdout.trim().length > 0;
  }

  async hasRemote(remote: string): Promise<boolean> {
    const res = await this.runRaw(['remote', 'get-url', remote]);
    return res.exitCode === 0;
  }

  async branchExistsLocal(branch: string): Promise<boolean> {
    const res = await this.runRaw(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return res.exitCode === 0;
  }

  async branchExistsRemote(remote: string, branch: string): Promise<boolean> {
    const res = await this.runRaw([
      'show-ref',
      '--verify',
      '--quiet',
      `refs/remotes/${remote}/${branch}`,
    ]);
    return res.exitCode === 0;
  }

  async fetch(remote: string): Promise<void> {
    await this.runOrThrow(['fetch', remote, '--prune']);
  }

  /**
   * Ensures a local branch exists, creating a tracking branch from remote if missing locally.
   */
  async ensureLocalBranch(branch: string, remote: string): Promise<boolean> {
    if (await this.branchExistsLocal(branch)) {
      return true;
    }
    if ((await this.hasRemote(remote)) && (await this.branchExistsRemote(remote, branch))) {
      await this.runOrThrow(['branch', '--track', branch, `${remote}/${branch}`]);
      return true;
    }
    return false;
  }

  async checkout(branch: string): Promise<void> {
    await this.runOrThrow(['checkout', branch]);
  }

  async checkoutNewBranch(branch: string): Promise<void> {
    await this.runOrThrow(['checkout', '-b', branch]);
  }

  async pullFastForwardOnly(remote: string, branch: string): Promise<void> {
    await this.runOrThrow(['pull', '--ff-only', remote, branch]);
  }

  async stashPush(message: string): Promise<void> {
    await this.runOrThrow(['stash', 'push', '-u', '-m', message]);
  }

  async merge(branch: string, noFastForward: boolean): Promise<MergeResult> {
    const args = ['merge', ...(noFastForward ? ['--no-ff'] : []), '--no-edit', branch];
    const res = await this.runRaw(args);
    const output = `${res.stdout}\n${res.stderr}`.trim();

    if (res.exitCode === 0) {
      return {
        ok: true,
        conflicted: false,
        conflictedFiles: [],
        output,
      };
    }

    const [merging, conflictedFiles] = await Promise.all([
      this.isMergeInProgress(),
      this.getConflictedFiles(),
    ]);

    if (merging || conflictedFiles.length > 0) {
      return {
        ok: false,
        conflicted: true,
        conflictedFiles,
        output,
      };
    }

    throw new GitError(
      `git ${args.join(' ')} 실패: ${output || `exit code ${res.exitCode}`}`,
      args,
      res.exitCode,
      res.stdout,
      res.stderr
    );
  }

  async mergeAbort(): Promise<void> {
    await this.runOrThrow(['merge', '--abort']);
  }

  async commitMerge(): Promise<void> {
    await this.runOrThrow(['commit', '--no-edit']);
  }

  async push(remote: string, branch: string): Promise<void> {
    await this.runOrThrow(['push', '-u', remote, branch]);
  }

  async deleteLocalBranch(branch: string): Promise<void> {
    await this.runOrThrow(['branch', '-d', branch]);
  }

  async deleteRemoteBranch(remote: string, branch: string): Promise<void> {
    await this.runOrThrow(['push', remote, '--delete', branch]);
  }

  async getAheadCommits(base: string, head: string): Promise<string[]> {
    const res = await this.runOrThrow(['log', '--oneline', `${base}..${head}`]);
    return res.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
}
