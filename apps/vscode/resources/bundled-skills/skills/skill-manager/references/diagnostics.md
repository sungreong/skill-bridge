# Skill Bridge Diagnostics

Use `Skill Bridge: Check Setup and Repair` or the diagnostic scripts before copying skills when the user reports missing files, permission errors, blocked Git commands, group counts that do not match the UI, npx update problems, or agent folders that do not appear in Skill Bridge.

## Checks

- Operating system and shell information.
- Workspace path exists, is readable, and is writable.
- Central library path exists, is readable, and is writable. If it does not exist, the parent directory must be writable.
- Git and npx are visible on PATH.
- Workspace and Central agent roots are present or can be created by the current user.
- Skill folders on both sides contain `SKILL.md`.
- Skill folders stay under `skills/<skill-name>/...`.
- `.skillbridge/skill-workspace.json` is valid JSON when it exists.
- Group metadata includes the side, targets, and source information needed by current views.
- NPX groups track `repoUrl`, `repoKey`, `lastInstalledAt`, optional `installCwd`, and tracked skill names when available.
- `.skillbridge/SKILL_GROUP.md` can be regenerated from `.skillbridge/skill-workspace.json` for search and agent understanding.

## Default Central Path

Use a user-writable central library by default:

- Windows: `%USERPROFILE%\skill-bridge-repo`
- Linux/macOS: `$HOME/skill-bridge-repo`

Avoid protected locations such as `Program Files`, `/usr`, `/opt`, or shared system folders unless the user explicitly manages permissions there.

## Recovery

If workspace or central paths are not writable, move the central library into the user's home directory and update the Skill Bridge central path setting.

If Git or npx is not found, open a new terminal after installing the tool so PATH is refreshed, then restart VS Code.

If a skill folder is missing `SKILL.md`, do not copy it as a skill. Add the manifest file first or keep the folder outside `skills/`.

If groups appear in the tree but not in `Open Group Overview` or `Open NPX Skill Library`, inspect `.skillbridge/skill-workspace.json` first. Confirm each target is a folder path under `skills/<skill-name>` and that npx-managed groups use `meta.source = "npx"` or `"mixed"`.

If an npx group cannot update, prefer `Open NPX Skill Library` and check that the selected side is correct. Workspace updates should write only Workspace skills, and Central updates should write only Central skills. Cross-side movement still requires `Send Workspace to Central` or `Bring Central to Workspace`.

If `.skillbridge/SKILL_GROUP.md` looks stale, regenerate it from `.skillbridge/skill-workspace.json` using the matching helper script instead of editing it by hand.
