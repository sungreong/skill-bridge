# Skill Bridge

VSCode extension for managing workspace and central skills.

## Build

### Prerequisites

```bash
npm install
```

### Build VSCode Extension only

```bash
npm run build:vscode
# or inside apps/vscode:
cd apps/vscode && npm run build
```

### Build all packages

```bash
npm run build
```

### Watch mode (VSCode extension)

```bash
cd apps/vscode && npm run watch
```

### Package as .vsix

```bash
cd apps/vscode
npx vsce package --no-dependencies
```

> `--no-dependencies` is required because this project is an npm workspace.
> Without it, `vsce` follows workspace symlinks and picks up files outside the extension directory (e.g. `.agents/`, `.claude/`), causing a packaging error.

Output: `apps/vscode/skill-bridge-vscode-<version>.vsix`

### Install .vsix into VSCode

```bash
code --install-extension apps/vscode/skill-bridge-vscode-<version>.vsix
```

Or in VSCode: `Extensions` → `...` → `Install from VSIX...`

> After installing, run `Developer: Reload Window` (`Ctrl+Shift+P`) to apply the new extension.

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
