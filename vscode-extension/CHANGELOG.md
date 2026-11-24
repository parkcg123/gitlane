# Changelog

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
