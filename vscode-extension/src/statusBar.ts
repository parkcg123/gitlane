import * as vscode from 'vscode';
import type { FlowConfig } from './config';
import { GitClient } from './git';
import { isProtectedBranch } from './naming';

export interface RepoStatusTarget {
  root: string;
  label: string;
  config: FlowConfig;
}

interface RepoStatusSnapshot {
  root: string;
  label: string;
  config: FlowConfig;
  merging: boolean;
  branch: string | null;
  dirty: boolean;
}

function summarizeBranchForTooltip(snap: RepoStatusSnapshot): string {
  if (snap.merging) {
    return '머지 충돌 중';
  }
  if (!snap.branch) {
    return 'HEAD 분리됨';
  }
  if (snap.branch === snap.config.masterBranch) {
    return snap.dirty ? `${snap.branch} (운영, 변경사항 있음)` : `${snap.branch} (운영)`;
  }
  if (snap.config.useDevelopBranch && snap.branch === snap.config.developBranch) {
    return `${snap.branch} (스테이지)`;
  }
  return snap.branch;
}

export class FlowStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'gitlane.openMenu';
  }

  private async updateContexts(
    merging: boolean,
    onTaskBranch: boolean,
    useDevelopBranch: boolean
  ): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand('setContext', 'gitlane.merging', merging),
      vscode.commands.executeCommand('setContext', 'gitlane.onTaskBranch', onTaskBranch),
      vscode.commands.executeCommand('setContext', 'gitlane.useDevelopBranch', useDevelopBranch),
    ]);
  }

  private async inspectRepo(target: RepoStatusTarget): Promise<RepoStatusSnapshot> {
    const git = new GitClient(target.root);
    try {
      const [merging, branch, dirty] = await Promise.all([
        git.isMergeInProgress(),
        git.getCurrentBranch(),
        git.hasUncommittedChanges(),
      ]);
      return {
        ...target,
        merging,
        branch,
        dirty,
      };
    } catch {
      return {
        ...target,
        merging: false,
        branch: null,
        dirty: false,
      };
    }
  }

  async update(repos: RepoStatusTarget[], activeRepoRoot: string | null): Promise<void> {
    if (repos.length === 0) {
      await this.updateContexts(false, false, true);
      this.item.hide();
      return;
    }

    try {
      const snapshots = await Promise.all(repos.map((repo) => this.inspectRepo(repo)));
      const active =
        snapshots.find((snap) => snap.root === activeRepoRoot) ?? snapshots[0];

      const onTaskBranch =
        !active.merging &&
        active.branch !== null &&
        !isProtectedBranch(active.branch, active.config);
      await this.updateContexts(active.merging, onTaskBranch, active.config.useDevelopBranch);

      if (snapshots.length === 1) {
        this.renderSingleRepo(active);
      } else {
        this.renderMultiRepo(snapshots, active);
      }
      this.item.show();
    } catch {
      await this.updateContexts(false, false, true);
      this.item.hide();
    }
  }

  private renderSingleRepo(snap: RepoStatusSnapshot): void {
    if (snap.merging) {
      this.item.text = '$(warning) GitLane: 머지 충돌 중';
      this.item.tooltip = '클릭하여 충돌 해결 완료 또는 머지 취소를 선택하세요.';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    if (!snap.branch) {
      this.item.text = '$(warning) GitLane: HEAD 분리됨';
      this.item.tooltip = 'Detached HEAD 상태입니다. 브랜치를 확인해 주세요.';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    if (snap.branch === snap.config.masterBranch) {
      this.item.text = `$(shield) GitLane: ${snap.branch} (운영)`;
      this.item.tooltip = snap.dirty
        ? `주의: 운영 브랜치(${snap.branch})에 커밋되지 않은 변경사항이 있습니다.`
        : snap.config.useDevelopBranch
          ? `운영 브랜치(${snap.branch}) — 클릭하여 GitLane 메뉴 열기`
          : `운영 브랜치(${snap.branch}) — 클릭하여 작업 시작 또는 GitLane 메뉴 열기`;
      this.item.backgroundColor = snap.dirty
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
      return;
    }

    if (snap.config.useDevelopBranch && snap.branch === snap.config.developBranch) {
      this.item.text = `$(git-branch) GitLane: ${snap.branch} (스테이지)`;
      this.item.tooltip = `스테이지 브랜치(${snap.branch}) — 클릭하여 작업 시작 또는 운영 반영 실행`;
      this.item.backgroundColor = undefined;
      return;
    }

    this.item.text = `$(git-branch) GitLane: ${snap.branch}`;
    this.item.tooltip = snap.config.useDevelopBranch
      ? `작업 브랜치(${snap.branch}) — 클릭하여 작업 반영 또는 메뉴 열기`
      : `작업 브랜치(${snap.branch}) — 클릭하여 ${snap.config.masterBranch} 바로 병합 또는 메뉴 열기`;
    this.item.backgroundColor = undefined;
  }

  private renderMultiRepo(
    snapshots: RepoStatusSnapshot[],
    active: RepoStatusSnapshot
  ): void {
    const otherCount = snapshots.length - 1;
    const tooltipLines = [`GitLane — 저장소 ${snapshots.length}개 (클릭하여 저장소별 메뉴 열기)`];
    for (const snap of snapshots) {
      const currentMarker = snap.root === active.root ? ' (현재)' : '';
      tooltipLines.push(`• ${snap.label}: ${summarizeBranchForTooltip(snap)}${currentMarker}`);
    }
    this.item.tooltip = tooltipLines.join('\n');

    const mergingRepos = snapshots.filter((snap) => snap.merging);
    if (mergingRepos.length === 1) {
      this.item.text = `$(warning) GitLane [${mergingRepos[0].label}]: 머지 충돌 중 (+${otherCount})`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }
    if (mergingRepos.length > 1) {
      this.item.text = `$(warning) GitLane: 머지 충돌 ${mergingRepos.length}곳 (+${snapshots.length - mergingRepos.length})`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    let icon = '$(git-branch)';
    let branchLabel: string;
    let warn = false;

    if (!active.branch) {
      icon = '$(warning)';
      branchLabel = 'HEAD 분리됨';
      warn = true;
    } else if (active.branch === active.config.masterBranch) {
      icon = '$(shield)';
      branchLabel = `${active.branch} (운영)`;
      warn = active.dirty;
    } else if (active.config.useDevelopBranch && active.branch === active.config.developBranch) {
      branchLabel = `${active.branch} (스테이지)`;
    } else {
      branchLabel = active.branch;
    }

    this.item.text = `${icon} GitLane [${active.label}]: ${branchLabel} (+${otherCount})`;
    this.item.backgroundColor = warn
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
