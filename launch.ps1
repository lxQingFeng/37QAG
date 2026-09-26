# QQ Agent launcher (real work; the .bat files are thin wrappers)
#
# Why a .ps1: Electron attaches to the console it was started from (for logging), so a
# .bat that starts the app keeps a console window alive forever ("cmd window will not
# close"). The .bat starts this script with `powershell -WindowStyle Hidden`, i.e. an
# INVISIBLE console, so nothing is left on screen.
#
# 2026-09-22: this file must stay **pure ASCII** (PowerShell 5.1 reads .ps1 as ANSI/GBK
# unless a UTF-8 BOM is present; Chinese comments turned into mojibake and the whole
# script failed to parse). Keep it ASCII, and keep the BOM for safety.
#
# Usage (normally called by the .bat launchers):
#   powershell -NoProfile -ExecutionPolicy Bypass -File launch.ps1 -Mode single
#   powershell -NoProfile -ExecutionPolicy Bypass -File launch.ps1 -Mode dual
param(
  [ValidateSet('single', 'dual')][string]$Mode = 'single'
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
# 阶段二：启动日志收归 data/logs/（单根备份）；旧根目录 launch-log.txt 由核心迁移
$dataLogs = Join-Path $root 'data\logs'
try { New-Item -ItemType Directory -Force -Path $dataLogs | Out-Null } catch {}
$log = Join-Path $dataLogs 'launch-log.txt'

function Log([string]$m) {
  try { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 } catch { }
}

if (-not (Test-Path -LiteralPath $exe)) {
  Log "[ERROR] electron.exe not found: $exe"
  Write-Host '[ERROR] node_modules\electron is missing. Please unzip the whole package again.'
  Start-Sleep -Seconds 10
  exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'models\Qwen3.5-0.8B-Q6_K.gguf'))) {
  Log '[WARN] local 0.8B model missing (bot still runs)'
}

# Bootstrap account B's config when it does not exist yet (bundled helper, run through
# the app binary in Node mode).
if ($Mode -eq 'dual' -and -not (Test-Path -LiteralPath (Join-Path $root 'data-2\config.json'))) {
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $exe (Join-Path $root 'src\peer-setup.js') | Out-Null
    Log 'peer config bootstrapped'
  } catch {
    Log ('[WARN] peer-setup failed: ' + $_.Exception.Message)
  } finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  }
}

function Test-Port([int]$p) {
  if ($p -le 0) { return $false }
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    $okConn = $iar.AsyncWaitHandle.WaitOne(400)
    if (-not $okConn) { $c.Close(); return $false }
    $c.EndConnect($iar); $c.Close(); return $true
  } catch { return $false }
}

function Read-JsonFile([string]$file) {
  try {
    $t = Get-Content -LiteralPath $file -Raw -Encoding UTF8
    if ($t.Length -gt 0 -and [int]$t[0] -eq 0xFEFF) { $t = $t.Substring(1) }
    return ($t | ConvertFrom-Json)
  } catch { return $null }
}

# Is account A already running? (instance.lock pid alive, or its console port taken)
function Instance-Running([string]$dataDir, [int]$port) {
  $lock = Join-Path $dataDir 'instance.lock'
  if (Test-Path -LiteralPath $lock) {
    $j = Read-JsonFile $lock
    if ($j -and $j.pid) {
      try { if (Get-Process -Id ([int]$j.pid) -ErrorAction Stop) { return $true } } catch { }
    }
  }
  if ($port -gt 0 -and (Test-Port $port)) { return $true }
  return $false
}

# Start one Electron instance with the given profile / data dir.
# NOTE: environment variables are set on THIS PowerShell process so the child inherits
# them. Do not use $psi.EnvironmentVariables - on PowerShell 5.1 it reads back as null
# and every assignment silently fails (both instances then got an empty profile).
function Start-Instance([string]$profile, [string]$dataDir, [string]$title) {
  if ([string]::IsNullOrEmpty($profile)) { Remove-Item Env:QQ_AGENT_PROFILE -ErrorAction SilentlyContinue }
  else { $env:QQ_AGENT_PROFILE = $profile }
  if ([string]::IsNullOrEmpty($dataDir)) { Remove-Item Env:QQ_AGENT_DATA_DIR -ErrorAction SilentlyContinue }
  else { $env:QQ_AGENT_DATA_DIR = $dataDir }
  $env:QQ_AGENT_NO_PEER = '1'

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = '"' + (Join-Path $root '.') + '"'
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false

  Log ("start instance profile='{0}' data='{1}' ({2})" -f $profile, $dataDir, $title)
  try { [void][System.Diagnostics.Process]::Start($psi) } catch { Log ('[ERROR] start failed: ' + $_.Exception.Message) }
}

if ($Mode -eq 'dual') {
  $cfgA = Read-JsonFile (Join-Path $root 'data\config.json')
  $portA = if ($cfgA -and $cfgA.server -and $cfgA.server.port) { [int]$cfgA.server.port } else { 3210 }

  # Account A already running -> do NOT start a second copy (it would hit the instance
  # lock and exit at once, which is what "dual mode starts nothing" used to look like).
  if (Instance-Running (Join-Path $root 'data') $portA) {
    Log ("[INFO] account A already running on port $portA - skipped. Quit it first for the merged single-window mode.")
    Write-Host ("[INFO] QQ account A is already running on port {0}." -f $portA)
    Write-Host '       Quit that instance first, then run this launcher again.'
    Start-Sleep -Seconds 6
    exit 0
  }

  # Start ONLY account A, and force it to bring up account B as a HEADLESS core:
  # that gives one window with two account tabs (the "merged" mode).
  Remove-Item Env:QQ_AGENT_PROFILE -ErrorAction SilentlyContinue
  Remove-Item Env:QQ_AGENT_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:QQ_AGENT_NO_PEER -ErrorAction SilentlyContinue
  $env:QQ_AGENT_FORCE_PEER = '1'
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = '"' + (Join-Path $root '.') + '"'
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  Log ("start account A (peer forced, port $portA)")
  try { [void][System.Diagnostics.Process]::Start($psi) } catch { Log ('[ERROR] start A failed: ' + $_.Exception.Message) }

  # Wait up to 12s for account B's core; if it never comes up, fall back to starting an
  # explicit second window so the user still gets both accounts.
  $cfgB = Read-JsonFile (Join-Path $root 'data-2\config.json')
  $portB = if ($cfgB -and $cfgB.server -and $cfgB.server.port) { [int]$cfgB.server.port } else { 3211 }
  $peerUp = $false
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Port $portB) { $peerUp = $true; break }
  }
  if ($peerUp) {
    Log ("account B (peer core) is up on port $portB - one window, two account tabs")
  } else {
    Log ("[WARN] account B did not come up within 12s on port $portB - falling back to a second window")
    Start-Instance '2' (Join-Path $root 'data-2') 'account B -> data-2 (fallback window)'
  }
  Log 'dual mode done'
} else {
  Start-Instance '' '' 'account A -> data'
  Log 'instance started (single)'
}
exit 0
