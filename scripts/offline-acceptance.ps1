param(
  [ValidateSet('Check', 'Fresh', 'Upgrade')][string]$Mode = 'Check',
  [string]$Bundle = $PSScriptRoot,
  [string]$WorkRoot = (Join-Path $env:LOCALAPPDATA 'LCA-Acceptance'),
  [switch]$SkipUi
)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $Bundle 'manifest.json') -Raw | ConvertFrom-Json
$runId = [guid]::NewGuid().ToString()
$base = [IO.Path]::GetFullPath($WorkRoot)
$run = Join-Path $base $runId
$install = Join-Path $run 'installed'
if ($base -match '[,&]' -or [IO.Path]::GetFullPath($Bundle) -match '[,&]') { throw 'ACCEPTANCE_PATH_UNSUPPORTED: use a writable path without comma or ampersand.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'WINDOWS_X64_REQUIRED' }
New-Item -ItemType Directory -Path $run | Out-Null
$report = [ordered]@{ schema = 1; runId = $runId; mode = $Mode; osVersion = [Environment]::OSVersion.Version.ToString(); startedAt = [DateTime]::UtcNow.ToString('o'); candidate = $manifest.candidate; baseline = $manifest.baseline; syntheticOnly = $true; realServices = $false; offline = $true; installed = $false; upgraded = $false; manualUi = 'not-run'; probes = @(); cleanup = 'not-needed'; status = 'running'; error = $null }
$ownsInstall = $false
$savedEnv = @{}
function Set-TestEnv([string]$name, [string]$value) { if (-not $savedEnv.ContainsKey($name)) { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }; [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
function Assert-Hash([string]$path, [string]$expected) { if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected.ToLowerInvariant()) { throw 'HASH_MISMATCH' } }
function Get-Installation {
  @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') | ForEach-Object {
    if (Test-Path -LiteralPath $_) { Get-ChildItem -LiteralPath $_ | Get-ItemProperty | Where-Object { $_.DisplayName -like 'Love College Agent*' } }
  }
}
function Invoke-Hidden([string]$exe, [string[]]$arguments, [int]$timeout = 300000) {
  $p = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru -WindowStyle Hidden
  $null = $p.Handle
  if (-not $p.WaitForExit($timeout)) { $p.Kill(); throw 'PROCESS_TIMEOUT_RECONCILE_BEFORE_RETRY' }
  $p.Refresh(); if ($p.ExitCode -ne 0) { throw 'PROCESS_EXIT_FAILED' }
}
function Assert-OwnInstallation {
  $found = @(Get-Installation)
  # electron-builder NSIS does not always write InstallLocation. Require both exact registered paths.
  if ($found.Count -ne 1 -or $found[0].DisplayIcon -ne ((Join-Path $install 'LoveCollegeAgent.exe') + ',0') -or $found[0].UninstallString -ne ('"' + (Join-Path $install 'Uninstall LoveCollegeAgent.exe') + '" /currentuser')) { throw 'INSTALLATION_OWNERSHIP_MISMATCH' }
}
function Install-Version($item, [switch]$Upgrade) {
  if ($Upgrade) { Assert-OwnInstallation } elseif (@(Get-Installation).Count) { throw 'EXISTING_INSTALLATION_REFUSED' }
  Assert-Hash (Join-Path $Bundle $item.file) $item.sha256
  # /D must be last. It consumes the rest of NSIS's command line, including spaces.
  Invoke-Hidden (Join-Path $Bundle $item.file) @('/S', '/currentuser', ('/D=' + $install))
  $script:ownsInstall = $true
  Assert-OwnInstallation
  Assert-Hash (Join-Path $install 'resources/app.asar') $item.asarSha256
}
function Use-Profile([string]$name) {
  $profile = Join-Path $run $name
  New-Item -ItemType Directory -Path $profile -Force | Out-Null
  Set-TestEnv 'LCA_DATA_DIR' $profile
  Set-TestEnv 'LCA_PROVIDERS_FILE' (Join-Path $profile 'absent-providers.json')
  Set-TestEnv 'LCA_MCP_PORT' '0'; Set-TestEnv 'LCA_CDP_PORT' '0'
}
function Run-Probe([string]$name) {
  Use-Profile ('probe-' + $name)
  $out = Join-Path $run ($name + '.stdout.local'); $err = Join-Path $run ($name + '.stderr.local')
  $p = Start-Process -FilePath (Join-Path $install 'LoveCollegeAgent.exe') -ArgumentList ('--lca-probe=' + $name) -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $p.Handle
  if (-not $p.WaitForExit(300000)) { $p.Kill(); throw 'PROBE_TIMEOUT' }; $p.Refresh()
  $line = Get-Content -LiteralPath $out | Where-Object { $_.StartsWith('LCA_PROBE:') } | Select-Object -First 1
  if (-not $line) { throw 'PROBE_REPORT_MISSING' }
  $result = $line.Substring(10) | ConvertFrom-Json
  $report.probes += [ordered]@{ name = $name; exitCode = $p.ExitCode; result = $result }
  if ($p.ExitCode -ne 0 -or -not $result.ok) { throw 'PROBE_FAILED' }
  Write-Host ('PASS ' + $name)
}
function Open-Book([string]$label) {
  if ($SkipUi) { return }
  Use-Profile 'book'
  Set-TestEnv 'LCA_TEST_SILENT' '0'
  Write-Host ($label + ': follow README.txt, then fully close the book to continue. No model configuration is needed.')
  # This visible window is intentional: the operator explicitly runs an interactive acceptance.
  $p = Start-Process -FilePath (Join-Path $install 'LoveCollegeAgent.exe') -PassThru
  $null = $p.Handle
  $p.WaitForExit(); $p.Refresh()
  if ($p.ExitCode -ne 0) { throw 'UI_EXIT_FAILED' }
  Set-TestEnv 'LCA_TEST_SILENT' '1'
}
try {
  foreach ($entry in $manifest.files) { Assert-Hash (Join-Path $Bundle $entry.file) $entry.sha256 }
  $report.hashesVerified = $true
  if ($Mode -ne 'Check') {
    if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($run)).AvailableFreeSpace -lt 3GB) { throw 'INSUFFICIENT_DISK_SPACE' }
    if (@(Get-Installation).Count) { throw 'EXISTING_INSTALLATION_REFUSED' }
    if (Get-Process -Name LoveCollegeAgent -ErrorAction SilentlyContinue) { throw 'RUNNING_APP_REFUSED' }
    # Suppress inherited test/service switches, and use isolated HOME as well as app data.
    foreach ($key in @('LCA_REAL_MODEL', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'LCA_BOOTH')) { Set-TestEnv $key $null }
    foreach ($key in @('HOME', 'USERPROFILE')) { Set-TestEnv $key (Join-Path $run 'home') }
    New-Item -ItemType Directory -Path (Join-Path $run 'home/Documents') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $run 'tmp') -Force | Out-Null
    Set-TestEnv 'TEMP' (Join-Path $run 'tmp'); Set-TestEnv 'TMP' (Join-Path $run 'tmp')
    Set-TestEnv 'LCA_TEST_SILENT' '1'
    if ($Mode -eq 'Upgrade') { Use-Profile 'book'; Install-Version $manifest.baseline; Open-Book '1.1.0 before upgrade'; Install-Version $manifest.candidate -Upgrade; $report.upgraded = $true }
    else { Use-Profile 'book'; Install-Version $manifest.candidate }
    $report.installed = $true
    foreach ($name in @('sqlite', 'journal', 'backup', 'memory', 'questions', 'dsh-spike')) { Run-Probe $name }
    Open-Book 'Candidate first start'
    Open-Book 'Candidate cold restart'
    if (-not $SkipUi) { $answer = Read-Host 'Did all README visual/persistence checks pass? Enter Y, N, or U (uncertain)'; $report.manualUi = switch ($answer.ToUpperInvariant()) { 'Y' { 'operator-pass' } 'N' { 'operator-fail' } default { 'uncertain' } } }
  }
  $report.status = if ($report.manualUi -eq 'operator-fail') { 'manual-failed' } else { 'automated-passed' }
} catch {
  $report.status = 'failed'
  $code = $_.Exception.Message
  $report.error = if ($code -match '^[A-Z_]+$') { $code } else { 'ACCEPTANCE_FAILED_DETAILS_LOCAL_ONLY' }
  Write-Host ('FAILED: ' + $report.error)
} finally {
  if ($ownsInstall) {
    try {
      Assert-OwnInstallation
      $uninstaller = @(Get-ChildItem -LiteralPath $install -File -Filter 'Uninstall *.exe')
      if ($uninstaller.Count -ne 1) { throw 'UNINSTALLER_NOT_UNIQUE' }
      Invoke-Hidden $uninstaller[0].FullName @('/S', '/currentuser')
      if (@(Get-Installation).Count) { throw 'UNINSTALL_NOT_RECONCILED' }
      $report.cleanup = 'uninstalled-owned-test-only'
    } catch { $report.cleanup = 'needs-local-reconciliation'; $report.status = 'failed' }
  }
  foreach ($key in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key], 'Process') }
  $report.completedAt = [DateTime]::UtcNow.ToString('o')
  $reportPath = Join-Path $run 'result.json'
  $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  # Only the safe structured receipt goes back. Profiles, raw logs and private-save contents stay local.
  Compress-Archive -LiteralPath $reportPath -DestinationPath (Join-Path $run 'return-results.zip')
  Write-Host ('RESULT: ' + (Join-Path $run 'return-results.zip'))
}
if ($report.status -in @('failed', 'manual-failed')) { exit 1 }
