# Skill Bridge VS Code Extension

Workspace-based skill manager for Claude/Codex/Gemini/Cursor/Antigravity/.agents.

## Commands
- Skill Bridge: Refresh
- Skill Bridge: Promote Selected
- Skill Bridge: Import Selected
- Skill Bridge: Update From Central
- Skill Bridge: Open Diff
- Skill Bridge: Add Skills via NPX
- Skill Bridge: Open Add/Move Wizard
- Skill Bridge: Hydrate Current Project
- Skill Bridge: Create Personal Skill Pack
- Skill Bridge: Set Personal Skill Home
- Skill Bridge: Switch Tree Filter
- Skill Bridge: Rebuild Links

## Personal Skill Home
- If `skillBridge.centralRepoPath` is empty or unset, the extension falls back to `${env:SKILL_BRIDGE_HOME}` and then `${userHome}/skill-bridge-repo`.
- The setting supports `${userHome}`, `${workspaceFolder}`, `${workspaceRoot}`, and `${env:NAME}` variables.
- `Set Personal Skill Home` creates the central structure and stores the chosen folder globally.

## Project Hydration
- `Hydrate Current Project` imports a personal pack or selected central skills into the current workspace.
- Hydration still opens Transfer Manager, so diffs, overwrite review, skipped deletes, and risk hints remain in the normal safety flow.
- Hydrated packs create/update a workspace group named `Pack: <name>` so the project can be refreshed again later.

## Personal Packs
- `Create Personal Skill Pack` saves selected central skills into `.skill-bridge/packs.json` inside the central Skill Home.
- Packs are simple skill-folder lists for recurring project types such as `personal-default`, `frontend-project`, or `langgraph-project`.
- Packs are not auto-sync rules and do not execute skills.

## Add/Move Wizard
- Create a new `skills/<name>/SKILL.md` skeleton in Workspace or Central.
- Hydrate the current project from a personal pack or central skill selection.
- Save central skill selections as reusable personal packs.
- Promote/import one skill asset through Transfer Manager review.
- Copy a skill from one agent folder to another without deleting the source.
- Continue to the existing `npx skills add` flow when installing from a public repo.

## Transfer Review
- Transfer Manager shows rule-based risk hints before copy/import.
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

## Library Manager UX
- View title actions use compact icons; hover or Command Palette shows the full command name.
- Row actions separate intent: `추가/반영` sends the current side to the opposite side, `업데이트/복원` pulls the opposite side into the current side through review, and `삭제` removes only after confirmation.
- Bulk actions support selected update and selected delete from the Workspace/Central panes.
- Keyboard shortcuts: `Ctrl+Alt+L` Library Manager, `Ctrl+Alt+A` Add/Move Wizard, `Ctrl+Alt+H` Hydrate Current Project, `Ctrl+Alt+X` Transfer Explorer, `Ctrl+Alt+F` Tree Filter, `Ctrl+Alt+T` Source Tab.
- Inside Library Manager: `/` focuses search, `R` refreshes, `A` opens Add/Move Wizard, `X` opens Transfer Explorer, `F` toggles changed-only, `1`/`2` jump between Workspace and Central.

## Settings
- skillBridge.centralRepoPath
- skillBridge.autoPush
- skillBridge.defaultAgents
