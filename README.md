# Skill Bridge

A lightweight desktop tool and VSCode extension for managing AI agent skills (Claude, Codex, Gemini, Cursor, etc.) across local workspaces and a central Git repository.

## What is this?

When you build useful skills (prompts/commands) in a project's `.claude`, `.codex`, or `.cursor` folder, they stay isolated in that workspace. Skill Bridge lets you:

- **Browse** skills across all your local workspaces in one place
- **Promote** a good local skill to a central Git repository
- **Pull** skills from the central repo into any workspace
- **Diff** workspace vs. central versions before syncing
- **Track** skill versions without touching the CLI or Git directly

This is not a skill runner, not an auto-sync daemon, and not a Git replacement. It's a **skill asset bridge** for everyday users.

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
