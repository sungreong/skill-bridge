---
name: skill-manager
description: Manage and apply Skill Bridge agent skills between a workspace and a central skill library. Use when users ask to find, choose, download, import, promote, update, copy between agents, organize groups, apply project presets, manage npx-installed skills, install the bundled skill-manager helper, or diagnose Skill Bridge setup for .agents, .codex, .claude, .cursor, .gemini, or .antigravity skill folders.
---

# Skill Manager

Use this skill to help a user operate Skill Bridge, especially when they need to choose useful skills and bring them into the current workspace. Prefer Skill Bridge UI commands over hand-editing files unless the host does not expose the command or the user explicitly asks for file-level work.

## Product Scope

Skill Bridge is a skill asset bridge. It copies, reviews, groups, and records skill folders between Workspace and Central. It does not execute skills, auto-merge conflicts, replace Git, or push remotes automatically.

Only manage complete skill folders under `skills/<skill-name>/...`. Preserve nested `references/`, `scripts/`, and `assets/`. Do not write outside the selected workspace or central roots.

## Workspace Metadata

Before choosing, grouping, importing, promoting, or diagnosing skills, inspect the current workspace's `.skillbridge/` folder when it exists. Treat `.skillbridge/skill-workspace.json`, `.skillbridge/SKILL_GROUP.md`, and `.skillbridge/skills-lock.json` as Skill Bridge metadata for this workspace.

Use that metadata to understand existing groups, mirrored sources, npx-installed skill sets, and lock information. Do not edit generated `.skillbridge/SKILL_GROUP.md` by hand; update Skill Bridge group data through commands or `.skillbridge/skill-workspace.json`, then regenerate the markdown.

## Supported Layouts

Workspace roots:

- `.agents/skills/<skill-name>/SKILL.md`
- `.codex/skills/<skill-name>/SKILL.md`
- `.claude/skills/<skill-name>/SKILL.md`
- `.cursor/skills/<skill-name>/SKILL.md`
- `.gemini/skills/<skill-name>/SKILL.md`
- `.antigravity/skills/<skill-name>/SKILL.md`

Central roots:

- `agents/skills/<skill-name>/SKILL.md`
- `codex/skills/<skill-name>/SKILL.md`
- `claude/skills/<skill-name>/SKILL.md`
- `cursor/skills/<skill-name>/SKILL.md`
- `gemini/skills/<skill-name>/SKILL.md`
- `antigravity/skills/<skill-name>/SKILL.md`

## First Move

1. Confirm the active workspace and Central Skill Home.
2. Identify the user's intent:
   - Choose skills for this project.
   - Bring one or more Central skills into Workspace.
   - Send good Workspace skills to Central.
   - Apply a project preset.
   - Manage a reusable group.
   - Update or manage npx-installed skills.
   - Diagnose missing paths, stale groups, or setup errors.
3. Search and inspect before copying. Use skill descriptions, status, warnings, file counts, and group metadata to explain why a skill or set is a good fit.
4. If the project need, target agent, or matching skill set is unclear, ask one concise clarification before installing anything. If the user wants you to proceed anyway, choose the narrowest reasonable default and state the assumption.
5. Use the smallest safe action. Prefer one target agent unless the user explicitly wants every configured agent.
6. Review diffs or transfer plans before replacing existing files.

## Command Router

Use these commands when available:

- `Skill Bridge: Open Skill Library`: primary place to compare Workspace and Central, filter by status, inspect details, select multiple skills, and send or bring assets.
- `Skill Bridge: Download or Update Skill`: quick flow for searching Central and applying one skill to a Workspace agent folder.
- `Skill Bridge: Apply Project Preset`: apply a saved Central preset or manually selected Central skills to the current workspace.
- `Skill Bridge: Open Project Presets`: review, edit, rename, apply, or delete reusable project presets.
- `Skill Bridge: Create Project Preset`: save selected Central or Workspace-derived skills as a reusable project starter set.
- `Skill Bridge: Open Group Overview`: manage reusable groups, descriptions, membership, source metadata, and group-level send/bring.
- `Skill Bridge: Open NPX Skill Library`: update, inspect, open, or delete skills installed through `npx skills add`.
- `Skill Bridge: Download Skill Manager Skill`: install this bundled helper skill into the current workspace.
- `Skill Bridge: Copy Between Agents`: copy a skill from one supported agent folder to another without deleting the source.
- `Skill Bridge: Review Sync Changes`: compare both sides before applying changed files.
- `Skill Bridge: Check Setup and Repair`: diagnose paths, manifests, tool availability, and group metadata.

Treat commands with `sync` in their title as explicit review/apply flows, not background automation. Keep Git commit and push as separate user-requested actions.

## Choosing Skills

When the user asks what to install or which skills belong in a project, read `references/selection.md`. It explains how to choose between individual skills, project presets, groups, npx libraries, and the bundled helper.

Short version:

- Use individual download for a known skill.
- Use project presets for recurring project types.
- Use groups for workflow sets that should move together.
- Use npx library tools for skills originally installed from a repo.
- Use `All Agents` only for intentionally shared helper skills; otherwise choose the specific target agent.
- Ask before installing when no clear match exists, when several equally plausible matches exist, or when the target agent cannot be inferred.

## Bundled Resources

Read these references only when they match the task:

- `references/selection.md`: skill choice, import strategy, target-agent selection, and user-facing recommendation patterns.
- `references/grouping.md`: group rules, `.skillbridge/skill-workspace.json`, `.skillbridge/SKILL_GROUP.md`, and npx group metadata.
- `references/diagnostics.md`: setup checks, recovery steps, writable paths, missing `SKILL.md`, and stale group recovery.

Use these scripts when UI commands are unavailable or the user asks for scriptable operation:

- Windows diagnostics: `scripts/diagnose-skill-bridge.ps1`
- Linux/macOS diagnostics: `scripts/diagnose-skill-bridge.sh`
- Windows copy helper: `scripts/copy-skill.ps1`
- Linux/macOS copy helper: `scripts/copy-skill.sh`
- Windows group summary helper: `scripts/update-skill-groups.ps1`
- Linux/macOS group summary helper: `scripts/update-skill-groups.sh`

## Safety Rules

- Require `SKILL.md` in every managed skill folder.
- Preserve complete skill folders, not just `SKILL.md`.
- Do not auto-push Git remotes.
- Do not auto-merge conflicting changes.
- Do not treat npx update as cross-side sync. Workspace and Central npx libraries are managed independently unless the user explicitly asks to send or bring skills.
- Do not choose `All Agents` as a default. Ask for or infer a specific target agent from the project context.
- Prefer user-writable Central paths such as `${HOME}/skill-bridge-repo`.
- Report clear, user-readable errors when files, folders, commands, or manifests are missing.
