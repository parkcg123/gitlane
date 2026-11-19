# GitLane — 마켓플레이스 배포 가이드

이 문서는 **VS Code (Visual Studio Marketplace + Open VSX)** 와 **IntelliJ IDEA (JetBrains Marketplace)** 에 `gitlane`을 최초 등록하고, 이후 GitHub Actions 태그 푸시(`v*`)로 자동 배포하는 절차를 정리합니다.

---

## 1. GitHub 저장소 업로드

현재 로컬 작업 디렉터리를 `https://github.com/parkcg123/gitlane` 저장소에 푸시합니다.

```bash
cd gitlane   # (로컬 폴더명 변경 시)
git init
git add .
git commit -m "chore: prepare marketplace publishing for VS Code and IntelliJ plugins"
git branch -M main
git remote add origin https://github.com/parkcg123/gitlane.git
git push -u origin main
```

---

## 2. Visual Studio Marketplace 등록 (VS Code 공식)

1. [Visual Studio Marketplace Manage](https://marketplace.visualstudio.com/manage)에 Microsoft/GitHub 계정으로 로그인하고 Publisher ID **`pck`** 를 생성합니다.
   > **참고**: `pck`가 이미 다른 사용자에게 선점되어 있다면 원하는 ID(예: `parkcg123` 또는 `pck-dev`)로 Publisher를 만든 뒤, `vscode-extension/package.json`의 `"publisher"` 값도 동일하게 수정하세요.
2. [Azure DevOps](https://dev.azure.com) 접속 → 우측 상단 사용자 설정 → **Personal access tokens** → **New Token** 생성:
   * **Organization**: `All accessible organizations`
   * **Scopes**: `Custom defined` → **Marketplace** → **`Manage`** 체크
3. 생성된 토큰을 복사해 둡니다 (`VSCE_PAT`).
4. 로컬에서 1회 수동 배포 테스트(선택):
   ```bash
   cd vscode-extension
   npm run compile
   npm run package
   npx @vscode/vsce publish -p <VSCE_PAT>
   ```

---

## 3. Open VSX Registry 등록 (Cursor / Windsurf 등 지원)

1. [open-vsx.org](https://open-vsx.org)에 GitHub 계정으로 로그인합니다.
2. 프로필 설정에서 **Eclipse Contributor Agreement (ECA)** 서명을 완료합니다.
3. Access Token 페이지에서 새 토큰을 발급합니다 (`OVSX_PAT`).
4. 사용하는 Publisher 네임스페이스를 생성합니다 (최초 1회):
   ```bash
   cd vscode-extension
   npx ovsx create-namespace pck -p <OVSX_PAT>
   npx ovsx publish gitlane-0.1.0.vsix -p <OVSX_PAT>
   ```
   > `package.json`의 `"publisher"`를 다른 ID로 바꿨다면 `create-namespace` 이름도 똑같이 맞춰 주세요.

---

## 4. JetBrains Marketplace 등록 (IntelliJ IDEA 공식)

JetBrains Marketplace는 **최초 1회 웹 업로드를 통한 심사**가 필수이며, 승인 이후부터 CLI/CI(`publishPlugin`) 자동 배포가 가능합니다.

1. 로컬(또는 GitHub Actions CI 아티팩트)에서 플러그인 `.zip`을 준비합니다:
   ```bash
   cd intellij-plugin
   ./gradlew buildPlugin
   # 결과물: intellij-plugin/build/distributions/gitlane-intellij-0.1.0.zip
   ```
2. [JetBrains Marketplace](https://plugins.jetbrains.com)에 JetBrains 계정으로 로그인 → **Upload Plugin** 선택:
   * `gitlane-intellij-0.1.0.zip` 업로드
   * 라이선스: **MIT**, 카테고리: **Version Control Systems** / **Git**, 소스 저장소: `https://github.com/parkcg123/gitlane` 입력 후 제출
   * 최초 심사는 보통 **1~3영업일** 소요됩니다.
3. 승인 완료 후 JetBrains Marketplace 프로필 → **My Tokens** → **Generate New Token**으로 배포 토큰을 발급합니다 (`JETBRAINS_MARKETPLACE_TOKEN`).
4. *(선택)* JetBrains 플러그인 서명이 필요한 경우 `CERTIFICATE_CHAIN`, `PRIVATE_KEY`, `PRIVATE_KEY_PASSWORD` 환경변수를 설정해 `./gradlew signPlugin`을 실행할 수 있도록 `build.gradle.kts`에 이미 구성되어 있습니다.

---

## 5. GitHub Actions 자동 배포 설정

GitHub 저장소 **Settings → Secrets and variables → Actions → New repository secret** 에 발급받은 토큰을 등록합니다.

| Secret 이름 | 설명 | 필수 여부 |
| :--- | :--- | :---: |
| `VSCE_PAT` | Azure DevOps Marketplace Manage 토큰 | VS Code 마켓 배포 시 |
| `OVSX_PAT` | Open VSX Access Token | Open VSX 배포 시 |
| `JETBRAINS_MARKETPLACE_TOKEN` | JetBrains Marketplace 토큰 (최초 승인 후 발급) | IntelliJ 마켓 자동 배포 시 |

> 등록되지 않은 Secret의 배포 스텝은 자동으로 건너뛰며, GitHub Release(`.vsix` / `.zip` 첨부)는 항상 정상 생성됩니다.

### 새 버전 릴리스 절차

1. `vscode-extension/package.json` (`version`), `vscode-extension/CHANGELOG.md`, `intellij-plugin/gradle.properties` (`pluginVersion`), `intellij-plugin/src/main/resources/META-INF/plugin.xml` (`<change-notes>`) 버전을 올립니다.
2. 커밋 후 버전 태그를 푸시합니다:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. `.github/workflows/release.yml` 워크플로우가 테스트, 패키징, 마켓플레이스 게시, GitHub Release 업로드를 자동으로 수행합니다.
