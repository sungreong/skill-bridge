#!/usr/bin/env bash
set -euo pipefail

workspace="$(pwd)"
central="${SKILL_BRIDGE_HOME:-$HOME/skill-bridge-repo}"
json="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      workspace="$2"
      shift 2
      ;;
    --central)
      central="$2"
      shift 2
      ;;
    --json)
      json="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

agents=(agents claude codex gemini cursor antigravity)
rows=()

add_check() {
  local status="$1"
  local name="$2"
  local detail="$3"
  rows+=("$status|$name|$detail")
}

test_read_write() {
  local target="$1"
  if [[ ! -e "$target" ]]; then
    echo "missing"
    return
  fi
  local probe="$target/.skillbridge-write-test"
  if printf 'ok' > "$probe" 2>/dev/null; then
    rm -f "$probe"
    echo "readable-writable"
  else
    echo "readable-not-writable"
  fi
}

agent_root() {
  local base="$1"
  local agent="$2"
  local mode="$3"
  if [[ "$mode" == "workspace" ]]; then
    if [[ "$agent" == "agents" ]]; then
      printf '%s/.agents' "$base"
    else
      printf '%s/.%s' "$base" "$agent"
    fi
  else
    printf '%s/%s' "$base" "$agent"
  fi
}

test_agent_roots() {
  local base="$1"
  local mode="$2"
  for agent in "${agents[@]}"; do
    root="$(agent_root "$base" "$agent" "$mode")"
    if [[ "$mode" == "workspace" ]]; then
      label="Workspace .$agent"
    else
      label="Central $agent"
    fi
    if [[ -d "$root" ]]; then
      skill_root="$root/skills"
      if [[ -d "$skill_root" ]]; then
        skill_count="$(find "$skill_root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
      else
        skill_count="0"
      fi
      add_check ok "$label" "$root - skills=$skill_count"
    else
      parent_state="$(test_read_write "$(dirname "$root")")"
      if [[ "$parent_state" == "readable-writable" ]]; then
        add_check warn "$label" "$root is missing; parent is $parent_state"
      else
        add_check fail "$label" "$root is missing; parent is $parent_state"
      fi
    fi
  done
}

test_skill_manifests() {
  local base="$1"
  local mode="$2"
  local label
  if [[ "$mode" == "workspace" ]]; then
    label="Workspace skill manifests"
  else
    label="Central skill manifests"
  fi
  missing=()
  for agent in "${agents[@]}"; do
    skill_root="$(agent_root "$base" "$agent" "$mode")/skills"
    [[ -d "$skill_root" ]] || continue
    while IFS= read -r -d '' folder; do
      [[ -f "$folder/SKILL.md" ]] || missing+=("$folder")
    done < <(find "$skill_root" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
  done

  if [[ "${#missing[@]}" -eq 0 ]]; then
    add_check ok "$label" "All discovered $mode skill folders contain SKILL.md"
  else
    add_check warn "$label" "Missing SKILL.md in: ${missing[*]}"
  fi
}

test_group_metadata() {
  local base="$1"
  local mode_label="$2"
  local group_json="$base/.skillbridge/skill-workspace.json"
  local group_doc="$base/.skillbridge/SKILL_GROUP.md"
  local legacy_group_json="$base/skill_workspace.json"
  if [[ ! -f "$group_json" && -f "$legacy_group_json" ]]; then
    group_json="$legacy_group_json"
    group_doc="$base/SKILL_GROUP.md"
  fi
  if [[ ! -f "$group_json" ]]; then
    add_check ok "$mode_label groups" "$group_json not present"
    return
  fi
  local python_cmd=""
  if command -v python3 >/dev/null 2>&1; then
    python_cmd="python3"
  elif command -v python >/dev/null 2>&1; then
    python_cmd="python"
  else
    add_check warn "$mode_label groups" "Python was not found; could not parse $group_json"
    return
  fi
  local detail
  local status
  detail="$("$python_cmd" - "$group_json" "$group_doc" <<'PY'
import json
import os
import sys

try:
    group_json = sys.argv[1]
    group_doc = sys.argv[2]
    with open(group_json, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    groups = payload.get("groups", [])
    npx_groups = [
        group for group in groups
        if isinstance(group.get("meta"), dict) and group["meta"].get("source") in ("npx", "mixed")
    ]
    missing_repo = [group for group in npx_groups if not group.get("meta", {}).get("repoUrl")]
    doc_state = "SKILL_GROUP.md present" if os.path.exists(group_doc) else "SKILL_GROUP.md missing; regenerate it if search docs are needed"
    print(f"groups={len(groups)}, npx={len(npx_groups)}, npxMissingRepoUrl={len(missing_repo)}, {doc_state}")
    sys.exit(1 if missing_repo else 0)
except Exception as exc:
    print(f"Could not parse {sys.argv[1]}: {exc}")
    sys.exit(2)
PY
)" || status="$?"
  status="${status:-0}"
  if [[ "$status" == "0" ]]; then
    add_check ok "$mode_label groups" "$detail"
  else
    add_check warn "$mode_label groups" "$detail"
  fi
}

add_check ok OS "$(uname -srm)"
add_check ok "User home" "$HOME"

workspace_state="$(test_read_write "$workspace")"
case "$workspace_state" in
  readable-writable) add_check ok "Workspace access" "$workspace - $workspace_state" ;;
  missing) add_check fail "Workspace access" "$workspace - $workspace_state" ;;
  *) add_check warn "Workspace access" "$workspace - $workspace_state" ;;
esac

if [[ -e "$central" ]]; then
  central_state="$(test_read_write "$central")"
  if [[ "$central_state" == "readable-writable" ]]; then
    add_check ok "Central access" "$central - $central_state"
  else
    add_check warn "Central access" "$central - $central_state"
  fi
else
  parent="$(dirname "$central")"
  parent_state="$(test_read_write "$parent")"
  if [[ "$parent_state" == "readable-writable" ]]; then
    add_check warn "Central path" "$central does not exist; parent is $parent_state"
  else
    add_check fail "Central path" "$central does not exist; parent is $parent_state"
  fi
fi

for command_name in git npx; do
  if command -v "$command_name" >/dev/null 2>&1; then
    version="$("$command_name" --version 2>/dev/null | head -n 1 || true)"
    add_check ok "$command_name on PATH" "$version"
  else
    add_check warn "$command_name on PATH" "$command_name was not found. Install it or restart the terminal after PATH changes."
  fi
done

test_agent_roots "$workspace" workspace
if [[ -d "$central" ]]; then
  test_agent_roots "$central" central
fi
test_skill_manifests "$workspace" workspace
if [[ -d "$central" ]]; then
  test_skill_manifests "$central" central
fi
test_group_metadata "$workspace" Workspace
if [[ -d "$central" ]]; then
  test_group_metadata "$central" Central
fi

if [[ "$json" == "true" ]]; then
  printf '{"checkedAt":"%s","workspace":"%s","central":"%s","results":[' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$workspace" "$central"
  first="true"
  for row in "${rows[@]}"; do
    IFS='|' read -r status name detail <<< "$row"
    if [[ "$first" == "true" ]]; then first="false"; else printf ','; fi
    printf '{"status":"%s","name":"%s","detail":"%s"}' "$status" "$name" "$detail"
  done
  printf ']}\n'
else
  echo "Skill Bridge diagnostics"
  echo "Workspace: $workspace"
  echo "Central:   $central"
  for row in "${rows[@]}"; do
    IFS='|' read -r status name detail <<< "$row"
    printf '[%s] %s: %s\n' "$(printf '%s' "$status" | tr '[:lower:]' '[:upper:]')" "$name" "$detail"
  done
fi
