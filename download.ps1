$ProgressPreference = 'SilentlyContinue'
$dir = 'C:\Users\HP\bitget-hackathon\data'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$symbols = 'BTCUSDT','ETHUSDT'
# 24 months: 2024-06 .. 2026-05
$months = @()
foreach ($y in 2024,2025,2026) {
  foreach ($m in 1..12) {
    $ym = '{0:d4}-{1:d2}' -f $y,$m
    if ($ym -ge '2024-06' -and $ym -le '2026-05') { $months += $ym }
  }
}

$ok = 0; $fail = @()
foreach ($sym in $symbols) {
  foreach ($ym in $months) {
    $csvOut = Join-Path $dir "$sym-1h-$ym.csv"
    if (Test-Path $csvOut) { $ok++; continue }
    $url = "https://data.binance.vision/data/futures/um/monthly/klines/$sym/1h/$sym-1h-$ym.zip"
    $zip = Join-Path $dir "tmp.zip"
    try {
      Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 90
      Expand-Archive -Path $zip -DestinationPath $dir -Force
      Remove-Item $zip -Force
      $ok++
    } catch { $fail += "$sym-$ym" }
  }
}
Remove-Item (Join-Path $dir 'test.csv') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dir 'test.zip') -ErrorAction SilentlyContinue
$csvCount = (Get-ChildItem $dir -Filter '*.csv').Count
"Downloaded/exist OK rows: $ok | CSV files: $csvCount | months: $($months.Count)"
if ($fail.Count -gt 0) { "FAILED: $($fail -join ', ')" } else { "No failures." }