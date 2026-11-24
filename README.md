# GitLane

VS Code와 IntelliJ IDEA에서 동일한 팀 Git 워크플로우(`develop → YYYYMMDD_작업명 → develop → master`)를 버튼 클릭만으로 안전하게 실행하기 위한 Monorepo 프로젝트입니다.

## 워크플로우 개요

```text
develop (스테이지) ──[① 작업 시작]──▶ YYYYMMDD_작업명 (개발 브랜치)
                                            │
                                            ▼ [② 스테이지 반영]
                                      develop (스테이지 서버 확인)
                                            │
                                            ▼ [③ 운영 반영]
                                      master (운영 서버)
```

1. **① 작업 시작 (`startTask`)**: `develop`(직행 모드 시 `master`)을 최신화한 뒤 `YYYYMMDD_작업명` 브랜치를 생성하고 이동합니다. 수정 중인 파일이 있으면 Stash 후 새 브랜치로 바로 복원(`stash pop`)할 수 있습니다.
2. **② 작업 반영 (`mergeToDevelop`)**: 작업 브랜치를 **`develop`만 / `master`만 / `develop + master` 둘 다** 중 선택해 병합(`--no-ff`)·푸시하며, 병합 후 브랜치 삭제 또는 유지를 선택할 수 있습니다. (이미 반영 완료된 브랜치면 바로 삭제 제안)
3. **③ 운영 반영 (`releaseToMaster`)**: 스테이지 확인이 끝난 `develop` 전체를 `master`에 병합(`--no-ff`)하고 푸시합니다. 완료 후 설정에 따라 `develop`으로 복귀합니다.
4. **작업 브랜치 삭제 (`deleteTaskBranch`)**: 이미 병합된 브랜치는 안전 삭제(`-d`), 미병합 커밋이 남아 있으면 경고 확인 후 강제 삭제(`-D`)하며 원격 브랜치도 정리합니다. (비작업 브랜치에서는 병합·삭제 메뉴 자동 숨김)
5. **복합 Git 저장소 지원 (`v0.4.0`)**: Multi-root, 하위 폴더 `.git`, 서브모듈/worktree를 자동 인식해 통합 상태바(`GitLane [저장소]: 브랜치 (+N)`)와 한 화면 저장소별 구분 메뉴로 관리합니다.
6. **도구 및 설정 마법사 (`v0.5.0`)**: 이미 병합 완료된 작업 브랜치 일괄 정리(`cleanupMergedBranches`), `.gitlane.json` 자동 감지 생성 마법사(IntelliJ `Settings → Tools → GitLane` 포함), `② 작업 반영` 커밋 미리보기(최대 5줄), `--ff-only` 및 Push 거절 시 한국어 복구 안내를 제공합니다.
7. **충돌 가드레일 (`continueMerge` / `abortMerge`)**: 병합 중 충돌이 발생하면 즉시 중단하고, VS Code에서는 **충돌 관리 창(Webview)**, IntelliJ에서는 **네이티브 3-Way Merge 창**을 통해 충돌 해결·남은 대상 이어하기·완료·원복을 지원합니다.

## Monorepo 구조

```text
gitlane/
├── .github/workflows/     # CI 테스트 및 태그 기반 마켓플레이스/릴리스 자동 배포
├── spec/                  # VS Code · IntelliJ 공통 워크플로우 및 설정 스펙
│   ├── workflow-spec.md
│   └── gitlane.schema.json
├── vscode-extension/      # VS Code 확장 (TypeScript, zero runtime deps + 테스트)
├── intellij-plugin/       # IntelliJ Platform Plugin 2.x (Kotlin, JUnit 5 테스트)
├── LICENSE                # MIT License (Copyright (c) 2026 PCK)
└── PUBLISHING.md          # 마켓플레이스 등록 및 자동 배포 가이드
```

## 사전 준비 (공통)

1. **Git CLI**가 `PATH`에 설치되어 있어야 합니다.
2. 확장/플러그인이 비대화형 모드(`GIT_TERMINAL_PROMPT=0`)로 `git`을 실행하므로, 원격 저장소 인증(**SSH 키** 또는 **Git Credential Manager / macOS Keychain**)이 미리 설정되어 있어야 합니다.

## 설치 방법

### 1. VS Code 확장 (`vscode-extension/`)

* **마켓플레이스 설치** *(게시 후)*: VS Code Extensions(`Cmd+Shift+X`)에서 `GitLane Flow` 검색 후 설치 (또는 `code --install-extension pck.gitlane-flow`)
* **로컬 `.vsix` 파일 설치**:
  ```bash
  cd vscode-extension
  npm install
  npm run compile
  npm run package   # gitlane-flow-0.5.0.vsix 생성
  code --install-extension gitlane-flow-0.5.0.vsix
  ```
  또는 VS Code **Extensions** → `...` → **Install from VSIX...** 에서 `.vsix` 파일을 선택합니다.

### 2. IntelliJ IDEA 플러그인 (`intellij-plugin/`)

* **마켓플레이스 설치** *(승인 후)*: **Settings → Plugins → Marketplace**에서 `GitLane` 검색 후 설치
* **로컬 `.zip` 파일 설치**:
  * 요구 환경: **JDK 21**, **IntelliJ IDEA `2024.2+`** (`Git4Idea` 번들 플러그인 활성)
  ```bash
  cd intellij-plugin
  ./gradlew buildPlugin  # build/distributions/gitlane-intellij-0.5.0.zip 생성
  ```
  IntelliJ IDEA **Settings → Plugins → ⚙ → Install Plugin from Disk...** 에서 생성된 `.zip` 파일을 선택하고 IDE를 재시작합니다.

## 저장소별 공통 설정 (`.gitlane.json`)

프로젝트 루트에 `.gitlane.json` 파일을 두면 두 IDE에서 동일한 규칙을 사용합니다 (IDE 설정보다 우선 적용).

```json
{
  "$schema": "./spec/gitlane.schema.json",
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

> **`develop` 없이 `master`(또는 `main`)로 바로 병합**하려면 `.gitlane.json`에 `"useDevelopBranch": false`를 추가하세요 (`"masterBranch": "main"` 등과 함께 사용 가능).

## 개발 빌드 및 테스트

### VS Code 확장
```bash
cd vscode-extension
npm install
npm run compile
npm test
```
* **디버그 실행**: VS Code에서 `vscode-extension` 폴더를 열고 `F5` (Extension Development Host 실행)

### IntelliJ 플러그인
```bash
cd intellij-plugin
./gradlew test          # 단위 및 Git 통합 테스트
./gradlew runIde        # 테스트용 IntelliJ 샌드박스 IDE 실행
./gradlew buildPlugin   # 배포용 .zip 생성
```

## 배포 가이드 및 라이선스

* 마켓플레이스 등록 및 GitHub Actions 자동 배포 방법은 [PUBLISHING.md](./PUBLISHING.md)를 참고하세요.
* License: [MIT](./LICENSE)
