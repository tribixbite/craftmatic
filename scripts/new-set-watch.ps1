# new-set-watch.ps1 — the scheduled wrapper for onboarding one announced set.
#
# Runs clego's `discovery/new_set.py <sku> --run` (does nothing until LEGO's
# Builder service serves the 3D model, then harvests, grades, indexes and
# publishes it to R2) and, the run it comes back 0, craftmatic's
# `scripts/new-set.ts <sku> --commit --browser` (commits the index copy, proves
# the live render in Chrome, builds the rigged .mcaddon and its gates). Each
# invocation appends to output/new-set-<sku>/watch.log; the pack round is done
# once, guarded by output/new-set-<sku>/DONE.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\git\craftmatic\scripts\new-set-watch.ps1 11390
#
# Register it hourly (the user's call; this script never registers itself):
#   schtasks /create /tn "craftmatic-new-set-11390" /sc hourly /st 06:05 `
#     /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\git\craftmatic\scripts\new-set-watch.ps1 11390"
# and remove it once DONE exists:  schtasks /delete /tn "craftmatic-new-set-11390" /f
#
# Exit codes: 0 = live and the pack round passed (DONE written); 3 = not yet
# available upstream (try again next hour); 1 = a step failed (read the log).
#
# — Opus 5.5
param(
  [Parameter(Mandatory = $true)][string]$Sku,
  [string]$Clego = 'C:\git\clego',
  [string]$Craftmatic = 'C:\git\craftmatic',
  [string]$Faces = ''
)
$ErrorActionPreference = 'Continue'
$Sku = $Sku -replace '-\d+$', ''
$out = Join-Path $Craftmatic "output\new-set-$Sku"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out 'watch.log'
$done = Join-Path $out 'DONE'
function Log([string]$msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Tee-Object -FilePath $log -Append }

if (Test-Path $done) { Log "already done ($(Get-Content $done -Raw))"; exit 0 }

# A second copy must not run over this one (a scheduled task fires again while
# a 5-minute index build is still going).
$lock = Join-Path $out '.watch-lock'
if (Test-Path $lock) {
  $age = (Get-Date) - (Get-Item $lock).LastWriteTime
  if ($age.TotalHours -lt 3) { Log "another run holds $lock ($([int]$age.TotalMinutes) min old); skipping"; exit 3 }
  Log "stale lock ($([int]$age.TotalHours) h); taking it"
}
Set-Content -Path $lock -Value $PID
try {
  Log "== clego new_set.py $Sku --run"
  Push-Location $Clego
  & python -u discovery\new_set.py $Sku --run 2>&1 | Tee-Object -FilePath $log -Append
  $rc = $LASTEXITCODE
  Pop-Location
  if ($rc -eq 3) { Log "not available upstream yet (exit 3)"; exit 3 }
  if ($rc -ne 0) { Log "clego half FAILED (exit $rc)"; exit 1 }

  Log "== craftmatic new-set.ts $Sku --commit --browser"
  Push-Location $Craftmatic
  $args = @('scripts/new-set.ts', $Sku, '--commit', '--browser', '--out', $out)
  if ($Faces) { $args += @('--faces', $Faces) }
  & bun @args 2>&1 | Tee-Object -FilePath $log -Append
  $rc = $LASTEXITCODE
  Pop-Location
  if ($rc -ne 0) { Log "craftmatic half exited $rc (2 = not live yet, 1 = a gate failed)"; exit ($(if ($rc -eq 2) { 3 } else { 1 })) }

  Set-Content -Path $done -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') live + pack built; see $out\report.md"
  Log "DONE"
  exit 0
} finally {
  Remove-Item -Path $lock -Force -ErrorAction SilentlyContinue
}
