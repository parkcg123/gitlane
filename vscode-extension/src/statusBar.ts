import * as vscode from 'vscode';
import type { FlowConfig } from './config';
import { GitClient } from './git';
import { isProtectedBranch } from './naming';

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

  async update(repoRoot: string | null, config: FlowConfig | null): Promise<void> {
    if (!repoRoot || !config) {
      await this.updateContexts(false, false, true);
      this.item.hide();
      return;
    }

    const git = new GitClient(repoRoot);
    try {
      const [merging, branch, dirty] = await Promise.all([
        git.isMergeInProgress(),
        git.getCurrentBranch(),
        git.hasUncommittedChanges(),
      ]);

      if (merging) {
        await this.updateContexts(true, false, config.useDevelopBranch);
        this.item.text = '$(warning) GitLane: 머지 충돌 중';
        this.item.tooltip = '클릭하여 충돌 해결 완료 또는 머지 취소를 선택하세요.';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.show();
        return;
      }

      if (!branch) {
        await this.updateContexts(false, false, config.useDevelopBranch);
        this.item.text = '$(warning) GitLane: HEAD 분리됨';
        this.item.tooltip = 'Detached HEAD 상태입니다. 브랜치를 확인해 주세요.';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.show();
        return;
      }

      if (branch === config.masterBranch) {
        await this.updateContexts(false, false, config.useDevelopBranch);
        this.item.text = `$(shield) GitLane: ${branch} (운영)`;
        this.item.tooltip = dirty
          ? `주의: 운영 브랜치(${branch})에 커밋되지 않은 변경사항이 있습니다.`
          : config.useDevelopBranch
            ? `운영 브랜치(${branch}) — 클릭하여 GitLane 메뉴 열기`
            : `운영 브랜치(${branch}) — 클릭하여 작업 시작 또는 GitLane 메뉴 열기`;
        this.item.backgroundColor = dirty
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
        this.item.show();
        return;
      }

      if (config.useDevelopBranch && branch === config.developBranch) {
        await this.updateContexts(false, false, config.useDevelopBranch);
        this.item.text = `$(git-branch) GitLane: ${branch} (스테이지)`;
        this.item.tooltip = `스테이지 브랜치(${branch}) — 클릭하여 작업 시작 또는 운영 반영 실행`;
        this.item.backgroundColor = undefined;
        this.item.show();
        return;
      }

      const onTaskBranch = !isProtectedBranch(branch, config);
      await this.updateContexts(false, onTaskBranch, config.useDevelopBranch);
      this.item.text = `$(git-branch) GitLane: ${branch}`;
      this.item.tooltip = config.useDevelopBranch
        ? `작업 브랜치(${branch}) — 클릭하여 작업 반영 또는 메뉴 열기`
        : `작업 브랜치(${branch}) — 클릭하여 ${config.masterBranch} 바로 병합 또는 메뉴 열기`;
      this.item.backgroundColor = undefined;
      this.item.show();
    } catch {
      await this.updateContexts(false, false, config.useDevelopBranch);
      this.item.hide();
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
