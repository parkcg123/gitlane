# Changelog

## [0.4.0] - 2026-11-24

### Added
- Automatic multi-repository discovery across multi-root workspaces, nested subdirectories (up to depth 2), and Git submodules/worktrees, with path-segment disambiguation for duplicate folder names.
- Unified single Status Bar item with conflict-priority indicator, active-editor tracking, and a full multi-repository hover tooltip.
- Single-screen grouped QuickPick menu (`QuickPickItemKind.Separator` per repository) showing each repository's branch state and contextual workflow actions side by side.

## [0.3.0] - 2026-11-24

### Added
- Merge target selector for task branches (`develop`, `master`, or `develop + master` in parallel) with per-target conflict continuation and automatic branch cleanup.
- Standalone `GitLane: 작업 브랜치 삭제` (`gitlane.deleteTaskBranch`) command with safe (`-d`) vs. unmerged-warning force (`-D`) deletion.
- Branch-cleanup prompt when a task branch already has 0 ahead commits against the selected target(s).

### Changed
- Task-branch merge (`gitlane.mergeToDevelop`) and deletion (`gitlane.deleteTaskBranch`) actions are now hidden in both the GitLane menu and Command Palette unless checked out on a non-protected task branch.

## [0.2.1] - 2026-11-24

### Changed
- Aligned release version with GitLane IntelliJ Plugin 0.2.1 (contextual merge-conflict action visibility).

## [0.2.0] - 2026-11-19

### Added
- `useDevelopBranch` option (both `.gitlane.json` and `gitlane.useDevelopBranch` setting, default `true`): set to `false` to fork task branches from `master` (or `main`) and merge directly back into `master` without requiring a `develop` branch.
- Dynamic quick-pick menu, conflict labels (`mergeToMaster`), and status bar tooltips tailored for direct-to-master repositories.

## [0.1.0] - 2026-11-19

### Added
- Initial marketplace release of **GitLane**.
- Core workflow commands: `startTask`, `mergeToDevelop`, `releaseToMaster`, `continueMerge`, `abortMerge`, and `openConflictManager`.
- Local-timezone `YYYYMMDD_<task>` branch naming validation and sanitization.
- IntelliJ-style Conflict Manager Webview with per-file resolution (`--ours` / `--theirs`), VS Code 3-Way Merge Editor launcher, merge completion, and merge abort guardrails.
- Status bar indicator and Source Control (`scm/title`) quick-access button.
- Repository-level `.gitlane.json` configuration support with VS Code settings fallback.
