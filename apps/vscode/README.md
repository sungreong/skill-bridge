# Skill Bridge VS Code Extension

Workspace-based skill manager for Claude/Codex/Gemini/Cursor/Antigravity/.agents.

## Agent Instructions
- Workspace tree shows root instruction files such as `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `GEMINI.md`, `CURSOR.md`, and supported rule files such as `.cursor/rules/*.mdc`.
- Central tree shows matching profile files from `instructions/<workspace-folder-name>/`.
- Instruction files are displayed and opened separately from skill transfer targets, so existing skill Promote/Import flows remain scoped to `skills/<skill>/...`.

## Commands
- Skill Bridge: Refresh
- Skill Bridge: Central로 보내기
- Skill Bridge: Workspace로 가져오기
- Skill Bridge: 변경 비교/반영 열기
- Skill Bridge: Open Diff
- Skill Bridge: Add Skills via NPX
- Skill Bridge: 스킬 추가/이동 열기
- Skill Bridge: 현재 프로젝트에 스킬 채우기
- Skill Bridge: 개인 스킬 묶음 만들기
- Skill Bridge: 개인 중앙 스킬 폴더 설정
- Skill Bridge: Switch Tree Filter
- Skill Bridge: Rebuild Links

## 개인 중앙 스킬 폴더
- If `skillBridge.centralRepoPath` is empty or unset, the extension falls back to `${env:SKILL_BRIDGE_HOME}` and then `${userHome}/skill-bridge-repo`.
- The setting supports `${userHome}`, `${workspaceFolder}`, `${workspaceRoot}`, and `${env:NAME}` variables.
- `개인 중앙 스킬 폴더 설정` creates the central structure and stores the chosen folder globally.
- `개인 중앙 스킬 폴더 초기화` forces the extension default `${userHome}/skill-bridge-repo`, refreshes the trees, and reports how many central skills/groups remain after group normalization.
- Workspace groups are stored in the current workspace's `skill_workspace.json`.
- Central groups are stored in the central skill folder's `skill_workspace.json`, so every project using the same central folder sees the same Central groups.
- Existing project-local Central groups are migrated to the central folder the first time the extension opens a central folder that does not yet have a group file.

## 프로젝트에 스킬 채우기
- `현재 프로젝트에 스킬 채우기` imports a personal pack or selected central skills into the current workspace.
- This flow still opens 전송 전 검토, so diffs, overwrite review, skipped deletes, and risk hints remain in the normal safety flow.
- Applied skill bundles create/update a workspace group named `Pack: <name>` so the project can be refreshed again later.

## 개인 스킬 묶음
- `개인 스킬 묶음 만들기` saves selected central skills into `.skill-bridge/packs.json` inside the central skill folder.
- Packs are simple skill-folder lists for recurring project types such as `personal-default`, `frontend-project`, or `langgraph-project`.
- Packs are not auto-sync rules and do not execute skills.

## 스킬 추가/이동
- Create a new `skills/<name>/SKILL.md` skeleton in Workspace or Central.
- Fill the current project from a personal skill bundle or central skill selection.
- Save central skill selections as reusable personal packs.
- Send one Workspace skill to Central, or bring one Central skill into Workspace, through 전송 전 검토.
- Copy a skill from one agent folder to another without deleting the source.
- Continue to the existing `npx skills add` flow when installing from a public repo.

## 전송 전 검토
- 전송 전 검토 shows rule-based risk hints before copying between Workspace and Central.
- Use "AI 검토 프롬프트 복사" to copy a selected-item review prompt for another agent without file contents or absolute paths.
- Skill summaries now show new/modified/delete/type-conflict status with apply/inspect/skip recommendations.

## Tree Filters
- Filter by all, changed, new, risk, missing `SKILL.md`, or recent skill assets.
- Skill folders show warning counts and file counts so the tree stays asset-centered.

## Workspace Quality Gate
- Skill Bridge maps actionable workspace asset warnings into the native VS Code Problems view.
- `sensitive-content` is surfaced as an error; missing `SKILL.md`, workspace-specific paths, script files, and broken references are surfaced as warnings or info.
- A compact shield status bar item appears only when workspace errors or warnings exist, and opens the Problems view when clicked.
- This checks skill asset structure and metadata contracts. It is not a code linter, skill runner, automatic sync tool, or auto-fixer.

## 스킬 보관함 UX
- View title actions use compact icons; hover or Command Palette shows the full command name.
- Row actions separate intent: `추가/반영` sends the current side to the opposite side, `변경 가져오기/복원` pulls the opposite side into the current side through review, and `삭제` removes only after confirmation.
- Bulk actions support selected change import and selected delete from the Workspace/Central panes.
- Keyboard shortcuts: `Ctrl+Alt+L` 스킬 보관함, `Ctrl+Alt+A` 스킬 추가/이동, `Ctrl+Alt+H` 프로젝트에 스킬 채우기, `Ctrl+Alt+X` 변경 비교/반영, `Ctrl+Alt+F` Tree Filter, `Ctrl+Alt+T` Source Tab.
- Inside 스킬 보관함: `/` focuses search, `R` refreshes, `A` opens 스킬 추가/이동, `X` opens 변경 비교/반영, `F` toggles changed-only, `1`/`2` jump between Workspace and Central.

## Settings
- skillBridge.centralRepoPath
- skillBridge.autoPush
- skillBridge.defaultAgents
