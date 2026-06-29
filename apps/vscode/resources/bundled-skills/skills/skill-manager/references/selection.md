# Skill Selection and Import Guide

Use this reference when a user asks which skills to use, how to bring skills into a workspace, or how to make Skill Bridge easier for agents to operate.

## Decision Matrix

| User intent | Prefer | Why |
| --- | --- | --- |
| "I know the skill I want" | `Download or Update Skill` | Fastest path from Central to one Workspace agent folder. |
| "Set up this kind of project" | `Apply Project Preset` | Presets capture a repeatable starter set. |
| "These skills belong together" | `Open Group Overview` | Groups preserve reusable workflow sets and descriptions. |
| "Compare before copying" | `Open Skill Library` or `Review Sync Changes` | These flows expose status, diffs, warnings, and bulk selection. |
| "Install/update skills from a repo" | `Open NPX Skill Library` | NPX installs are tracked per side with source metadata. |
| "Make agents better at Skill Bridge" | `Download Skill Manager Skill` | Installs this helper skill into the workspace. |
| "Something looks missing or stale" | `Check Setup and Repair` | Diagnose paths, manifests, group metadata, Git, and npx. |

## Recommendation Pattern

When recommending skills, include:

1. The skill or group name.
2. The target agent folder, such as `.codex` or `.agents`.
3. Why it fits the current project or request.
4. Any warning, missing `SKILL.md`, or changed status that should be reviewed.
5. The safest command to use next.

Example:

```text
Use the `frontend-design` skill in `.codex` because this workspace is building UI. Bring it with `Skill Bridge: Download or Update Skill`, then review the transfer plan if the target already exists.
```

## Clarify Before Installing

Ask one concise question before installing anything when:

- The project type is not clear from the repository, README, package files, or visible skill groups.
- No project preset or group clearly matches the user's request.
- Multiple presets or groups are equally plausible.
- The target agent is ambiguous.
- The action would install into `All Agents`.
- The selected skill has `risk`, `changed`, or `missing SKILL.md` status.

Good clarification questions:

- "Which target agent should receive these skills: `.codex`, `.agents`, or another folder?"
- "Is this for frontend work, agent/LangGraph work, documents, QA, or general project setup?"
- "I found multiple matching presets. Should I apply the smaller focused set or the broader default set?"

If the user asks you to decide, use this fallback order:

1. Prefer an existing project preset whose name or description matches the project.
2. Prefer a Central group whose description matches the workflow.
3. Prefer one directly relevant skill over a broad bundle.
4. Prefer the currently used agent folder over `All Agents`.
5. State the assumption before applying the transfer.

## Choosing Target Agents

Choose a specific target agent whenever possible:

- `.codex`: Codex workflows, coding agents, repo automation, OpenAI/Codex-specific instructions.
- `.agents`: shared agent skills intended to be reused across several agent hosts.
- `.claude`: Claude-specific skills or prompts.
- `.cursor`: Cursor-specific coding workflows.
- `.gemini`: Gemini-specific workflows.
- `.antigravity`: Antigravity-specific workflows.

Use `All Agents` only when the user explicitly wants a helper skill installed everywhere or when a skill is intentionally host-neutral and the user confirms broad installation.

## Selecting Skills for a Project

Start from the project need, not from the largest available list.

- For a new project, prefer a project preset if one matches the project type.
- For a focused task, download only the skill that directly supports that task.
- For a repeated workflow, create or reuse a group.
- For public repository skills installed with `npx skills add`, keep using the NPX library so update metadata stays intact.
- For Skill Bridge itself, install `skill-manager` into the agent folder the user actually uses in this workspace.

## Import Strategy

Use the narrowest safe copy operation:

1. One skill to one agent folder.
2. One group to the workspace.
3. One project preset to the workspace.
4. All agents only after explicit confirmation.

When an existing target is present, review the diff or transfer plan before replacing it. If no diff view is available for a direct helper command, warn the user that the target will be overwritten and prefer the Skill Library transfer flow instead.

## Explaining Status

Use status labels in recommendations:

- `same`: already available; no copy needed.
- `new`: exists only on the selected side.
- `changed`: review diff before copying.
- `risk`: inspect warnings first.
- `recent`: useful signal for freshness, not proof of correctness.
- `missing SKILL.md`: do not treat as an installable skill until fixed.

## When to Create Project Presets

Create a project preset when a set should be reused for future projects, such as:

- default Codex workspace setup
- frontend project setup
- LangGraph or Deep Agents setup
- document production setup
- QA/review setup

Presets should stay small enough that a user can understand what will be installed before applying them.

## When to Create Groups

Create a group when skills form a workflow or source bundle that should move together. Groups are good for reusable sets inside Workspace or Central. Use `references/grouping.md` for the exact storage and metadata rules.
