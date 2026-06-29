# Skill Grouping

Groups are reusable sets of skill folders. Use them to manage skills that should usually be downloaded, promoted, reviewed, or searched together.

## When to Create a Group

Create or suggest a group when one of these is true:

- The user explicitly asks to group skills.
- Several skills share a domain, workflow, or project role.
- Skill names or `SKILL.md` descriptions show a clear pattern such as design, LangGraph, documents, QA, diagnostics, onboarding, or UI polish.
- A repository import brings multiple related skills from the same source.

Do not group unrelated skills only because they live in the same agent folder.

## Group Storage

Skill Bridge stores groups in `.skillbridge/skill-workspace.json`.

Each group target should be a folder target:

```json
{
  "kind": "folder",
  "tool": "claude",
  "relativePath": "skills/example-skill"
}
```

The app also generates `.skillbridge/SKILL_GROUP.md` beside the group JSON. This Markdown file is for search and agent understanding. Treat it as generated output.

## Commands

Use these commands when available:

- `Skill Bridge: Open Group Overview`
- `Skill Bridge: Open Skill Library`
- `Skill Bridge: Create Workspace Group`
- `Skill Bridge: Create Central Group`
- `Skill Bridge: Add to Group`
- `Skill Bridge: Bring Group to Workspace`
- `Skill Bridge: Send Group to Central`
- `Skill Bridge: Open NPX Skill Library`

If a command is not available in the current host, update `.skillbridge/skill-workspace.json` and run the matching helper:

- Windows: `scripts/update-skill-groups.ps1 -Root <workspace-or-central-root>`
- Linux/macOS: `scripts/update-skill-groups.sh --root <workspace-or-central-root>`

## Search Notes

`.skillbridge/SKILL_GROUP.md` includes group names, side, agents, metadata, and target skill paths. Search tools can use it to answer questions such as:

- Which skills are part of the design group?
- Which Central group came from a GitHub repository?
- Which groups should be downloaded together for this workspace?

## Current UI Model

Use `Open Skill Library` when deciding which individual skills should move between Workspace and Central. It separates send and bring flows and supports filtering, multi-select, and detail views.

Use `Open Group Overview` when the task is group-level: edit group descriptions, add or remove skill folders, send/bring a whole group, mirror group metadata only, or inspect source and sync status.

Use side-specific language when explaining actions:

- Workspace groups describe what exists in the current project and can be sent to Central.
- Central groups describe reusable library assets and can be brought into the Workspace.
- Group metadata can exist on both sides even when file contents are already the same.

Use `Open NPX Skill Library` when the group came from `npx skills add`. NPX groups are managed per side:

- Workspace npx groups update only Workspace files.
- Central npx groups update only Central files.
- Cross-side movement still requires an explicit send/bring action.
- Deleting an npx group removes both the tracked skill folders and the tracking group after confirmation.

## Group Metadata

Manual groups usually have `meta.source = "manual"` or no source.

NPX groups should track:

- `meta.source`: `npx` or `mixed`
- `meta.repoKey`
- `meta.repoUrl`
- `meta.lastInstalledAt`
- optional `meta.installCwd`
- optional `meta.installSkills`

Use `mixed` when an npx-origin group has been manually edited.
