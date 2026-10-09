# dsh-memory installer for the DSH desktop profile.
#
# NOTE: This script is deliberately ASCII-only. Windows PowerShell 5.1 (the only
# PowerShell guaranteed to exist on a fresh Windows install) reads a BOM-less
# .ps1 as ANSI/GBK, which mangles non-ASCII text and can break parsing outright.
# Keeping this file ASCII makes it work on both 5.1 and 7.x. Chinese
# documentation lives in ../MIGRATION.md and ../README.md.
#
# What it does: writes ONE `insert` row into the profile's cordis.patch.yml.
#   - no pnpm, no network, no dsh.bundle needed: the row names this plugin by
#     ABSOLUTE PATH, and the patch loader turns that into a file URL
#   - the path is derived from this script's own location, so the plugin dir can
#     live anywhere
#   - idempotent: re-running refreshes the row instead of duplicating it
#   - atomic write (temp file + rename) and a timestamped backup every run
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Diagnostics

[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$Diagnostics,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# ---- locate plugin and profile -------------------------------------------------
$pluginDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$entry = Join-Path $pluginDir 'lib\index.js'
if (-not (Test-Path $entry)) { throw "Plugin entry not found: $entry" }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$patchFile = Join-Path $profileDir 'cordis.patch.yml'

if (-not (Test-Path $profileDir)) {
  throw "Profile directory not found: $profileDir`nOpen DeepSeek Harness once (it initializes the desktop profile), then run this script again."
}
if (-not (Test-Path $patchFile)) { throw "Patch file not found: $patchFile" }

# Absolute path with forward slashes: the patch loader converts absolute paths
# inside `insert` rows into file URLs.
$entrySpec = $entry.Replace('\', '/')
$dataDirSpec = (Join-Path $dshHome 'dsh-memory').Replace('\', '/')

$Marker = '# dsh-memory -- managed block'
# Any line starting with `# dsh-memory` begins a block this installer owns.
# Matching loosely on purpose: the very first version of this plugin was added by
# hand with a different comment wording ("# dsh-memory <dash> <chinese text>").
# If we only matched the exact current marker, that legacy block would survive and
# a second `- insert: ... - id: memory` row would be appended -- two rows sharing
# one id. So recognize both.
$MarkerPattern = '^#\s*dsh-memory\b'

# Remove the block this installer owns.
#
# Block-based, NOT line-by-line. The block looks like:
#     # dsh-memory -- managed block
#     # ...notes...
#     - insert:
#         - id: memory
#           name: '...'
#           config:
#             dataDir: '...'
# A naive line scan tends to stop early on the `- insert:` line, leaving `- insert:`
# and `- id:` behind while dropping `name:` -- which produces invalid YAML and stops
# DSH from booting. Rules here:
#   phase 1: consume the marker line, then this block's own comment/blank lines,
#            then the `- insert:` line
#   phase 2: consume indented lines and blanks; STOP at the first line with zero
#            indentation -- that is the next patch entry (and its own comments),
#            which must not be swallowed.
function Remove-MemoryBlock([string]$Text) {
  $lines = $Text -split "`r?`n"
  $out = New-Object System.Collections.Generic.List[string]
  $removing = $false   # marker seen
  $inInsert = $false   # inside the `- insert:` block
  foreach ($line in $lines) {
    if (-not $removing) {
      if ($line -match $MarkerPattern) { $removing = $true; continue }
      $out.Add($line)
      continue
    }
    if (-not $inInsert) {
      if ($line -match '^\s*#' -or $line.Trim() -eq '') { continue }
      if ($line -match '^- insert:\s*$') { $inInsert = $true; continue }
      # Marker did not introduce an insert block; keep the line, stop removing.
      $removing = $false
      $out.Add($line)
      continue
    }
    if ($line -match '^\s{4,}\S' -or $line.Trim() -eq '') { continue }
    $removing = $false
    $inInsert = $false
    $out.Add($line)
  }
  return ($out -join "`n").TrimEnd() + "`n"
}

function Write-Patch([string]$Text) {
  # Atomic replace: write a temp file, then rename. A half-written patch file
  # would prevent DSH from starting at all.
  $tmp = "$patchFile.tmp"
  [System.IO.File]::WriteAllText($tmp, $Text, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -Force $tmp $patchFile
}

$content = Get-Content $patchFile -Raw -Encoding UTF8
$backup = "$patchFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $patchFile $backup

# ---- uninstall ---------------------------------------------------------------
if ($Uninstall) {
  # NOTE: (?m) is required. In .NET regex (which PowerShell -match uses) `^` anchors
  # to the start of the WHOLE string, not each line, unless multiline mode is on.
  # Remove-MemoryBlock tests single lines so it does not need this; this call passes
  # the entire file, and without (?m) the check would always report "not installed".
  if ($content -notmatch '(?m)^#\s*dsh-memory\b') {
    Write-Host "Not installed (no managed block in the patch file); nothing to do." -ForegroundColor Yellow
    Write-Host "Backup kept at: $backup" -ForegroundColor DarkGray
    return
  }
  Write-Patch (Remove-MemoryBlock $content)
  Write-Host "OK: uninstalled. Backup: $backup" -ForegroundColor Green
  Write-Host "Restart DeepSeek Harness. Plugin files and memory data were not touched." -ForegroundColor Green
  return
}

# ---- install / update (idempotent: drop old block, then write the new one) ----
$content = Remove-MemoryBlock $content

$block = @(
  ''
  "$Marker (written by tools/install.ps1; do not edit by hand)."
  '# The row names this plugin by absolute path: the patch loader converts',
  '# absolute paths inside `insert` rows into file URLs, so no pnpm install,',
  '# no network, and no dsh.bundle / dsh.profile.bundles involvement is needed.',
  '# To uninstall: delete this block, or run install.ps1 -Uninstall.',
  '- insert:',
  '    - id: memory',
  "      name: '$entrySpec'",
  '      config:',
  "        dataDir: '$dataDirSpec'"
)
if ($Diagnostics) {
  $block += '        # WARNING: unauthenticated loopback diagnostic routes.'
  $block += '        # They can read arbitrary files, write credentials, mutate data'
  $block += '        # and dump memory text. Remove this line and restart when done.'
  $block += '        diagnostics: true'
}

Write-Patch ($content.TrimEnd() + "`n" + ($block -join "`n") + "`n")

Write-Host ""
Write-Host "OK: wrote $patchFile" -ForegroundColor Green
Write-Host "    plugin entry : $entrySpec"
Write-Host "    data dir     : $dataDirSpec"
Write-Host "    backup       : $backup" -ForegroundColor DarkGray
if ($Diagnostics) { Write-Host "    WARNING: diagnostic routes are ON (unauthenticated)." -ForegroundColor Yellow }
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1) Fully quit and restart DeepSeek Harness (a page refresh is not enough)."
Write-Host "  2) A 'Memory' icon should appear in the left sidebar."
Write-Host "  3) Set the embedding key and import memories -- see ../MIGRATION.md."
