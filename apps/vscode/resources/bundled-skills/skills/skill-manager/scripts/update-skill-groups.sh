#!/usr/bin/env bash
set -euo pipefail

root="$(pwd)"
group_json=""
output=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      root="$2"
      shift 2
      ;;
    --group-json)
      group_json="$2"
      shift 2
      ;;
    --output)
      output="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: update-skill-groups.sh [--root PATH] [--group-json PATH] [--output PATH]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$group_json" ]]; then
  group_json="$root/.skillbridge/skill-workspace.json"
  legacy_group_json="$root/skill_workspace.json"
  if [[ ! -f "$group_json" && -f "$legacy_group_json" ]]; then
    group_json="$legacy_group_json"
  fi
fi
if [[ -z "$output" ]]; then
  output="$root/.skillbridge/SKILL_GROUP.md"
fi

if command -v node >/dev/null 2>&1; then
  node - "$group_json" "$output" <<'NODE'
const fs = require("fs");
const path = require("path");

const groupJson = process.argv[2];
const output = process.argv[3];

function readPayload(file) {
  if (!fs.existsSync(file)) return { version: 2, groups: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return { version: parsed.version || 2, groups: Array.isArray(parsed.groups) ? parsed.groups : [] };
}

function text(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function code(value) {
  return String(value ?? "").replace(/`/g, "\\`");
}

function tableCode(value) {
  return code(value).replace(/\|/g, "\\|");
}

const payload = readPayload(groupJson);
const groups = payload.groups;
const lines = [
  "# Skill Groups",
  "",
  "This file is generated from `.skillbridge/skill-workspace.json` so agents and search tools can discover how skills are grouped.",
  "",
  "## Summary",
  "",
  `- Groups: ${groups.length}`,
  `- Workspace groups: ${groups.filter((group) => group.side === "workspace").length}`,
  `- Central groups: ${groups.filter((group) => group.side === "central").length}`,
  ""
];

if (groups.length === 0) {
  lines.push("No skill groups are defined yet.", "");
} else {
  for (const group of [...groups].sort((a, b) => String(a.side).localeCompare(String(b.side)) || String(a.name).localeCompare(String(b.name)))) {
    const targets = Array.isArray(group.targets) ? group.targets : [];
    const tools = [...new Set(targets.map((target) => target.tool).filter(Boolean))].sort();
    lines.push(`## ${text(group.name)}`);
    lines.push("");
    lines.push(`- ID: \`${code(group.id)}\``);
    lines.push(`- Side: \`${code(group.side)}\``);
    lines.push(`- Targets: ${targets.length}`);
    lines.push(`- Agents: ${tools.map((tool) => `\`${code(tool)}\``).join(", ") || "-"}`);
    if (group.meta && typeof group.meta === "object") {
      lines.push("- Metadata:");
      for (const key of ["source", "repoKey", "repoUrl", "lastInstalledAt", "mirroredFrom"]) {
        if (group.meta[key]) lines.push(`  - ${key}: ${group.meta[key]}`);
      }
    }
    lines.push("");
    lines.push("| Agent | Kind | Path |");
    lines.push("| --- | --- | --- |");
    for (const target of [...targets].sort((a, b) => String(a.tool).localeCompare(String(b.tool)) || String(a.relativePath).localeCompare(String(b.relativePath)))) {
      lines.push(`| \`${code(target.tool)}\` | \`${code(target.kind)}\` | \`${tableCode(target.relativePath)}\` |`);
    }
    lines.push("");
  }
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${lines.join("\n")}\n`, "utf8");
console.log(`Updated ${output} from ${groupJson}`);
NODE
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$group_json" "$output" <<'PY'
import json
import os
import sys

group_json = sys.argv[1]
output = sys.argv[2]

def read_payload(file_path):
    if not os.path.exists(file_path):
        return {"version": 2, "groups": []}
    with open(file_path, "r", encoding="utf-8") as handle:
        parsed = json.load(handle)
    return {"version": parsed.get("version", 2), "groups": parsed.get("groups", []) if isinstance(parsed.get("groups", []), list) else []}

def text(value):
    return str(value or "").replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")

def code(value):
    return str(value or "").replace("`", "\\`")

def table_code(value):
    return code(value).replace("|", "\\|")

payload = read_payload(group_json)
groups = payload["groups"]
lines = [
    "# Skill Groups",
    "",
    "This file is generated from `.skillbridge/skill-workspace.json` so agents and search tools can discover how skills are grouped.",
    "",
    "## Summary",
    "",
    f"- Groups: {len(groups)}",
    f"- Workspace groups: {len([group for group in groups if group.get('side') == 'workspace'])}",
    f"- Central groups: {len([group for group in groups if group.get('side') == 'central'])}",
    "",
]

if not groups:
    lines.extend(["No skill groups are defined yet.", ""])
else:
    for group in sorted(groups, key=lambda item: (str(item.get("side", "")), str(item.get("name", "")))):
        targets = group.get("targets", []) if isinstance(group.get("targets", []), list) else []
        tools = sorted({target.get("tool") for target in targets if target.get("tool")})
        lines.append(f"## {text(group.get('name', ''))}")
        lines.append("")
        lines.append(f"- ID: `{code(group.get('id', ''))}`")
        lines.append(f"- Side: `{code(group.get('side', ''))}`")
        lines.append(f"- Targets: {len(targets)}")
        lines.append("- Agents: " + (", ".join(f"`{code(tool)}`" for tool in tools) if tools else "-"))
        meta = group.get("meta")
        if isinstance(meta, dict):
            lines.append("- Metadata:")
            for key in ["source", "repoKey", "repoUrl", "lastInstalledAt", "mirroredFrom"]:
                if meta.get(key):
                    lines.append(f"  - {key}: {meta[key]}")
        lines.append("")
        lines.append("| Agent | Kind | Path |")
        lines.append("| --- | --- | --- |")
        for target in sorted(targets, key=lambda item: (str(item.get("tool", "")), str(item.get("relativePath", "")))):
            lines.append(f"| `{code(target.get('tool', ''))}` | `{code(target.get('kind', ''))}` | `{table_code(target.get('relativePath', ''))}` |")
        lines.append("")

os.makedirs(os.path.dirname(output), exist_ok=True)
with open(output, "w", encoding="utf-8") as handle:
    handle.write("\n".join(lines) + "\n")
print(f"Updated {output} from {group_json}")
PY
else
  echo "node or python3 is required to generate SKILL_GROUP.md from JSON." >&2
  exit 1
fi
