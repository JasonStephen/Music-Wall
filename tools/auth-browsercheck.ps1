# Build tools/auth-e2e.ts first. Uses an isolated temporary Chrome profile.
$ErrorActionPreference = 'Stop'
$chromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$caseRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path.Replace('\', '/').Replace(' ', '%20')
node (Join-Path $PSScriptRoot 'auth-browsercheck.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node (Join-Path $PSScriptRoot 'auth-browsercheck.mjs') --player
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$cases = @(
  @{ Name = 'previews'; Page = 'gf'; Query = 'case=previews'; Width = 1280; Height = 1000 },
  @{ Name = 'shelf-play'; Page = 'gf'; Query = 'case=play'; Width = 1280; Height = 1000 }
)
$failedCases = @()
foreach ($case in $cases) {
  $outputPath = Join-Path $env:TEMP ('mw-' + $case.Name + '.html')
  $errorPath = Join-Path $env:TEMP ('mw-' + $case.Name + '.err')
  $profilePath = Join-Path $env:TEMP ('mw-browser-' + $case.Name)
  $arguments = @(
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', ('--user-data-dir=' + $profilePath),
    ('--window-size=' + $case.Width + ',' + $case.Height), '--virtual-time-budget=25000',
    '--dump-dom', ('file:///' + $caseRoot + '/' + $case.Page + '-e2e.html?' + $case.Query)
  )
  $process = Start-Process -FilePath $chromePath -ArgumentList $arguments -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $outputPath -RedirectStandardError $errorPath
  if (!$process.WaitForExit(45000)) {
    Stop-Process -Id $process.Id
    throw ('Browser timed out: ' + $case.Name)
  }
  $process.WaitForExit()
  $html = $null
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try { $html = [System.IO.File]::ReadAllText($outputPath); break }
    catch [System.IO.IOException] { Start-Sleep -Milliseconds 100 }
  }
  if ($null -eq $html) { throw ('Cannot read browser output: ' + $case.Name) }
  $title = [regex]::Match($html, '<title>(.*?)</title>').Groups[1].Value
  if ($title -like 'PASS*') { Write-Output ('PASS ' + $case.Name + ': ' + $title) }
  else {
    $failedCases += $case.Name
    Write-Output ('FAIL ' + $case.Name + ': ' + $title)
    Get-Content -LiteralPath $errorPath -Tail 4
    [regex]::Matches($html, '<div class="bad">(.*?)</div>') | ForEach-Object { Write-Output $_.Groups[1].Value }
  }
}
if ($failedCases.Count) { exit 1 }
