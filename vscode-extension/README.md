# GitLane Flow (VS Code Extension)

A streamlined, guarded Git workflow extension for teams following either the **`develop → YYYYMMDD_task → develop → master`** lane or the direct **`master → YYYYMMDD_task → master`** lane.

> **요약**: `develop → YYYYMMDD_작업명 → develop → master` 또는 `useDevelopBranch: false` 설정으로 `develop` 없이 `master`로 바로 분기·병합하는 팀 Git 워크플로우를 상태바/SCM 버튼 클릭만으로 안전하게 실행합니다.

## Workflow Overview

```text
develop (Staging) ──[① Start Task]──▶ YYYYMMDD_task (Feature Branch)
                                              │
                                              ▼ [② Merge to develop]
                                        develop (Staging Verification)
                                              │
                                              ▼ [③ Release to master]
                                        master (Production)
```

> **Direct-to-Master Mode (`useDevelopBranch: false`)**: When `develop` is disabled, ① Start Task forks from `master` (or `main`), ② Merge directly merges and pushes to `master`, and ③ Release is automatically hidden.

1. **① Start Task (`gitlane.startTask`)**: Syncs `develop` (or `master` when `useDevelopBranch` is `false`) from remote and creates `YYYYMMDD_task` using your local timezone date. Offers auto-stash if there are uncommitted changes.
2. **② Merge (`gitlane.mergeToDevelop`)**: Verifies clean working tree and non-protected branch, merges into `develop` (or directly into `master` when `useDevelopBranch` is `false`) with `--no-ff`, pushes to remote, and lets you delete or keep the task branch.
3. **③ Release to master (`gitlane.releaseToMaster`)**: Syncs `develop` and `master`, previews up to 5 ahead commits, merges into `master`, pushes, and optionally switches back to `develop`.
4. **Conflict Guardrail & Manager (`gitlane.openConflictManager`)**: Immediately stops on merge conflicts and opens an IntelliJ-style **Conflict Manager** panel with per-file resolution status, explicit branch-labeled one-click actions (`Keep target` / `Apply incoming`), VS Code 3-Way Merge Editor integration, **Complete Merge**, and **Abort Merge**.

## Status Bar Indicators

| State | Status Bar Text | Click Action |
| :--- | :--- | :--- |
| Merge conflict in progress | `GitLane: 머지 충돌 중` (Warning) | Opens Conflict Resolution Menu |
| `master` (uncommitted changes) | `GitLane: master (운영)` (Warning) | Opens Workflow Menu |
| `master` (clean) | `GitLane: master (운영)` | Opens Workflow Menu |
| `develop` (`useDevelopBranch: true`) | `GitLane: develop (스테이지)` | Opens Workflow Menu |
| Task branch | `GitLane: <branch-name>` | Opens Workflow Menu |

## Repository Configuration (`.gitlane.json`)

Place `.gitlane.json` at your repository root to share identical rules across VS Code and IntelliJ IDEA (takes precedence over IDE settings):

```json
{
  "$schema": "https://raw.githubusercontent.com/parkcg123/gitlane/main/spec/gitlane.schema.json",
  "useDevelopBranch": true,
  "developBranch": "develop",
  "masterBranch": "master",
  "remote": "origin",
  "dateFormat": "YYYYMMDD",
  "separator": "_",
  "returnToDevelopAfterRelease": true,
  "useNoFastForwardMerge": true
}
```

To skip `develop` and merge task branches directly into `master` (or `main`):

```json
{
  "useDevelopBranch": false,
  "masterBranch": "main"
}
```

### Extension Settings (`settings.json`)

* `gitlane.useDevelopBranch` (default: `true`)
* `gitlane.developBranch` (default: `"develop"`)
* `gitlane.masterBranch` (default: `"master"`)
* `gitlane.remote` (default: `"origin"`)
* `gitlane.returnToDevelopAfterRelease` (default: `true`)
* `gitlane.useNoFastForwardMerge` (default: `true`)

## Prerequisites

* **Git CLI** available on `PATH`.
* **Non-interactive remote authentication** (SSH key or Git Credential Manager / OS Keychain), since Git commands run with `GIT_TERMINAL_PROMPT=0`.

## Source & License

* Repository: [https://github.com/parkcg123/gitlane](https://github.com/parkcg123/gitlane)
* Issues: [https://github.com/parkcg123/gitlane/issues](https://github.com/parkcg123/gitlane/issues)
* License: MIT
