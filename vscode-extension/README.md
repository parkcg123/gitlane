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

1. **① Start Task (`gitlane.startTask`)**: Syncs `develop` (or `master` when `useDevelopBranch` is `false`) from remote and creates `YYYYMMDD_task` using your local timezone date. Offers auto-stash and one-click `stash pop` onto the new branch when uncommitted changes exist.
2. **② Merge (`gitlane.mergeToDevelop`)**: Verifies clean working tree and non-protected branch, previews up to 5 ahead commits, lets you choose **`develop` only / `master` only / both (`develop + master`)**, merges with `--no-ff`, pushes (with friendly recovery guidance if rejected), and lets you delete or keep the task branch (or clean up immediately when already merged).
3. **Delete Task Branch (`gitlane.deleteTaskBranch` & `gitlane.cleanupMergedBranches`)**: Safely deletes merged task branches (`-d`), warns before force-deleting (`-D`) unmerged branches, and supports bulk cleanup of already-merged task branches.
4. **③ Release to master (`gitlane.releaseToMaster`)**: Syncs `develop` and `master`, previews up to 5 ahead commits, merges into `master`, pushes, and optionally switches back to `develop`.
5. **Multi-Repository Support (`v0.4.0`)**: Automatically discovers multi-root workspaces, nested `.git` subdirectories, and submodules/worktrees, showing a **unified Status Bar** (`GitLane [repo]: branch (+N)`) and a **single-screen separator-grouped QuickPick menu**.
6. **Configuration Wizard (`gitlane.initConfig`)**: Auto-detects `develop`, `master`, and `main` branches to recommend and generate `.gitlane.json` (or opens it directly if present).
7. **Conflict Guardrail & Manager (`gitlane.openConflictManager`)**: Immediately stops on merge conflicts and opens an IntelliJ-style **Conflict Manager** panel with per-file resolution status, explicit branch-labeled one-click actions (`Keep target` / `Apply incoming`), VS Code 3-Way Merge Editor integration, **Complete Merge** (including multi-target continuation), and **Abort Merge**.

## Status Bar Indicators

| State | Status Bar Text | Click Action |
| :--- | :--- | :--- |
| Merge conflict in progress | `GitLane: 머지 충돌 중` (Warning) | Opens Conflict Resolution Menu |
| Multi-repo (2+ repositories) | `GitLane [<repo>]: <branch> (+N)` (or conflict priority) | Opens Single-Screen Grouped Menu |
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
