# Sample average colors from a screenshot region (System.Drawing, no extra deps).
# NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
# Usage: powershell -NoProfile -File tools\sample.ps1 -Path tools\shots\player-art.png -X 60 -Y 120 -W 700 -H 120
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 100,
  [int]$H = 100
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$full = (Resolve-Path $Path).Path
$bmp = New-Object System.Drawing.Bitmap($full)
try {
  $r = 0; $g = 0; $b = 0; $n = 0
  $maxS = 0.0
  for ($y = $Y; $y -lt ($Y + $H) -and $y -lt $bmp.Height; $y += 2) {
    for ($x = $X; $x -lt ($X + $W) -and $x -lt $bmp.Width; $x += 2) {
      $c = $bmp.GetPixel($x, $y)
      $r += $c.R; $g += $c.G; $b += $c.B; $n++
      $mx = [Math]::Max($c.R, [Math]::Max($c.G, $c.B))
      $mn = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
      if ($mx -gt 0) {
        $s = ($mx - $mn) / [double]$mx
        if ($s -gt $maxS) { $maxS = $s }
      }
    }
  }
  if ($n -eq 0) { Write-Output "no pixels"; exit 1 }
  $ar = [Math]::Round($r / $n); $ag = [Math]::Round($g / $n); $ab = [Math]::Round($b / $n)
  $mx = [Math]::Max($ar, [Math]::Max($ag, $ab))
  $mn = [Math]::Min($ar, [Math]::Min($ag, $ab))
  $sat = if ($mx -gt 0) { [Math]::Round(($mx - $mn) / [double]$mx, 3) } else { 0 }
  Write-Output ("avg=rgb({0},{1},{2}) saturation={3} maxSaturation={4} pixels={5}" -f $ar, $ag, $ab, $sat, [Math]::Round($maxS, 3), $n)
} finally {
  $bmp.Dispose()
}
