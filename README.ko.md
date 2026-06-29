# Skill Bridge

Skill Bridge는 로컬 워크스페이스의 AI 에이전트 스킬 자산을 중앙 Git 기반 스킬 라이브러리와 연결해 관리하는 VS Code 익스텐션입니다.

좋은 스킬을 프로젝트마다 다시 만들거나 폴더를 수동 복사하지 않아도 됩니다. Workspace에서 만든 스킬을 Central 라이브러리에 보관하고, 필요한 프로젝트로 다시 가져오는 흐름을 한 화면에서 검토합니다.

**핵심은 세 가지입니다.**

- **찾기:** Workspace와 Central에 있는 스킬, 그룹, 프리셋을 한 번에 봅니다.
- **검토하기:** 덮어쓰기 전 변경 파일, 위험 힌트, diff를 확인합니다.
- **가져오기:** 선택한 스킬 묶음이나 Project Preset을 현재 프로젝트에 적용합니다.
- **에이전트로 갱신하기:** 내장 Skill Manager 스킬을 설치해 AI 에이전트가 Central에서 필요한 스킬을 찾고, 가져오고, 나중에 업데이트하도록 도울 수 있습니다.

![Workspace와 Central 스킬을 나란히 비교하는 Skill Bridge 화면](apps/vscode/resources/screenshots/skill-library-compare.png)

_Workspace와 Central을 나란히 비교해 어떤 스킬을 보내거나 가져올지 먼저 판단합니다._

## 왜 필요한가요?

AI 에이전트 스킬은 프로젝트를 거치며 계속 좋아집니다. 하지만 좋은 스킬을 복사해 두지 않으면 다음 프로젝트에서 다시 찾기 어렵고, 반대로 무작정 덮어쓰면 기존 작업을 잃을 수 있습니다.

Skill Bridge는 스킬을 실행하거나 자동 병합하지 않습니다. 대신 **스킬을 자산으로 관리하는 브리지** 역할에 집중합니다. 사용자는 Workspace에만 있는 스킬, Central에 이미 있는 스킬, 변경된 스킬, 다시 가져올 수 있는 스킬을 파일 이동 전에 확인합니다.

확장에는 **Skill Manager** 스킬이 함께 포함되어 있습니다. 이 스킬을 Workspace에 설치하면 AI 에이전트에게 “중앙 라이브러리에서 이 프로젝트에 필요한 스킬을 찾아서 가져와줘”, “이미 가져온 스킬을 최신 상태로 업데이트해줘”처럼 요청할 수 있습니다. 적용 대상은 `.agents`, `.codex`, `.claude`, `.gemini`, `.cursor`, `.antigravity` 스킬 폴더이며, 실제 파일 이동은 Skill Bridge의 검토 흐름을 거칩니다.

| 다운로드 가능한 스킬 | 재사용 그룹 | 프로젝트 프리셋 |
| --- | --- | --- |
| ![재사용 가능한 스킬 팩을 다운로드하고 업데이트하는 NPX Skill Library 화면](apps/vscode/resources/screenshots/npx-skill-library.png) | ![재사용 가능한 스킬 그룹을 관리하는 Group Overview 화면](apps/vscode/resources/screenshots/group-overview.png) | ![프로젝트 프리셋을 선택하고 Workspace에 적용하는 Project Presets 화면](apps/vscode/resources/screenshots/project-presets.png) |

_외부 스킬 팩, 직접 만든 그룹, 프로젝트별 프리셋을 Central 라이브러리 기준으로 정리합니다._

## 예시: 이 프로젝트에 맞는 스킬 가져오기

> "필요한 스킬을 다운로드하고, 이 프로젝트에 맞는 스킬을 가져와줘."

Skill Bridge는 이 요청을 검토 가능한 흐름으로 바꿉니다.

1. **Skill Library**에서 Central과 Workspace의 스킬 상태를 비교합니다.
2. **NPX Skill Library**에서 재사용 가능한 스킬 팩을 다운로드하거나 업데이트합니다.
3. **Project Presets**에서 프로젝트에 맞는 스킬 묶음을 고릅니다.
4. **Transfer Review**에서 새 파일, 변경 파일, 위험 힌트, 예상 결과를 확인한 뒤 적용합니다.
5. 적용 결과는 `Preset: <name>` 그룹으로 남아 나중에 다시 갱신할 수 있습니다.

![전송 전에 변경 파일과 위험 힌트를 확인하는 Transfer Review 화면](apps/vscode/resources/screenshots/transfer.png)

_새 파일과 변경 파일을 분리해 보여주고, 적용 전 마지막 확인 지점을 제공합니다._

## 무엇을 하나요?

- Claude, Codex, Gemini, Cursor, Antigravity, `.agents` 스킬을 Workspace와 Central 양쪽에서 탐색합니다.
- Workspace 스킬을 Central로 보내기 전에 변경 사항을 검토합니다.
- Central 스킬을 Workspace로 가져오기 전에 변경 사항을 검토합니다.
- Workspace와 Central 버전을 비교합니다.
- 재사용 가능한 스킬 그룹을 관리합니다.
- Project Preset으로 반복되는 프로젝트 초기 구성을 저장하고 적용합니다.
- 내장 Skill Manager 스킬을 설치해 AI 에이전트가 Central 스킬 검색, 가져오기, 그룹 구성, 업데이트를 돕게 합니다.
- `SKILL.md` 누락, 민감정보 의심 문자열, 스크립트, 깨진 링크, 워크스페이스 전용 경로를 진단합니다.
- 처음 설치한 사용자는 핵심 도구만 보고, 필요한 사용자는 Quick Tools를 직접 구성할 수 있습니다.

Skill Bridge는 스킬 실행기, Git GUI, 자동 병합 도구가 아닙니다. 스킬 파일을 안전하게 자산화하고 이동시키는 브리지입니다.

## 현재 주요 기능 한눈에 보기

| 기능 | 핵심 가치 |
| --- | --- |
| 양쪽 트리 | Workspace Skills와 Central Skills를 같은 뷰에서 비교합니다. |
| 전송 전 검토 | Central로 보내기와 Workspace로 가져오기 전에 변경 파일 덮어쓰기를 확인합니다. |
| Project Preset | 반복되는 프로젝트 구성을 `.skillbridge/project-presets.json`에 저장하고 다시 적용합니다. |
| 내장 Skill Manager | AI 에이전트가 Central에서 필요한 스킬을 찾아 가져오고 업데이트하는 흐름을 돕습니다. |
| Quick Tools 관리 | 처음에는 핵심 도구만 보이고, 필요한 명령은 사용자가 직접 켭니다. |
| Multi-agent 보기 | 여러 agent를 동시에 선택해 같은 기준으로 스킬을 관리합니다. |
| 품질 진단 | 실행 가능한 경고를 VS Code Problems 뷰에 표시합니다. |
| Agent 지침 파일 | `AGENTS.md` 같은 지침 파일은 스킬 전송 대상과 분리해 보여줍니다. |
| Central 중심 저장 | 그룹과 프리셋은 설정된 Central 라이브러리 폴더에 저장됩니다. |

## 지원 레이아웃

Skill Bridge는 각 agent를 동일한 구조의 스킬 저장소로 취급합니다.

| Agent | Workspace root | Central root | Skill folder |
| --- | --- | --- | --- |
| Claude | `.claude/` | `claude/` | `skills/<skill-name>/SKILL.md` |
| Codex | `.codex/` | `codex/` | `skills/<skill-name>/SKILL.md` |
| Gemini | `.gemini/` | `gemini/` | `skills/<skill-name>/SKILL.md` |
| Cursor | `.cursor/` | `cursor/` | `skills/<skill-name>/SKILL.md` |
| Antigravity | `.antigravity/` | `antigravity/` | `skills/<skill-name>/SKILL.md` |
| Agents | `.agents/` | `agents/` | `skills/<skill-name>/SKILL.md` |

스킬로 전송되는 범위는 `skills/<skill-name>/...` 아래 파일입니다.

## 주요 사용 흐름

### Workspace 스킬을 Central로 보내기

`Central로 보내기` 또는 `동기화 변경 검토`를 사용해 Workspace 변경 사항을 검토한 뒤 Central 라이브러리로 복사합니다.

기존 파일 변경은 diff 검토를 거칩니다. 새 파일은 검토 후 바로 복사할 수 있습니다. Skill Bridge는 Git remote push를 자동 실행하지 않습니다.

### Central 스킬을 Workspace로 가져오기

`Workspace로 가져오기`, `스킬 다운로드 또는 업데이트`, `Project Preset 적용`을 사용해 Central 스킬을 현재 Workspace로 가져옵니다.

### Project Preset 만들기와 적용

Project Preset은 Central 전용의 재사용 프로젝트 구성 템플릿입니다.

- 선택한 Central 스킬로 생성
- 현재 Workspace로 생성
- Workspace 그룹을 Preset으로 내보내기
- Preset을 적용해 Central 스킬을 Workspace에 설치
- Project Presets Overview에서 검색, 편집, 저장, 삭제

Preset을 적용하면 Workspace에 `Preset: <name>` 그룹으로 결과가 남습니다.

### Quick Tools 관리

기본 상태의 Quick Tools는 핵심 명령만 표시합니다. `빠른 도구 관리`에서 트리에 보일 명령을 체크할 수 있습니다.

선택값은 `skillBridge.visibleQuickTools`에 저장되고 VS Code를 다시 열어도 유지됩니다.

### Agent View 전환

`에이전트 보기 전환`에서 하나 이상의 agent를 선택해 동시에 볼 수 있습니다. 전체 선택 또는 미선택은 `All`로 처리합니다.

선택값은 `skillBridge.visibleAgents`에 저장됩니다.

## 설정

| 설정 | 설명 |
| --- | --- |
| `skillBridge.centralRepoPath` | Central 스킬 라이브러리 경로입니다. `${userHome}`, `${workspaceFolder}`, `${workspaceRoot}`, `${env:NAME}` 변수를 지원합니다. |
| `skillBridge.defaultAgents` | Skill Bridge가 관리할 agent 목록입니다. |
| `skillBridge.visibleAgents` | 트리에 표시할 agent 목록입니다. 비어 있으면 전체를 표시합니다. |
| `skillBridge.visibleQuickTools` | Quick Tools에 표시할 명령 목록입니다. 비어 있으면 기본 핵심 도구 세트를 표시합니다. |
| `skillBridge.language` | UI 언어입니다. `en` 또는 `ko`를 사용합니다. |
| `skillBridge.autoSyncWorkspaceAgents` | 변경된 스킬 폴더를 Central로 자동 sync할 Workspace agent 목록입니다. |

## 프로젝트 구조

```text
skill-bridge/
├── apps/
│   └── vscode/         # VS Code extension
├── packages/
│   └── core/           # 공유 core 로직
├── AGENTS.md           # AI agent 작업 규칙
├── PLAN.md             # 제품/UX 계획
└── tsconfig.base.json
```

## 개발

### 사전 요구사항

- Node.js 18 이상
- npm 9 이상

```bash
npm install
```

### 개발 모드 실행

```bash
npm run dev
```

VS Code extension watcher만 실행하려면:

```bash
cd apps/vscode
npm run watch
```

그 다음 VS Code에서 `F5`를 눌러 Extension Development Host를 실행합니다.

## 빌드와 패키징

```bash
npm run typecheck
npm run build:vscode
npm --workspace apps/vscode run package:vsix
```

VSIX 출력 위치:

```text
apps/vscode/skill-bridge-vscode-<version>.vsix
```

설치:

```bash
code --install-extension apps/vscode/skill-bridge-vscode-<version>.vsix --force
```

설치 후 VS Code에서 `Developer: Reload Window`를 실행하세요.

## 라이선스

MIT
