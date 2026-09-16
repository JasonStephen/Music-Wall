// Windows SMTC (System Media Transport Controls) 读取/控制脚本。
// 通过常驻 PowerShell 进程调用 WinRT Windows.Media.Control，输出逐行 JSON。
// 注意：本字符串用 String.raw 包裹，避免反斜杠被 TS 解释；脚本内不要出现反引号与 ${。

export const SMTC_SCRIPT = String.raw`param(
  [string]$Mode = 'poll',
  [string]$Action = 'toggle',
  [long]$PositionMs = 0,
  [int]$IntervalMs = 900,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSession, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionTimelineProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

$asyncOpName = 'IAsyncOperation' + [char]96 + '1'
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq $asyncOpName
})[0]

function Await($op, [Type]$type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

function Get-Manager {
  Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
}

function Pick-Session($mgr) {
  $sessions = @($mgr.GetSessions())
  if ($sessions.Count -eq 0) { return $null }
  foreach ($s in $sessions) {
    if ($s.SourceAppUserModelId -match '(?i)cloudmusic|netease|orpheus') { return $s }
  }
  $cur = $mgr.GetCurrentSession()
  if ($cur) { return $cur }
  return $sessions[0]
}

function Read-State($mgr) {
  $session = Pick-Session $mgr
  if (-not $session) {
    return [ordered]@{ supported = $true; active = $false; status = 'none' }
  }
  $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $info = $session.GetPlaybackInfo()
  $tl = $session.GetTimelineProperties()
  $status = 'none'
  try { $status = $info.PlaybackStatus.ToString().ToLower() } catch {}
  $title = ''
  $artist = ''
  $album = ''
  if ($props) {
    $title = [string]$props.Title
    $artist = [string]$props.Artist
    $album = [string]$props.AlbumTitle
  }
  $ctrl = $info.Controls
  $duration = [long]$tl.EndTime.TotalMilliseconds
  $seekable = $false
  try { $seekable = [bool]$ctrl.IsPlaybackPositionEnabled } catch {}
  return [ordered]@{
    supported  = $true
    active     = $true
    source     = [string]$session.SourceAppUserModelId
    title      = $title
    artist     = $artist
    album      = $album
    status     = $status
    positionMs = [long]$tl.Position.TotalMilliseconds
    durationMs = $duration
    seekable   = $seekable
    canPlay    = [bool]$ctrl.IsPlayEnabled
    canPause   = [bool]$ctrl.IsPauseEnabled
    canToggle  = [bool]$ctrl.IsPlayPauseToggleEnabled
    canNext    = [bool]$ctrl.IsNextEnabled
    canPrev    = [bool]$ctrl.IsPreviousEnabled
  }
}

try {
  $mgr = Get-Manager
} catch {
  Write-Output ('{"supported":false,"active":false,"status":"none","error":"' + ($_.Exception.Message -replace '[\\"]', '') + '"}')
  exit 0
}

if ($Mode -eq 'control') {
  $session = Pick-Session $mgr
  if (-not $session) {
    Write-Output '{"ok":false,"reason":"no-session"}'
    exit 0
  }
  $ok = $false
  try {
    switch ($Action) {
      'play' { $ok = Await ($session.TryPlayAsync()) ([bool]) }
      'pause' { $ok = Await ($session.TryPauseAsync()) ([bool]) }
      'toggle' {
        $st = $session.GetPlaybackInfo().PlaybackStatus.ToString().ToLower()
        if ($st -eq 'playing') { $ok = Await ($session.TryPauseAsync()) ([bool]) }
        else { $ok = Await ($session.TryPlayAsync()) ([bool]) }
      }
      'next' { $ok = Await ($session.TrySkipNextAsync()) ([bool]) }
      'prev' { $ok = Await ($session.TrySkipPreviousAsync()) ([bool]) }
      'seek' { $ok = Await ($session.TryChangePlaybackPositionAsync([long]($PositionMs * 10000))) ([bool]) }
    }
  } catch {
    Write-Output ('{"ok":false,"reason":"' + ($_.Exception.Message -replace '[\\"]', '') + '"}')
    exit 0
  }
  if ($ok) { Write-Output '{"ok":true}' } else { Write-Output '{"ok":false}' }
  exit 0
}

do {
  try {
    $state = Read-State $mgr
    Write-Output ($state | ConvertTo-Json -Compress)
  } catch {
    Write-Output ('{"supported":true,"active":false,"status":"error","error":"' + ($_.Exception.Message -replace '[\\"]', '') + '"}')
  }
  if ($Once) { break }
  Start-Sleep -Milliseconds $IntervalMs
} while ($true)
`;
