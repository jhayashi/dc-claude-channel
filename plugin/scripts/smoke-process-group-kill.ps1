# Smoke test (Windows): does `taskkill /T /F /PID <claude>` cascade to claude's
# grandchildren? This is the Windows sibling of smoke-process-group-kill.sh and
# verifies the #95 fix path in plugin/dispatcher/subagent-process.ts:killTree().
#
# Background:
#   Windows has no POSIX process groups, so the negative-PID kill the POSIX path
#   uses (`process.kill(-pid, signal)`) throws EINVAL. The dispatcher instead
#   runs `taskkill /T /F /PID <pid>` — `/T` walks the parent-child tree, `/F`
#   forces termination. The pure step planner (planKillTree) is unit-tested on
#   every platform; this script is the *live* end-to-end check that only a
#   Windows host can run.
#
# Unlike the bash baseline (which spawns RAW claude to demonstrate the leak),
# this script directly exercises taskkill /T /F — the mechanism killTree uses —
# and asserts the grandchild dies.
#
# Run pre-release on a Windows box for any change touching subagent-process.ts:
#   pwsh -File plugin/scripts/smoke-process-group-kill.ps1
#
# Requires: claude on PATH, python on PATH (the blocking grandchild), and
# valid Claude credentials in the real $HOME.

$ErrorActionPreference = 'Stop'

function Get-Descendants {
  param([int]$ParentPid)
  $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentPid" -ErrorAction SilentlyContinue
  foreach ($k in $kids) {
    [int]$k.ProcessId
    Get-Descendants -ParentPid ([int]$k.ProcessId)
  }
}

function Test-Alive {
  param([int]$ProcId)
  $null -ne (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)
}

# Isolated HOME so the nested claude doesn't load dc-claude-channel and start
# its own dispatcher. Symlink only the auth files; omit ~/.claude/plugins.
$realHome = $env:USERPROFILE
$isolatedHome = Join-Path ([System.IO.Path]::GetTempPath()) ("dc-smoke-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $isolatedHome '.claude') -Force | Out-Null
foreach ($f in @('.credentials.json', 'config.json')) {
  $src = Join-Path (Join-Path $realHome '.claude') $f
  if (Test-Path $src) {
    Copy-Item $src (Join-Path (Join-Path $isolatedHome '.claude') $f) -ErrorAction SilentlyContinue
  }
}

$outLog = New-TemporaryFile
$claude = $null
try {
  # python (not bare sleep) — claude's Bash sandbox blocks bare-sleep heuristics.
  $prompt = "Use the Bash tool to run exactly this command (it will block for 90s, expected): python -c `"import time; time.sleep(90)`""

  Write-Host "=== Spawning isolated claude -p (HOME=$isolatedHome)"
  $claude = Start-Process -FilePath 'claude' `
    -ArgumentList @('-p', '--dangerously-skip-permissions', $prompt) `
    -RedirectStandardOutput $outLog.FullName -RedirectStandardError ($outLog.FullName + '.err') `
    -PassThru -NoNewWindow -Environment @{ USERPROFILE = $isolatedHome; HOME = $isolatedHome }
  $claudePid = $claude.Id
  Write-Host "Claude PID: $claudePid"

  # Find the python grandchild via the descendant tree (avoids argv matching).
  $targetPid = $null
  for ($i = 0; $i -lt 60 -and -not $targetPid; $i++) {
    Start-Sleep -Seconds 1
    foreach ($d in (Get-Descendants -ParentPid $claudePid)) {
      $proc = Get-Process -Id $d -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -match 'python') { $targetPid = $d; break }
    }
  }

  if (-not $targetPid) {
    Write-Host "FAIL: no python grandchild within 60s — claude likely failed to run the prompt"
    Write-Host "--- claude output ---"; Get-Content $outLog.FullName -ErrorAction SilentlyContinue
    taskkill /T /F /PID $claudePid 2>$null | Out-Null
    exit 1
  }

  Write-Host "Found python grandchild PID: $targetPid"
  Write-Host "--- descendants before taskkill ---"; Get-Descendants -ParentPid $claudePid

  Write-Host "=== Running: taskkill /T /F /PID $claudePid (the killTree Windows path)"
  taskkill /T /F /PID $claudePid 2>$null | Out-Null
  Start-Sleep -Seconds 4

  $claudeAlive = Test-Alive -ProcId $claudePid
  $targetAlive = Test-Alive -ProcId $targetPid
  Write-Host ("  Claude {0}:  {1}" -f $claudePid, $(if ($claudeAlive) { 'STILL ALIVE' } else { 'died' }))
  Write-Host ("  python {0}: {1}" -f $targetPid, $(if ($targetAlive) { 'STILL ALIVE' } else { 'died' }))
  Write-Host ""

  if (-not $claudeAlive -and -not $targetAlive) {
    Write-Host "VERDICT: taskkill /T /F cascades to grandchildren. #95 fix confirmed on Windows."
    exit 0
  } elseif (-not $claudeAlive -and $targetAlive) {
    Write-Host "VERDICT: taskkill /T /F did NOT reach the grandchild — it leaked. Regression."
    taskkill /F /PID $targetPid 2>$null | Out-Null
    exit 2
  } else {
    Write-Host "INCONCLUSIVE (claudeAlive=$claudeAlive targetAlive=$targetAlive)"
    taskkill /F /PID $claudePid 2>$null | Out-Null
    taskkill /F /PID $targetPid 2>$null | Out-Null
    exit 3
  }
} finally {
  Remove-Item $isolatedHome -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $outLog.FullName -Force -ErrorAction SilentlyContinue
  Remove-Item ($outLog.FullName + '.err') -Force -ErrorAction SilentlyContinue
}
