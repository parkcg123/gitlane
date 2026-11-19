# Changelog

## [0.1.0] - 2026-11-19

### Added
- Initial marketplace release of **GitLane**.
- Core workflow commands: `startTask`, `mergeToDevelop`, `releaseToMaster`, `continueMerge`, `abortMerge`, and `openConflictManager`.
- Local-timezone `YYYYMMDD_<task>` branch naming validation and sanitization.
- IntelliJ-style Conflict Manager Webview with per-file resolution (`--ours` / `--theirs`), VS Code 3-Way Merge Editor launcher, merge completion, and merge abort guardrails.
- Status bar indicator and Source Control (`scm/title`) quick-access button.
- Repository-level `.gitlane.json` configuration support with VS Code settings fallback.
