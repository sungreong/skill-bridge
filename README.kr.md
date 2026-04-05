# Skill Bridge

로컬 워크스페이스의 AI 에이전트 스킬(Claude, Codex, Gemini, Cursor 등)을 중앙 Git 저장소와 연결해 관리하는 경량 데스크톱 도구 및 VSCode 익스텐션입니다.

## 이게 뭔가요?

프로젝트 작업 중 `.claude`, `.codex`, `.cursor` 폴더 안에 만든 유용한 스킬들은 그 워크스페이스 안에만 머물러 있습니다. Skill Bridge를 사용하면:

- **탐색** — 여러 워크스페이스에 흩어진 스킬을 한 화면에서 확인
- **승격** — 괜찮은 로컬 스킬을 중앙 Git 저장소로 올리기
- **반입** — 중앙 저장소의 스킬을 원하는 워크스페이스로 가져오기
- **비교** — 동기화 전에 워크스페이스 버전과 중앙 버전의 차이 확인
- **버전 관리** — CLI나 Git을 직접 다루지 않고도 스킬 이력 추적

스킬 실행기도, 자동 동기화 도구도, Git 대체재도 아닙니다. 일반 사용자를 위한 **스킬 자산화 브리지**입니다.

## 프로젝트 구조

```
skill-bridge/
├── apps/
│   ├── desktop/        # Electron 데스크톱 앱 (Vite + React + TypeScript)
│   └── vscode/         # VSCode 익스텐션
├── packages/
│   └── core/           # 공유 로직 (워크스페이스 스캔, Git 연동, 차이 비교)
├── scripts/
│   └── dev.cjs         # 개발 실행 스크립트
└── tsconfig.base.json
```

## 지원 AI 도구

| 도구 | 스킬 디렉토리 |
|------|--------------|
| Claude | `.claude/commands/` |
| Codex | `.codex/` |
| Gemini | `.gemini/` |
| Cursor | `.cursor/rules/` |
| Antigravity | `.antigravity/` |

## 시작하기

### 사전 요구사항

- Node.js 18 이상
- npm 9 이상

```bash
npm install
```

### 데스크톱 앱 실행 (개발 모드)

```bash
npm run dev
```

### VSCode 익스텐션 실행 (개발 모드)

```bash
cd apps/vscode && npm run watch
# VSCode에서 F5를 눌러 Extension Development Host 실행
```

## 빌드

### 전체 빌드

```bash
npm run build
```

### VSCode 익스텐션만 빌드

```bash
npm run build:vscode
# 또는
cd apps/vscode && npm run build
```

### VSCode 익스텐션 .vsix 패키징

```bash
cd apps/vscode
npx vsce package --no-dependencies
```

> `--no-dependencies` 옵션이 필요합니다. npm workspace 구조 특성상 이 옵션 없이 패키징하면 워크스페이스 심링크를 따라가 불필요한 파일까지 포함되어 오류가 발생합니다.

출력 파일: `apps/vscode/skill-bridge-vscode-<version>.vsix`

### VSCode에 .vsix 설치

```bash
code --install-extension apps/vscode/skill-bridge-vscode-<version>.vsix
```

또는 VSCode에서: `Extensions` → `...` → `Install from VSIX...`

> 설치 후 `Ctrl+Shift+P` → `Developer: Reload Window` 로 적용하세요.

### 전체 업데이트 플로우 (빌드 → 패키징 → 설치)

```bash
# 1. 빌드
npm run build:vscode

# 2. 패키징
cd apps/vscode && npx vsce package --no-dependencies

# 3. 설치
code --install-extension skill-bridge-vscode-<version>.vsix

# 4. VSCode 리로드
# Ctrl+Shift+P → Developer: Reload Window
```

## 라이선스

MIT
