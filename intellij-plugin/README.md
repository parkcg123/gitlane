# GitLane — IntelliJ IDEA Plugin

VS Code 확장과 동일한 스펙(`../spec/workflow-spec.md`, `.gitlane.json`)을 따르는 IntelliJ Platform 2.x 플러그인입니다.

## 요구 환경

* **JDK 21**
* **IntelliJ IDEA** `2024.2+` (`Git4Idea` 번들 플러그인 활성)

## 주요 구성

* `io.github.parkcg123.gitlane.config.FlowConfig` — `.gitlane.json` 설정 및 유효성 검사 로더
* `io.github.parkcg123.gitlane.naming.BranchNamer` — 로컬 타임존 기반 `YYYYMMDD_작업명` 검증/생성
* `io.github.parkcg123.gitlane.git.GitRunner` — `GIT_TERMINAL_PROMPT=0` 기반 안전한 `git` 실행기
* `io.github.parkcg123.gitlane.workflow.WorkflowEngine` — 사전 가드레일, 병합/배포, 충돌 복구 상태 머신 및 `PersistentStateComponent` 기반 충돌 컨텍스트 저장
* `io.github.parkcg123.gitlane.ui.IntelliJWorkflowUi` — 배경 스레드 안전 다이얼로그 및 IntelliJ 네이티브 3-Way Merge(`AbstractVcsHelper.showMergeDialog`) 연동
* `io.github.parkcg123.gitlane.ui.FlowStatusBarWidgetFactory` — `GitRepository.GIT_REPO_CHANGE` 구독 기반 비동기 상태바 위젯
* `io.github.parkcg123.gitlane.actions.*` — `ProgressManager` (`Task.Backgroundable`) 기반 6개 액션 (`① 작업 시작`, `② 스테이지 반영`, `③ 운영 반영`, `충돌 해결 창 열기`, `충돌 해결 완료`, `머지 취소`)

## 실행, 테스트 및 빌드

```bash
./gradlew test          # 단위 테스트 및 임시 Git 저장소 통합 테스트
./gradlew runIde        # 테스트용 IntelliJ 샌드박스 IDE 실행
./gradlew buildPlugin   # build/distributions/gitlane-intellij-0.1.0.zip 생성
```

## 메뉴 및 UI 위치

* 상단 메뉴: **Tools → GitLane** / **Git(VCS) → GitLane**
* 하단 상태바: `GitLane: develop (스테이지)` / `GitLane: master (운영)` / `GitLane: <브랜치명>` / `GitLane: 머지 충돌 중` (클릭 시 빠른 실행 팝업)
