#!/usr/bin/env bash
set -euo pipefail

source_skill=""
workspace="$(pwd)"
agent="agents"
all_agents="false"
force="false"
skill_name=""
agents=(agents claude codex gemini cursor antigravity)

usage() {
  cat <<'EOF'
Usage:
  copy-skill.sh --source-skill PATH [--workspace PATH] [--agent agents|claude|codex|gemini|cursor|antigravity] [--all-agents] [--force] [--skill-name NAME]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-skill)
      source_skill="$2"
      shift 2
      ;;
    --workspace)
      workspace="$2"
      shift 2
      ;;
    --agent)
      agent="$2"
      shift 2
      ;;
    --all-agents)
      all_agents="true"
      shift
      ;;
    --force)
      force="true"
      shift
      ;;
    --skill-name)
      skill_name="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$source_skill" ]]; then
  echo "--source-skill is required" >&2
  usage >&2
  exit 2
fi

source_path="$(cd "$source_skill" && pwd)"
if [[ ! -f "$source_path/SKILL.md" ]]; then
  echo "Source skill must be a folder that contains SKILL.md: $source_path" >&2
  exit 1
fi

if [[ -z "$skill_name" ]]; then
  skill_name="$(basename "$source_path")"
fi
case "$skill_name" in
  */*|*\\*|.|..)
    echo "Invalid skill name: $skill_name" >&2
    exit 1
    ;;
esac

agent_root() {
  local base="$1"
  local agent_name="$2"
  if [[ "$agent_name" == "agents" ]]; then
    printf '%s/.agents' "$base"
  else
    printf '%s/.%s' "$base" "$agent_name"
  fi
}

is_known_agent() {
  local candidate="$1"
  for known in "${agents[@]}"; do
    [[ "$known" == "$candidate" ]] && return 0
  done
  return 1
}

if [[ "$all_agents" == "true" ]]; then
  targets=("${agents[@]}")
else
  targets=("$agent")
fi

for target_agent in "${targets[@]}"; do
  if ! is_known_agent "$target_agent"; then
    echo "Unknown agent '$target_agent'. Expected one of: ${agents[*]}" >&2
    exit 1
  fi
  target_path="$(agent_root "$workspace" "$target_agent")/skills/$skill_name"
  if [[ -e "$target_path" ]]; then
    if [[ "$force" != "true" ]]; then
      echo "Target already exists: $target_path. Re-run with --force to replace it." >&2
      exit 1
    fi
    rm -rf "$target_path"
  fi
  mkdir -p "$(dirname "$target_path")"
  cp -R "$source_path" "$target_path"
  echo "Installed $skill_name to $target_path"
done
