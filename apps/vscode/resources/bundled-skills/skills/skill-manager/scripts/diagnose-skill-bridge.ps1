param(
  [string]$Workspace = (Get-Location).Path,
  [string]$Central = "",
  [switch]$Json
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Central)) {
  if ($env:SKILL_BRIDGE_HOME) {
    $Central = $env:SKILL_BRIDGE_HOME
  } else {
    $Central = Join-Path $HOME "skill-bridge-repo"
  }
}

$agents = @("agents", "claude", "codex", "gemini", "cursor", "antigravity")
$results = New-Object System.Collections.Generic.List[object]

function Add-Check {
  param([string]$Status, [string]$Name, [string]$Detail)
  $script:results.Add([pscustomobject]@{
    status = $Status
    name = $Name
    detail = $Detail
  }) | Out-Null
}

function Test-ReadWrite {
  param([string]$PathValue)
  if (-not (Test-Path -LiteralPath $PathValue)) {
    return "missing"
  }
  $probe = Join-Path $PathValue ".skillbridge-write-test"
  try {
    Set-Content -LiteralPath $probe -Value "ok" -NoNewline -Encoding UTF8
    Remove-Item -LiteralPath $probe -Force
    return "readable-writable"
  } catch {
    return "readable-not-writable"
  }
}

function Get-AgentRoot {
  param([string]$Base, [string]$Agent, [string]$Mode)
  if ($Mode -eq "workspace") {
    if ($Agent -eq "agents") { return Join-Path $Base ".agents" }
    return Join-Path $Base ".$Agent"
  }
  return Join-Path $Base $Agent
}

function Test-AgentRoots {
  param([string]$Base, [string]$Mode)
  foreach ($agent in $agents) {
    $root = Get-AgentRoot -Base $Base -Agent $agent -Mode $Mode
    $label = if ($Mode -eq "workspace") { "Workspace .$agent" } else { "Central $agent" }
    if (Test-Path -LiteralPath $root) {
      $skillRoot = Join-Path $root "skills"
      $skillCount = if (Test-Path -LiteralPath $skillRoot) {
        @(Get-ChildItem -LiteralPath $skillRoot -Directory -ErrorAction SilentlyContinue).Count
      } else {
        0
      }
      Add-Check "ok" $label "$root - skills=$skillCount"
    } else {
      $state = Test-ReadWrite -PathValue (Split-Path -Parent $root)
      Add-Check ($(if ($state -eq "readable-writable") { "warn" } else { "fail" })) $label "$root is missing; parent is $state"
    }
  }
}

function Test-SkillManifests {
  param([string]$Base, [string]$Mode)
  $missingSkillMd = New-Object System.Collections.Generic.List[string]
  foreach ($agent in $agents) {
    $skillRoot = Join-Path (Get-AgentRoot -Base $Base -Agent $agent -Mode $Mode) "skills"
    if (-not (Test-Path -LiteralPath $skillRoot)) { continue }
    Get-ChildItem -LiteralPath $skillRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $manifest = Join-Path $_.FullName "SKILL.md"
      if (-not (Test-Path -LiteralPath $manifest)) {
        $missingSkillMd.Add($_.FullName) | Out-Null
      }
    }
  }
  $label = if ($Mode -eq "workspace") { "Workspace skill manifests" } else { "Central skill manifests" }
  if ($missingSkillMd.Count -eq 0) {
    Add-Check "ok" $label "All discovered $Mode skill folders contain SKILL.md"
  } else {
    Add-Check "warn" $label "Missing SKILL.md in: $($missingSkillMd -join '; ')"
  }
}

function Test-GroupMetadata {
  param([string]$Base, [string]$Mode)
  $groupJson = Join-Path (Join-Path $Base ".skillbridge") "skill-workspace.json"
  $groupDoc = Join-Path (Join-Path $Base ".skillbridge") "SKILL_GROUP.md"
  $legacyGroupJson = Join-Path $Base "skill_workspace.json"
  if (-not (Test-Path -LiteralPath $groupJson) -and (Test-Path -LiteralPath $legacyGroupJson)) {
    $groupJson = $legacyGroupJson
    $groupDoc = Join-Path $Base "SKILL_GROUP.md"
  }
  if (-not (Test-Path -LiteralPath $groupJson)) {
    Add-Check "ok" "$Mode groups" "$groupJson not present"
    return
  }
  try {
    $payload = Get-Content -LiteralPath $groupJson -Raw | ConvertFrom-Json
    $groups = @($payload.groups)
    $npxGroups = @($groups | Where-Object { $_.meta -and ($_.meta.source -eq "npx" -or $_.meta.source -eq "mixed") })
    $missingNpxRepo = @($npxGroups | Where-Object { -not $_.meta.repoUrl })
    $status = if ($missingNpxRepo.Count -eq 0) { "ok" } else { "warn" }
    $docState = if (Test-Path -LiteralPath $groupDoc) { "SKILL_GROUP.md present" } else { "SKILL_GROUP.md missing; regenerate it if search docs are needed" }
    Add-Check $status "$Mode groups" "groups=$($groups.Count), npx=$($npxGroups.Count), npxMissingRepoUrl=$($missingNpxRepo.Count), $docState"
  } catch {
    Add-Check "warn" "$Mode groups" "Could not parse ${groupJson}: $($_.Exception.Message)"
  }
}

Add-Check "ok" "OS" "$([System.Runtime.InteropServices.RuntimeInformation]::OSDescription) $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
Add-Check "ok" "PowerShell" $PSVersionTable.PSVersion.ToString()
Add-Check "ok" "User home" $HOME

$workspaceState = Test-ReadWrite -PathValue $Workspace
Add-Check ($(if ($workspaceState -eq "readable-writable") { "ok" } elseif ($workspaceState -eq "missing") { "fail" } else { "warn" })) "Workspace access" "$Workspace - $workspaceState"

if (Test-Path -LiteralPath $Central) {
  $centralState = Test-ReadWrite -PathValue $Central
  Add-Check ($(if ($centralState -eq "readable-writable") { "ok" } else { "warn" })) "Central access" "$Central - $centralState"
} else {
  $parent = Split-Path -Parent $Central
  $parentState = if ($parent) { Test-ReadWrite -PathValue $parent } else { "missing" }
  Add-Check ($(if ($parentState -eq "readable-writable") { "warn" } else { "fail" })) "Central path" "$Central does not exist; parent is $parentState"
}

foreach ($command in @("git", "npx")) {
  $found = Get-Command $command -ErrorAction SilentlyContinue
  if ($found) {
    $version = ""
    try { $version = (& $command --version 2>$null | Select-Object -First 1) } catch { $version = $found.Source }
    Add-Check "ok" "$command on PATH" $version
  } else {
    Add-Check "warn" "$command on PATH" "$command was not found. Install it or restart the terminal after PATH changes."
  }
}

Test-AgentRoots -Base $Workspace -Mode "workspace"
if (Test-Path -LiteralPath $Central) {
  Test-AgentRoots -Base $Central -Mode "central"
}
Test-SkillManifests -Base $Workspace -Mode "workspace"
if (Test-Path -LiteralPath $Central) {
  Test-SkillManifests -Base $Central -Mode "central"
}
Test-GroupMetadata -Base $Workspace -Mode "Workspace"
if (Test-Path -LiteralPath $Central) {
  Test-GroupMetadata -Base $Central -Mode "Central"
}

if ($Json) {
  [pscustomobject]@{
    checkedAt = (Get-Date).ToUniversalTime().ToString("o")
    workspace = $Workspace
    central = $Central
    results = $results
  } | ConvertTo-Json -Depth 5
} else {
  "Skill Bridge diagnostics"
  "Workspace: $Workspace"
  "Central:   $Central"
  foreach ($item in $results) {
    "[{0}] {1}: {2}" -f $item.status.ToUpperInvariant(), $item.name, $item.detail
  }
}
