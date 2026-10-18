# 运行 e2e 场景（无头 Chrome），打印 <title> 结果
# 用法: powershell -NoProfile -File tools\run-case.ps1 -Page gf -Case wall-edges
param(
  [string]$Page = "gf",
  [string]$Case = "wall-edges",
  [int]$Height = 1000
)
$ErrorActionPreference = "Stop"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$root = $PSScriptRoot
$html = "$root\$Page-e2e.html".Replace("\", "/").Replace(" ", "%20")
$url = "file:///${html}?case=$Case"
$out = "$env:TEMP\e2e-$Page-$Case.html"
$err = "$env:TEMP\e2e-$Page-$Case.err"
if (Test-Path $out) { Remove-Item $out -Force }
$args = @(
  "--headless=new", "--disable-gpu", "--no-sandbox",
  # 允许读取 file:// 下的样式表规则（document.styleSheets[].cssRules）：
  # theme-resist 场景要断言「hover 规则带 !important」，而无头环境无法真的悬停
  "--allow-file-access-from-files",
  "--window-size=1280,$Height",
  "--virtual-time-budget=25000",
  "--dump-dom", $url
)
Start-Process -FilePath $chrome -ArgumentList $args -NoNewWindow -Wait `
  -RedirectStandardOutput $out -RedirectStandardError $err
$text = [System.IO.File]::ReadAllText($out, [System.Text.UTF8Encoding]::new($false))
$m = [regex]::Match($text, "<title>(.*?)</title>", "Singleline")
$title = if ($m.Success) { $m.Groups[1].Value } else { "(no title)" }
Write-Output "TITLE: $title"
# 逐条结果（PASS/FAIL 行）也打出来
$rows = [regex]::Matches($text, '<div class="(ok|bad)">(.*?)</div>', "Singleline")
foreach ($r in $rows) {
  $line = $r.Groups[2].Value -replace "&lt;", "<" -replace "&gt;", ">" -replace "&amp;", "&" -replace "&quot;", '"'
  Write-Output ("  " + $line)
}
