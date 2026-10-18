# Run all e2e cases in headless Chrome and print a summary.
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads .ps1 as ANSI,
# so non-ASCII bytes without a BOM corrupt the parser).
# Usage: powershell -NoProfile -File tools\run-all.ps1 [-Only gf|player-ui] [-Filter keyword]
param(
  [string]$Only = "",
  [string]$Filter = ""
)
$ErrorActionPreference = "Stop"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$root = "E:\Project\Obsidian Plugin\Music Wall\tools"

$gfCases = @(
  "boot-hold", "swap", "play", "interrupt", "close-position", "queue", "total-dur",
  "blank-close", "rating-ui",
  "hitdebug", "toolbar-drawer", "wall-surface", "groups", "manual-order",
  "cross-group-move", "cross-group-targets", "shelf-panel-theme", "no-scrim",
  "editbar-clear", "section-gaps", "style-panel-order", "panel-controls", "clear-x",
  "group-picker", "interaction-walk", "drag-gate", "group-menus",
  "ungrouped-collapse", "shelf-menus", "shelf-modal-theme", "wall-edges", "theme-resist",
  "narrow-detail", "previews", "float-panels", "zoom", "dragdiag"
)
$playerCases = @("default")

$suites = @()
if ($Only -ne "player-ui") { $suites += @{ Page = "gf"; Cases = $gfCases; Height = 1000 } }
if ($Only -ne "gf") { $suites += @{ Page = "player-ui"; Cases = $playerCases; Height = 760 } }

$totalPass = 0
$failed = @()
$totalChecks = 0

foreach ($suite in $suites) {
  foreach ($case in $suite.Cases) {
    if ($Filter -and ($case -notlike "*$Filter*")) { continue }
    $html = "$root\$($suite.Page)-e2e.html".Replace("\", "/").Replace(" ", "%20")
    $url = "file:///${html}?case=$case"
    $out = "$env:TEMP\e2e-$($suite.Page)-$case.html"
    $err = "$env:TEMP\e2e-$($suite.Page)-$case.err"
    if (Test-Path $out) { Remove-Item $out -Force }
    $cargs = @(
      "--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files",
      "--window-size=1280,$($suite.Height)", "--virtual-time-budget=25000",
      "--dump-dom", $url
    )
    Start-Process -FilePath $chrome -ArgumentList $cargs -NoNewWindow -Wait `
      -RedirectStandardOutput $out -RedirectStandardError $err
    $text = [System.IO.File]::ReadAllText($out, [System.Text.UTF8Encoding]::new($false))
    $m = [regex]::Match($text, "<title>(.*?)</title>", "Singleline")
    $title = if ($m.Success) { $m.Groups[1].Value } else { "(no title)" }
    $checks = ([regex]::Matches($text, '<div class="(ok|bad)">')).Count
    $totalChecks += $checks
    if ($title -like "PASS*") {
      $totalPass++
      Write-Output ("PASS  {0,-4} {1,-22} ({2} checks)" -f $suite.Page, $case, $checks)
    } else {
      $failed += "$($suite.Page)/$case :: $title"
      Write-Output ("FAIL  {0,-4} {1,-22} {2}" -f $suite.Page, $case, $title)
    }
  }
}
Write-Output ""
Write-Output "== passed $totalPass cases / $totalChecks checks =="
if ($failed.Count) {
  Write-Output "FAILED:"
  foreach ($f in $failed) { Write-Output ("  " + $f) }
  exit 1
}
