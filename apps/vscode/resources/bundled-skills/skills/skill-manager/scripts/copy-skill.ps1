param(
  [Parameter(Mandatory = $true)]
  [string]$SourceSkill,
  [string]$Workspace = (Get-Location).Path,
  [string]$Agent = "agents",
  [switch]$AllAgents,
  [switch]$Force,
  [string]$SkillName = ""
)

$ErrorActionPreference = "Stop"
$agents = @("agents", "claude", "codex", "gemini", "cursor", "antigravity")

function Get-AgentRoot {
  param([string]$Base, [string]$AgentName)
  if ($AgentName -eq "agents") { return Join-Path $Base ".agents" }
  return Join-Path $Base ".$AgentName"
}

function Copy-Directory {
  param([string]$From, [string]$To)
  if (Test-Path -LiteralPath $To) {
    if (-not $Force) {
      throw "Target already exists: $To. Re-run with -Force to replace it."
    }
    Remove-Item -LiteralPath $To -Recurse -Force
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $To) -Force | Out-Null
  Copy-Item -LiteralPath $From -Destination $To -Recurse -Force
}

$source = Resolve-Path -LiteralPath $SourceSkill
$sourcePath = $source.Path
$manifest = Join-Path $sourcePath "SKILL.md"
if (-not (Test-Path -LiteralPath $manifest)) {
  throw "Source skill must be a folder that contains SKILL.md: $sourcePath"
}

if ([string]::IsNullOrWhiteSpace($SkillName)) {
  $SkillName = Split-Path -Leaf $sourcePath
}
if ($SkillName -match '[\\/]' -or $SkillName -eq "." -or $SkillName -eq "..") {
  throw "Invalid skill name: $SkillName"
}

$targets = if ($AllAgents) { $agents } else { @($Agent) }
foreach ($targetAgent in $targets) {
  if ($agents -notcontains $targetAgent) {
    throw "Unknown agent '$targetAgent'. Expected one of: $($agents -join ', ')"
  }
  $targetRoot = Join-Path (Get-AgentRoot -Base $Workspace -AgentName $targetAgent) "skills"
  $targetPath = Join-Path $targetRoot $SkillName
  Copy-Directory -From $sourcePath -To $targetPath
  "Installed $SkillName to $targetPath"
}
