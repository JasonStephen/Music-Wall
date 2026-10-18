# Screenshot one harness page (visual check only).
# NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
# Usage: powershell -NoProfile -File tools\shot.ps1 -Page gf -Case shot-shelf -Out shelf-menu.png
param(
  [string]$Page = "gf",
  [string]$Case = "shot-shelf",
  [string]$Out = "shot.png",
  [int]$Height = 1000
)
$ErrorActionPreference = "Stop"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$root = $PSScriptRoot
$html = "$root\$Page-e2e.html".Replace("\", "/").Replace(" ", "%20")
$url = "file:///${html}?case=$Case"
$png = Join-Path $env:TEMP "mw-shot-$Page-$Case.png"
New-Item -ItemType Directory -Force -Path "$root\shots" | Out-Null
$dest = "$root\shots\$Out"
if (Test-Path $png) { Remove-Item $png -Force }
$cargs = @(
  "--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files",
  "--hide-scrollbars", "--force-device-scale-factor=1",
  "--window-size=1280,$Height", "--virtual-time-budget=20000",
  "--screenshot=$png", $url
)
$err = "$env:TEMP\shot-$Page-$Case.err"
Start-Process -FilePath $chrome -ArgumentList $cargs -NoNewWindow -Wait `
  -RedirectStandardOutput "$env:TEMP\shot-$Page-$Case.out" -RedirectStandardError $err
if (Test-Path $png) {
  Copy-Item $png $dest -Force
  Write-Output "saved: $dest"
} else {
  Write-Output "FAILED: no screenshot produced"
  Get-Content $err | Select-Object -First 3
  exit 1
}
