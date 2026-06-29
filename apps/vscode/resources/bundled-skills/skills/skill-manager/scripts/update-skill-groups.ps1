param(
  [string]$Root = (Get-Location).Path,
  [string]$GroupJson = "",
  [string]$Output = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($GroupJson)) {
  $GroupJson = Join-Path (Join-Path $Root ".skillbridge") "skill-workspace.json"
  $legacyGroupJson = Join-Path $Root "skill_workspace.json"
  if (-not (Test-Path -LiteralPath $GroupJson) -and (Test-Path -LiteralPath $legacyGroupJson)) {
    $GroupJson = $legacyGroupJson
  }
}
if ([string]::IsNullOrWhiteSpace($Output)) {
  $Output = Join-Path (Join-Path $Root ".skillbridge") "SKILL_GROUP.md"
}

function Escape-Code {
  param([string]$Value)
  return $Value.Replace('`', '\`')
}

function Escape-Text {
  param([string]$Value)
  return $Value.Replace('\', '\\').Replace('[', '\[').Replace(']', '\]')
}

if (-not (Test-Path -LiteralPath $GroupJson)) {
  $payload = [pscustomobject]@{ version = 2; groups = @() }
} else {
  $payload = Get-Content -LiteralPath $GroupJson -Raw | ConvertFrom-Json
  if (-not $payload.PSObject.Properties.Name.Contains("groups")) {
    $payload | Add-Member -NotePropertyName groups -NotePropertyValue @()
  }
}

$groups = @($payload.groups)
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Skill Groups") | Out-Null
$lines.Add("") | Out-Null
$lines.Add('This file is generated from `.skillbridge/skill-workspace.json` so agents and search tools can discover how skills are grouped.') | Out-Null
$lines.Add("") | Out-Null
$lines.Add("## Summary") | Out-Null
$lines.Add("") | Out-Null
$lines.Add("- Groups: $($groups.Count)") | Out-Null
$lines.Add("- Workspace groups: $(@($groups | Where-Object { $_.side -eq 'workspace' }).Count)") | Out-Null
$lines.Add("- Central groups: $(@($groups | Where-Object { $_.side -eq 'central' }).Count)") | Out-Null
$lines.Add("") | Out-Null

if ($groups.Count -eq 0) {
  $lines.Add("No skill groups are defined yet.") | Out-Null
} else {
  foreach ($group in @($groups | Sort-Object side, name)) {
    $targets = @($group.targets)
    $tools = @($targets | ForEach-Object { $_.tool } | Sort-Object -Unique)
    $lines.Add("## $(Escape-Text $group.name)") | Out-Null
    $lines.Add("") | Out-Null
    $lines.Add('- ID: `' + (Escape-Code $group.id) + '`') | Out-Null
    $lines.Add('- Side: `' + (Escape-Code $group.side) + '`') | Out-Null
    $lines.Add("- Targets: $($targets.Count)") | Out-Null
    $agentsDisplay = if ($tools.Count -gt 0) { (@($tools | ForEach-Object { '`' + (Escape-Code $_) + '`' }) -join ", ") } else { "-" }
    $lines.Add("- Agents: $agentsDisplay") | Out-Null
    if ($group.meta) {
      $lines.Add("- Metadata:") | Out-Null
      foreach ($property in @("source", "repoKey", "repoUrl", "lastInstalledAt", "mirroredFrom")) {
        if ($group.meta.PSObject.Properties.Name.Contains($property) -and $group.meta.$property) {
          $lines.Add(("  - {0}: {1}" -f $property, $group.meta.$property)) | Out-Null
        }
      }
    }
    $lines.Add("") | Out-Null
    $lines.Add("| Agent | Kind | Path |") | Out-Null
    $lines.Add("| --- | --- | --- |") | Out-Null
    foreach ($target in @($targets | Sort-Object tool, relativePath)) {
      $safePath = (Escape-Code $target.relativePath) -replace "\|", "\|"
      $lines.Add(('| `{0}` | `{1}` | `{2}` |' -f (Escape-Code $target.tool), (Escape-Code $target.kind), $safePath)) | Out-Null
    }
    $lines.Add("") | Out-Null
  }
}

New-Item -ItemType Directory -Path (Split-Path -Parent $Output) -Force | Out-Null
Set-Content -LiteralPath $Output -Value ($lines -join "`n") -Encoding UTF8
"Updated $Output from $GroupJson"
