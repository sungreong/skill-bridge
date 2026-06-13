# Skill Bridge

A lightweight desktop tool and VSCode extension for managing AI agent skills (Claude, Codex, Gemini, Cursor, Antigravity, `.agents`, etc.) across local workspaces and a central Git repository.

## What is this?

When you build useful skills (prompts/commands) in a project's `.claude`, `.codex`, or `.cursor` folder, they stay isolated in that workspace. Skill Bridge lets you:

- **Browse** skills across all your local workspaces in one place
- **Send** a good local skill to a central Git repository
- **Bring** skills from the central repo into any workspace
- **Diff** workspace vs. central versions before syncing
- **Review** skill assets for missing `SKILL.md`, sensitive-looking content, scripts, broken links, and workspace-specific paths
- **Fill** a project from reusable personal skill bundles
- **Track** skill versions without touching the CLI or Git directly

This is not a skill runner, not an auto-sync daemon, and not a Git replacement. It's a **skill asset bridge** for everyday users.

## Current Highlights

- Desktop asset inventory shows workspace and central skill folders, warnings, file counts, and modified state.
- Desktop workspace management includes per-workspace auto-refresh, denser tree controls, group cleanup, and adjustable tree typography.
- VSCode adds a personal central skill folder, project skill filling, personal skill bundles, skill add/move, tree filters, pre-transfer review prompts, and Problems-view quality diagnostics.
- Existing overwrite flows still go through diff review; Skill Bridge does not auto-merge or auto-push without user intent.

## Project Structure

```
skill-bridge/
├── apps/
│   ├── desktop/        # Electron desktop app (Vite + React + TypeScript)
│   └── vscode/         # VSCode extension
├── packages/
│   └── core/           # Shared logic (workspace scanning, Git ops, diff)
├── scripts/
│   └── dev.cjs         # Dev runner
└── tsconfig.base.json
```

## Supported AI Tools

| Tool | Skill Directory |
|------|----------------|
| Claude | `.claude/commands/` |
| Codex | `.codex/` |
| Gemini | `.gemini/` |
| Cursor | `.cursor/rules/` |
| Antigravity | `.antigravity/` |
| Agents | `.agents/` |

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

```bash
npm install
```

### Run Desktop App (Dev)

```bash
npm run dev
```

### Run VSCode Extension (Dev)

```bash
cd apps/vscode && npm run watch
# Then press F5 in VSCode to launch Extension Development Host
```

## Build

### Build all packages

```bash
npm run build
```

### Build VSCode Extension only

```bash
npm run build:vscode
# or
cd apps/vscode && npm run build
```

### Package VSCode Extension as .vsix

```bash
cd apps/vscode
npx vsce package --no-dependencies
```

> `--no-dependencies` is required because this is an npm workspace.
> Without it, `vsce` follows workspace symlinks and picks up unrelated files, causing a packaging error.

Output: `apps/vscode/skill-bridge-vscode-<version>.vsix`

### Install .vsix into VSCode

```bash
code --install-extension apps/vscode/skill-bridge-vscode-<version>.vsix
```

Or in VSCode: `Extensions` → `...` → `Install from VSIX...`

> After installing, run `Developer: Reload Window` (`Ctrl+Shift+P`) to activate.

### Full update flow (build → package → install)

```bash
# 1. Build
npm run build:vscode

# 2. Package
cd apps/vscode && npx vsce package --no-dependencies

# 3. Install
code --install-extension skill-bridge-vscode-<version>.vsix

# 4. Reload VSCode
# Ctrl+Shift+P → Developer: Reload Window
```

## License

MIT
