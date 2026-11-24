# GitLane — 공통 워크플로우 스펙

이 문서는 **VS Code 확장**과 **IntelliJ 플러그인**이 100% 동일한 동작, 가드레일, 에러 메시지를 유지하기 위한 단일 기준(Single Source of Truth)입니다.

---

## 1. 브랜치 모델 (`develop → master` 또는 `master` 직행)

* **기준(Base) 브랜치**: `develop` (스테이지), `master` (운영)
* **단일 브랜치 모드 (`useDevelopBranch: false`)**:
  * `develop` 브랜치를 사용하지 않고 `master`(또는 `main`)에서 직접 작업 브랜치를 분기하고 바로 병합합니다.
* **작업 브랜치 생성**: `useDevelopBranch: true`이면 최신 `develop`에서, `false`이면 최신 `master`에서 분기합니다.
* **작업 브랜치 이름 규칙**: `{YYYYMMDD}{separator}{작업명}`
  * 날짜는 **로컬 타임존(`YYYYMMDD`)** 기준을 사용합니다. (UTC 기준 사용 금지)
  * 기본 구분자(`separator`)는 `_` 입니다. (예: `20261119_login_fix`, `20261119_결제_오류_수정`)
  * 공백 및 연속된 구분자는 단일 구분자(`_`)로 정규화되며, 앞뒤 구분자는 제거됩니다.
  * 금지 문자 및 규칙:
    * 빈 문자열 또는 구분자만 입력한 경우
    * Git ref 금지 문자: `/`, `..`, `@{`, `~`, `^`, `:`, `?`, `*`, `[`, `\`, 제어문자(ASCII `< 32` 또는 `127`)
    * `.`으로 시작하거나 `.`으로 끝나는 경우, `.lock`으로 끝나는 경우

---

## 2. 설정 우선순위

1. 저장소 루트의 `.gitlane.json` (최우선)
2. IDE 확장/플러그인 설정 (`gitlane.*`)
3. 기본값:
   * `useDevelopBranch`: `true`
   * `developBranch`: `"develop"`
   * `masterBranch`: `"master"`
   * `remote`: `"origin"`
   * `dateFormat`: `"YYYYMMDD"`
   * `separator`: `"_"`
   * `returnToDevelopAfterRelease`: `true`
   * `useNoFastForwardMerge`: `true`

---

## 3. 핵심 액션 명세

### ① 작업 시작 (`startTask`)

* **기준 브랜치 선택 (`useDevelopBranch: true`일 때)**:
  * `develop`과 `master`가 서로 다른 경우 실행 시 기준 브랜치를 선택합니다:
    * **`develop (일반 작업 · 기본)`**: 스테이지 브랜치에서 일반 작업 분기
    * **`master (운영 핫픽스)`**: 운영 브랜치에서 긴급 수정 분기
    * **`취소`**
  * `useDevelopBranch: false`인 경우에는 묻지 않고 바로 `master`를 기준으로 삼습니다.
* **사전 검사 (Pre-flight)**:
  1. 진행 중인 머지(`MERGE_HEAD`) 또는 리베이스(`rebase-merge`/`rebase-apply`)가 있으면 중단하고 안내합니다.
  2. 미커밋 변경사항(dirty working tree)이 있으면 선택지를 제공합니다:
     * `"임시 저장(Stash) 후 진행"` → `git stash push -u -m "gitlane: auto-stash before startTask"`
     * `"취소"`
* **실행 절차**:
  1. 원격(`remote`)이 있으면 `git fetch <remote>` 수행.
  2. 로컬에 `develop`이 없으면 원격 추적 브랜치에서 생성 후 체크아웃.
  3. `git checkout <develop>` 후 원격 `develop`이 존재하면 `git pull --ff-only <remote> <develop>` (분기 시 친화적 한국어 복구 안내).
  4. 사용자에게 작업명 입력을 요청 (실시간으로 `YYYYMMDD_작업명` 미리보기 및 유효성 검사 표시).
  5. 대상 브랜치명 `YYYYMMDD_작업명`이 로컬에 이미 존재하면:
     * `"기존 브랜치로 이동"` 선택 시 해당 브랜치로 `checkout`.
     * `"취소"` 선택 시 종료.
  6. `git checkout -b <taskBranch>` 실행.
  7. 사전 검사에서 자동 Stash를 수행했다면 `"임시 저장(Stash)한 변경사항을 '<taskBranch>' 브랜치로 바로 복원(Stash Pop)할까요?"` 확인 후 `git stash pop` 실행(충돌 시 경고 안내).

### ② 작업 반영 (`mergeToDevelop`)

* **메뉴 표시 조건**: 현재 브랜치가 작업 브랜치(보호 브랜치가 아니고 Detached HEAD가 아님)이며 머지 충돌 중이 아닐 때만 메뉴에 표시됩니다. 보호 브랜치(`develop` / `master`)에서는 숨김 처리되고 직접 호출 시 차단됩니다.
* **대상 선택**:
  * `useDevelopBranch`가 `true`이면 사용자에게 **`develop`만**, **`master`만**, **`develop + master` 둘 다** 중 반영 대상을 선택받습니다.
  * `useDevelopBranch`가 `false`이면 대상은 항상 `master`입니다.
* **사전 검사 (Pre-flight)**:
  1. 진행 중인 머지/리베이스가 있으면 중단합니다.
  2. Detached HEAD 상태이거나 현재 브랜치가 보호 브랜치(`useDevelopBranch: true`일 때 `develop` 또는 `master`, `false`일 때 `master`)이면 차단합니다.
  3. 미커밋 변경사항이 있으면 커밋 또는 Stash를 먼저 하도록 안내하고 차단합니다.
  4. 선택한 모든 대상 브랜치를 최신화한 뒤 `<target>..<taskBranch>` 커밋이 모두 0건이면 `"이미 반영되어 있습니다. 작업 브랜치를 삭제할까요?"`를 물어보고, 승인 시 작업 브랜치를 삭제(`-d` + 원격 삭제)합니다.
  5. 반영 커밋이 있으면 반영 방식(`병합 + 푸시 + 브랜치 삭제` / `병합 + 푸시 (브랜치 유지)` / `취소`) 확인 시 포함된 커밋 미리보기(최대 5줄)를 함께 표시합니다.
  6. 원격 `git push`가 `non-fast-forward` / `fetch first` / `rejected`로 거절되면 작업 브랜치를 삭제하지 않고 친화적인 한국어 Pull 후 재푸시 안내를 표시합니다.
* **순차 병합 및 충돌 이어하기 (`develop + master` 선택 시)**:
  * `develop`에 있던 다른 미배포 커밋이 `master`로 섞이지 않도록, **작업 브랜치 → `develop`**, **작업 브랜치 → `master`** 순으로 각각 병합·푸시합니다.
  * 첫 번째 대상(`develop`)에서 충돌이 발생하면 `PendingConflictContext.remainingTargets`에 남은 대상(`["master"]`)을 저장하고, 충돌 해결 완료(`continueMerge`) 직후 남은 대상 병합을 자동으로 이어서 진행합니다.
  * `브랜치 삭제` 선택 시 마지막 대상 병합이 끝난 상태에서 로컬(`-d`) 및 원격 작업 브랜치를 삭제한 뒤(`returnToDevelopAfterRelease`가 `true`이면 `develop`으로 복귀) 마무리합니다.

### 작업 브랜치 삭제 (`deleteTaskBranch`)

* **메뉴 표시 조건**: 작업 브랜치이며 머지 충돌 중이 아닐 때만 메뉴에 표시됩니다.
* **사전 검사 (Pre-flight)**:
  1. 진행 중인 머지/리베이스가 있으면 중단합니다.
  2. Detached HEAD 상태이거나 보호 브랜치이면 차단합니다.
  3. 미커밋 변경사항이 있으면 차단합니다.
* **실행 절차**:
  1. 로컬 `develop` 또는 `master`에 이미 모두 반영되었는지 확인합니다.
  2. 이미 반영된 브랜치면 안전 삭제(`git branch -d`), 미병합 커밋이 남아 있으면 커밋 수를 경고한 뒤 사용자 승인 시 강제 삭제(`git branch -D`)를 수행합니다.
  3. 원격 작업 브랜치가 존재하면 best-effort로 함께 삭제하고 기준 브랜치(`develop` 또는 `master`)로 복귀합니다.

### ③ 운영 반영 (`releaseToMaster`)

* `useDevelopBranch`가 `false`인 경우 메뉴에서 숨김 처리되며, 직접 호출 시 차단 안내 후 종료합니다.

* **사전 검사 (Pre-flight)**:
  1. 진행 중인 머지/리베이스가 있으면 중단합니다.
  2. 미커밋 변경사항이 있으면 차단합니다.
* **실행 절차**:
  1. 원래 브랜치 기억 (`originalBranch`).
  2. 원격이 있으면 `git fetch <remote>`.
  3. `develop` 존재 확인 및 최신화(`pull --ff-only`).
  4. `master` 존재 확인 및 최신화(`pull --ff-only`).
  5. `master..develop` 커밋 목록 조회. 0건이면 원래 브랜치로 복귀 후 `"master에 반영할 새 커밋이 없습니다."` 안내.
  6. 사용자 확인: 반영할 커밋 수와 최근 커밋 최대 5줄을 보여주고 `"운영(master)에 병합 및 푸시"` / `"취소"` 선택.
     * 취소 시 원래 브랜치(또는 `develop`)로 안전하게 복귀합니다.
  7. `git merge [--no-ff] <develop>` 실행.
  8. 충돌 발생 시 **충돌 가드레일**로 전환 (`targetBranch: master`, `sourceBranch: develop`, `returnBranch: originalBranch ?? develop`, `deleteSourceOnComplete: false`).
  9. 병합 성공 + 원격 존재 시 `git push <remote> <master>`.
  10. `returnToDevelopAfterRelease`가 `true`이면 `git checkout <develop>`으로 복귀.

---

## 4. 충돌 가드레일 (`continueMerge`, `abortMerge`)

병합 중 충돌이 발생하면 `PendingConflictContext`를 저장합니다:

```json
{
  "targetBranch": "develop",
  "sourceBranch": "20261119_login_fix",
  "returnBranch": "20261119_login_fix",
  "deleteSourceOnComplete": true
}
```

* **즉시 안내 선택지**:
  * VS Code에서는 IntelliJ 스타일 **충돌 관리 창(`gitlane.openConflictManager`)**을 즉시 열어 파일별 해결 상태, 브랜치명이 명시된 원클릭 해결 버튼(`--ours` = 대상 브랜치 유지 / `--theirs` = 병합 브랜치 적용), 내장 3-Way Merge Editor 실행(`git.openMergeEditor`), 완료 및 취소 버튼을 제공합니다.
  * `"충돌 파일 열기"` — IDE의 Merge Editor(VS Code: `git.openMergeEditor` / IntelliJ: VCS Resolve Conflicts) 또는 파일 편집기 오픈
  * `"머지 취소 (원복)"` — `abortMerge()` 실행
* **충돌 해결 완료 (`continueMerge`)**:
  1. 미해결 충돌 파일(`git diff --name-only --diff-filter=U`)이 남아 있으면 차단하고 충돌 파일을 다시 열어줍니다.
  2. `git commit --no-edit`으로 머지 커밋 완료.
  3. 원격 존재 시 `git push <remote> <targetBranch>`.
  4. `deleteSourceOnComplete`가 `true`이면 로컬/원격 작업 브랜치 삭제, 아니면 `returnBranch`로 복귀(운영 반영인 경우 `returnToDevelopAfterRelease` 설정 반영).
  5. 저장된 `PendingConflictContext` 초기화.
* **머지 취소 (`abortMerge`)**:
  1. 진행 중인 머지가 없으면 컨텍스트만 정리하고 종료.
  2. 사용자 확인 후 `git merge --abort`.
  3. `returnBranch`가 유효하고 존재하면 해당 브랜치로 `checkout`.
  4. 저장된 `PendingConflictContext` 초기화.

---

## 5. 상태바 (Status Bar) 표시 규칙

| 상태 | 표시 텍스트 | 배경 강조 | 클릭 동작 |
| :--- | :--- | :---: | :--- |
| Git 저장소 아님 | (숨김) | - | - |
| 머지 충돌 진행 중 | `GitLane: 머지 충돌 중` | 경고색 (Warning) | 충돌 해결 메뉴(파일 열기 / 완료 / 취소) |
| `master` 브랜치 (변경사항 있음) | `GitLane: master (운영)` | 경고색 (Warning) | 메인 메뉴 |
| `master` 브랜치 (깨끗함) | `GitLane: master (운영)` | 기본 | 메인 메뉴 |
| `develop` 브랜치 | `GitLane: develop (스테이지)` | 기본 | 메인 메뉴 |
| 작업 브랜치 | `GitLane: <브랜치명>` | 기본 | 메인 메뉴 |

---

## 6. 복합 Git 저장소(Multi-Repository) 지원

하나의 워크스페이스/프로젝트 아래 여러 Git 저장소(Multi-root, 하위 폴더 `.git`, 서브모듈, worktree `.git` 파일)가 존재하는 경우 다음과 같이 동작합니다:

* **자동 탐색 및 라벨링**:
  * IDE Git 매니저에 등록된 저장소와 워크스페이스 루트 기준 하위 2단계까지의 `.git` 마커(`node_modules`/`build`/`out`/`.gradle` 등 제외)를 모두 수집해 정규화·중복 제거합니다.
  * 폴더명이 겹치는 저장소(`apps/web`, `packages/web`)는 워크스페이스 상대 경로나 상위 폴더명을 붙여 구분합니다.
* **단일 저장소 호환**: 감지된 저장소가 1개이면 기존 단일 저장소 UI와 100% 동일하게 동작합니다.
* **통합 상태바 (2개 이상)**:
  * 현재 열린 편집기 파일이 속한 저장소(중첩 시 가장 깊은 경로 매칭, 없으면 마지막 선택 저장소 → 첫 저장소)를 활성 저장소로 표시합니다(`GitLane [<저장소>]: <브랜치> (+N)`).
  * 어느 저장소에서든 머지 충돌이 발생하면 경고 강조로 최우선 표시(`GitLane [<저장소>]: 머지 충돌 중 (+N)` 또는 `머지 충돌 M곳`)하며, 툴팁에 전체 저장소 목록과 상태를 한눈에 나열합니다.
* **한 화면 저장소별 구분 메뉴 (2개 이상)**:
  * 단일 QuickPick(VS Code) 또는 단일 액션 그룹 팝업/메뉴(IntelliJ) 안에 저장소별 구분선(`<저장소> · <상태>`)을 두고 각 저장소의 현재 상태(충돌 여부, 작업 브랜치 여부, `.gitlane.json` 설정)에 맞는 액션만 나열해 선택한 저장소에 바로 실행합니다.

---

## 7. 도구 및 설정 (`cleanupMergedBranches`, `.gitlane.json` 마법사)

* **완료된 작업 브랜치 일괄 정리 (`cleanupMergedBranches`)**:
  * 메뉴 최하단 `도구 / 설정` 구분선 아래에 1회 표시됩니다.
  * 현재 체크아웃 브랜치와 보호 브랜치(`develop`, `master`)를 제외하고, 로컬 보호 브랜치 중 하나에 이미 모든 커밋이 반영(`ahead == 0`)된 작업 브랜치만 후보로 나열합니다.
  * 다중 선택 체크박스(기본 전체 선택)로 선택한 브랜치만 안전 삭제(`git branch -d` + 원격 best-effort 삭제)합니다.
* **저장소 설정 자동 감지 및 생성 (`initConfig` / IntelliJ `Settings → Tools → GitLane`)**:
  * `.gitlane.json`이 이미 있으면 에디터에서 바로 엽니다.
  * 없으면 저장소의 로컬/원격 `develop`, `master`, `main` 존재 여부를 자동 감지(`detectRecommendedConfig`)하여 2단계 모드 또는 운영 직행 모드(`useDevelopBranch: false`, `masterBranch: "main" | "master"`)를 추천하고 `.gitlane.json`을 생성합니다.
  * IntelliJ에서는 **Settings → Tools → GitLane** 네이티브 설정 UI(`GitLaneConfigurable`)에서도 저장소별 설정 편집 및 `브랜치 자동 감지`를 제공합니다.
