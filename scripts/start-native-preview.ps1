$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ((Split-Path -Qualifier $projectRoot) -ne 'E:') { throw 'This preview must run from drive E.' }
Set-Location -LiteralPath $projectRoot
$runtimePath = Join-Path $projectRoot '.local\runtime'
$temporaryPath = Join-Path $projectRoot '.local\tmp'
New-Item -ItemType Directory -Path $temporaryPath -Force | Out-Null
$env:TEMP = $temporaryPath
$env:TMP = $temporaryPath
$env:npm_config_cache = Join-Path $projectRoot '.local\npm-cache'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $projectRoot '.local\playwright-browsers'

function Test-LocalPort([int] $Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try { return $client.ConnectAsync('127.0.0.1', $Port).Wait(1000) -and $client.Connected }
  catch { return $false }
  finally { $client.Dispose() }
}
function Wait-LocalPort([int] $Port) {
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (Test-LocalPort $Port) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "Local service did not start on port $Port. Review logs in $runtimePath."
}
function Assert-OwnedService([string] $PidFile, [string] $Executable) {
  if (!(Test-Path -LiteralPath $PidFile)) { throw 'Port occupied without an owned service PID.' }
  $serviceProcessId = [int](Get-Content -LiteralPath $PidFile -Raw).Trim()
  $serviceProcess = Get-Process -Id $serviceProcessId -ErrorAction Stop
  if ($serviceProcess.Path -ne $Executable) { throw 'Owned service executable does not match.' }
}

$mysqlExecutable = Join-Path $runtimePath 'mysql\mysql-8.4.13-winx64\bin\mysqld.exe'
$sfuExecutable = Join-Path $runtimePath 'livekit\livekit-server.exe'
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
foreach ($requiredFile in @($mysqlExecutable, $sfuExecutable, (Join-Path $runtimePath 'native-preview.env'), (Join-Path $runtimePath 'native-preview-access.json'))) {
  if (!(Test-Path -LiteralPath $requiredFile)) { throw "Required local runtime file is missing: $requiredFile" }
}
if (Test-LocalPort 23306) {
  Assert-OwnedService (Join-Path $runtimePath 'mysql.pid') $mysqlExecutable
} else {
  Start-Process -FilePath $mysqlExecutable -ArgumentList @(('--defaults-file="' + (Join-Path $runtimePath 'mysql.ini') + '"'), ('--pid-file="' + (Join-Path $runtimePath 'mysql.pid') + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
  Wait-LocalPort 23306
  Assert-OwnedService (Join-Path $runtimePath 'mysql.pid') $mysqlExecutable
}
if (Test-LocalPort 37890) {
  Assert-OwnedService (Join-Path $runtimePath 'preview-sfu.pid') $sfuExecutable
} else {
  & $nodeExecutable (Join-Path $projectRoot 'scripts\prepare-native-preview-media.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the local preview media configuration.' }
  $sfuProcess = Start-Process -FilePath $sfuExecutable -ArgumentList @('--config', ('"' + (Join-Path $runtimePath 'preview-livekit.yaml') + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'preview-sfu.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'preview-sfu.stderr.log') -PassThru
  Set-Content -LiteralPath (Join-Path $runtimePath 'preview-sfu.pid') -Value $sfuProcess.Id
  Wait-LocalPort 37890
}
if (Test-LocalPort 5174) {
  Assert-OwnedService (Join-Path $runtimePath 'preview.pid') $nodeExecutable
} else {
  $previewProcess = Start-Process -FilePath $nodeExecutable -ArgumentList @('--import', 'tsx', 'scripts/native-preview.ts') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'preview.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'preview.stderr.log') -PassThru
  Set-Content -LiteralPath (Join-Path $runtimePath 'preview.pid') -Value $previewProcess.Id
  Wait-LocalPort 5174
}
Write-Output 'Persistent MySQL preview: http://localhost:5174'
Write-Output 'Local sign-in details: .local/runtime/native-preview-access.json'
