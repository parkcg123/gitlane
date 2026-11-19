import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildConflictPanelState, ConflictPanelState } from './conflictModel';
import { GitClient } from './git';
import type { PendingConflictContext, WorkflowService } from './workflow';

export interface ConflictPanelParams {
  repoRoot: string;
  git: GitClient;
  service: WorkflowService;
  getPendingConflict: () => PendingConflictContext | undefined;
  openMergeEditorFile: (relPath: string) => Promise<void>;
  openTextFile: (relPath: string) => Promise<void>;
  onStateMutated: () => Promise<void>;
}

interface IncomingWebviewMessage {
  type?: unknown;
  filePath?: unknown;
}

export class ConflictManagerPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private currentParams: ConflictPanelParams | undefined;
  private latestState: ConflictPanelState | undefined;
  private busy = false;

  async showOrReveal(params: ConflictPanelParams): Promise<void> {
    this.currentParams = params;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      await this.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'gitlane.conflictManager',
      'GitLane — 충돌 관리',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel = panel;
    const nonce = crypto.randomBytes(16).toString('base64');
    panel.webview.html = this.getHtml(nonce);

    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.currentParams = undefined;
        this.latestState = undefined;
        this.busy = false;
      }
    });

    panel.webview.onDidReceiveMessage((raw: unknown) => {
      void this.handleMessage(raw);
    });

    await this.refresh();
  }

  async refreshIfOpen(): Promise<void> {
    if (this.panel && this.currentParams) {
      await this.refresh();
    }
  }

  async refresh(): Promise<void> {
    const panel = this.panel;
    const params = this.currentParams;
    if (!panel || !params) {
      return;
    }

    try {
      const [merging, currentBranch, unmergedEntries] = await Promise.all([
        params.git.isMergeInProgress(),
        params.git.getCurrentBranch(),
        params.git.getUnmergedEntries(),
      ]);

      const state = buildConflictPanelState({
        merging,
        currentBranch,
        context: params.getPendingConflict(),
        unmergedEntries,
      });

      this.latestState = state;
      if (this.panel === panel) {
        await panel.webview.postMessage({ type: 'state', state, busy: this.busy });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`충돌 상태를 불러오는 중 오류가 발생했습니다: ${message}`);
    }
  }

  private isValidFileTarget(filePath: unknown, repoRoot: string): filePath is string {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return false;
    }
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedFile = path.resolve(resolvedRoot, filePath);
    if (!resolvedFile.startsWith(resolvedRoot + path.sep)) {
      return false;
    }
    return Boolean(this.latestState?.files.some((f) => f.path === filePath));
  }

  private async runBusyAction(action: () => Promise<void>): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    if (this.panel && this.latestState) {
      void this.panel.webview.postMessage({ type: 'state', state: this.latestState, busy: true });
    }
    try {
      await action();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await vscode.window.showErrorMessage(`GitLane 오류: ${message}`);
    } finally {
      this.busy = false;
      await this.refreshIfOpen();
    }
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') {
      return;
    }
    const msg = raw as IncomingWebviewMessage;
    const params = this.currentParams;
    if (!params || typeof msg.type !== 'string') {
      return;
    }

    switch (msg.type) {
      case 'ready':
      case 'refresh': {
        await this.refresh();
        return;
      }

      case 'acceptOurs':
      case 'acceptTheirs': {
        const filePath = msg.filePath;
        if (!this.isValidFileTarget(filePath, params.repoRoot)) {
          return;
        }
        const side = msg.type === 'acceptOurs' ? 'ours' : 'theirs';
        await this.runBusyAction(async () => {
          await params.service.resolveConflictFile(filePath, side);
          await params.onStateMutated();
        });
        return;
      }

      case 'openMergeEditor': {
        const filePath = msg.filePath;
        if (!this.isValidFileTarget(filePath, params.repoRoot)) {
          return;
        }
        await params.openMergeEditorFile(filePath);
        return;
      }

      case 'openFile': {
        const filePath = msg.filePath;
        if (!this.isValidFileTarget(filePath, params.repoRoot)) {
          return;
        }
        await params.openTextFile(filePath);
        return;
      }

      case 'completeMerge': {
        await this.runBusyAction(async () => {
          const res = await params.service.continueAfterConflict();
          await params.onStateMutated();
          if (res.status === 'success') {
            this.panel?.dispose();
          }
        });
        return;
      }

      case 'abortMerge': {
        await this.runBusyAction(async () => {
          const res = await params.service.abortMerge();
          await params.onStateMutated();
          if (res.status === 'success') {
            this.panel?.dispose();
          }
        });
        return;
      }

      case 'closePanel': {
        this.panel?.dispose();
        return;
      }
    }
  }

  private getHtml(nonce: string): string {
    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>GitLane — 충돌 관리</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 20px 24px 28px;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
    }
    .header {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
    }
    .header-top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .title {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 3px 9px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .pill.warning {
      background-color: rgba(210, 153, 34, 0.2);
      color: var(--vscode-editorWarning-foreground, #cca700);
      border: 1px solid rgba(210, 153, 34, 0.45);
    }
    .pill.success {
      background-color: rgba(46, 160, 67, 0.2);
      color: var(--vscode-charts-green, #3fb950);
      border: 1px solid rgba(46, 160, 67, 0.45);
    }
    .progress-track {
      width: 100%;
      height: 6px;
      border-radius: 999px;
      background-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      width: 0%;
      border-radius: 999px;
      background-color: var(--vscode-charts-green, #3fb950);
      transition: width 160ms ease;
    }
    .tip {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.45;
    }
    .file-list {
      margin-top: 16px;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
      border-radius: 6px;
      overflow: hidden;
    }
    .file-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
    }
    .file-row:last-child {
      border-bottom: none;
    }
    .file-row:hover {
      background-color: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.08));
    }
    .file-info {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      min-width: 220px;
      flex: 1 1 320px;
    }
    .file-path {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 13px;
      word-break: break-all;
    }
    .kind-badge {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 4px;
      background-color: rgba(128, 128, 128, 0.16);
      color: var(--vscode-descriptionForeground);
    }
    .file-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    button {
      font-family: inherit;
      font-size: 12px;
      line-height: 1.3;
      padding: 5px 11px;
      border-radius: 4px;
      border: 1px solid transparent;
      cursor: pointer;
      white-space: nowrap;
    }
    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .btn-primary {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-primary:hover:not(:disabled) {
      background-color: var(--vscode-button-hoverBackground);
    }
    .btn-secondary {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover:not(:disabled) {
      background-color: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.35));
    }
    .btn-danger {
      background-color: transparent;
      color: var(--vscode-errorForeground, #f85149);
      border-color: rgba(248, 81, 73, 0.45);
    }
    .btn-danger:hover:not(:disabled) {
      background-color: rgba(248, 81, 73, 0.14);
    }
    .footer {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .footer-hint {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .footer-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .empty-box {
      margin-top: 24px;
      padding: 28px 20px;
      border: 1px dashed var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
      border-radius: 8px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
  </style>
</head>
<body>
  <div id="app"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentState = null;
    let isBusy = false;

    function createButton(text, className, onClick, options = {}) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = className;
      btn.textContent = text;
      if (options.title) {
        btn.title = options.title;
      }
      if (options.disabled) {
        btn.disabled = true;
      }
      btn.addEventListener('click', onClick);
      return btn;
    }

    function render() {
      const app = document.getElementById('app');
      app.replaceChildren();

      if (!currentState) {
        const loading = document.createElement('p');
        loading.className = 'tip';
        loading.textContent = '충돌 상태를 불러오는 중입니다...';
        app.appendChild(loading);
        return;
      }

      const state = currentState;

      if (!state.merging) {
        const empty = document.createElement('div');
        empty.className = 'empty-box';

        const heading = document.createElement('h2');
        heading.className = 'title';
        heading.textContent = '진행 중인 머지 충돌이 없습니다.';

        const sub = document.createElement('p');
        sub.className = 'tip';
        sub.textContent = '모든 충돌이 해결되었거나 병합이 취소되었습니다.';

        const closeBtn = createButton('창 닫기', 'btn-primary', () => {
          vscode.postMessage({ type: 'closePanel' });
        });

        empty.append(heading, sub, closeBtn);
        app.appendChild(empty);
        return;
      }

      const header = document.createElement('div');
      header.className = 'header';

      const headerTop = document.createElement('div');
      headerTop.className = 'header-top';

      const title = document.createElement('h1');
      title.className = 'title';
      title.textContent = '머지 충돌 관리';

      const badges = document.createElement('div');
      badges.className = 'badges';

      const branchPill = document.createElement('span');
      branchPill.className = 'pill';
      branchPill.textContent = state.sourceBranch + ' → ' + state.targetBranch;

      const progressPill = document.createElement('span');
      progressPill.className = 'pill ' + (state.unresolvedCount === 0 ? 'success' : 'warning');
      if (state.totalCount === 0) {
        progressPill.textContent = '남은 충돌 없음 (완료 가능)';
      } else {
        progressPill.textContent = '해결 현황: ' + state.resolvedCount + ' / ' + state.totalCount + ' 완료';
      }

      badges.append(branchPill, progressPill);
      headerTop.append(title, badges);

      const track = document.createElement('div');
      track.className = 'progress-track';
      const fill = document.createElement('div');
      fill.className = 'progress-fill';
      const pct = state.totalCount === 0 ? 100 : Math.round((state.resolvedCount / state.totalCount) * 100);
      fill.style.width = pct + '%';
      track.appendChild(fill);

      const tip = document.createElement('p');
      tip.className = 'tip';
      tip.textContent =
        "팁: [병합 창 열기] 후 VS Code 우측 상단 '···' 메뉴에서 3열(3-Column) 레이아웃으로 전환하면 IntelliJ와 유사하게 좌·중·우 비교 병합을 할 수 있습니다.";

      header.append(headerTop, track, tip);
      app.appendChild(header);

      if (state.files.length > 0) {
        const list = document.createElement('div');
        list.className = 'file-list';

        for (const item of state.files) {
          const row = document.createElement('div');
          row.className = 'file-row';

          const info = document.createElement('div');
          info.className = 'file-info';

          const statusPill = document.createElement('span');
          statusPill.className = 'pill ' + (item.status === 'resolved' ? 'success' : 'warning');
          statusPill.textContent = item.status === 'resolved' ? '해결 완료' : '미해결';

          const pathEl = document.createElement('span');
          pathEl.className = 'file-path';
          pathEl.textContent = item.path;

          info.append(statusPill, pathEl);

          if (item.conflictKindLabel) {
            const kindBadge = document.createElement('span');
            kindBadge.className = 'kind-badge';
            kindBadge.textContent = item.conflictKindLabel;
            info.appendChild(kindBadge);
          }

          const actions = document.createElement('div');
          actions.className = 'file-actions';

          if (item.status === 'unresolved') {
            actions.append(
              createButton(
                state.labels.oursLabel,
                'btn-secondary',
                () => vscode.postMessage({ type: 'acceptOurs', filePath: item.path }),
                { title: state.labels.oursTooltip, disabled: isBusy }
              ),
              createButton(
                state.labels.theirsLabel,
                'btn-secondary',
                () => vscode.postMessage({ type: 'acceptTheirs', filePath: item.path }),
                { title: state.labels.theirsTooltip, disabled: isBusy }
              ),
              createButton(
                '병합 창 열기',
                'btn-primary',
                () => vscode.postMessage({ type: 'openMergeEditor', filePath: item.path }),
                { title: 'VS Code 3-Way Merge Editor에서 직접 병합합니다.', disabled: isBusy }
              )
            );
          } else {
            actions.append(
              createButton(
                '파일 확인',
                'btn-secondary',
                () => vscode.postMessage({ type: 'openFile', filePath: item.path }),
                { disabled: isBusy }
              )
            );
          }

          row.append(info, actions);
          list.appendChild(row);
        }

        app.appendChild(list);
      }

      const footer = document.createElement('div');
      footer.className = 'footer';

      const hint = document.createElement('span');
      hint.className = 'footer-hint';
      if (state.unresolvedCount > 0) {
        hint.textContent =
          '남은 미해결 파일 ' + state.unresolvedCount + '개를 해결하면 [충돌 해결 완료] 버튼이 활성화됩니다.';
      } else {
        hint.textContent = '모든 충돌이 해결되었습니다. 아래 버튼으로 병합 커밋 및 푸시를 완료하세요.';
      }

      const footerActions = document.createElement('div');
      footerActions.className = 'footer-actions';

      footerActions.append(
        createButton(
          '새로고침',
          'btn-secondary',
          () => vscode.postMessage({ type: 'refresh' }),
          { disabled: isBusy }
        ),
        createButton(
          '머지 취소 (원복)',
          'btn-danger',
          () => vscode.postMessage({ type: 'abortMerge' }),
          { disabled: isBusy }
        ),
        createButton(
          '충돌 해결 완료 (커밋 & 푸시)',
          'btn-primary',
          () => vscode.postMessage({ type: 'completeMerge' }),
          {
            disabled: isBusy || !state.canComplete,
            title: state.canComplete
              ? '머지 커밋을 생성하고 원격 브랜치에 푸시합니다.'
              : '모든 미해결 충돌 파일을 먼저 해결해 주세요.',
          }
        )
      );

      footer.append(hint, footerActions);
      app.appendChild(footer);
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'state') {
        currentState = msg.state;
        isBusy = Boolean(msg.busy);
        render();
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.currentParams = undefined;
    this.latestState = undefined;
  }
}
