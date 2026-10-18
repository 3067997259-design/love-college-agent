[CmdletBinding()]
param(
    [ValidateSet('Judges', 'Visitors', 'Rehearsal')]
    [string]$Mode = 'Visitors',
    [string]$AppPath,
    [switch]$OpaqueMini,
    [switch]$InspectOnly
)

$ErrorActionPreference = 'Stop'
if (-not $AppPath) { $AppPath = Read-Host 'Full path to the installed LoveCollegeAgent.exe' }
$AppPath = $AppPath.Trim().Trim('"')
$appFile = Get-Item -LiteralPath $AppPath
if ($appFile.PSIsContainer -or $appFile.Name -ne 'LoveCollegeAgent.exe') {
    throw 'Select the installed LoveCollegeAgent.exe, not the installer.'
}
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable.' }
$baseDir = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'LCA-Demo-20261018'))
$demoDir = [IO.Path]::GetFullPath((Join-Path $baseDir $Mode.ToLowerInvariant()))
if (-not $demoDir.StartsWith($baseDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Invalid demo path.'
}
$markerPath = Join-Path $demoDir 'lca-demo-mode.txt'
$settingsPath = Join-Path $demoDir 'settings.json'
$isRehearsal = $Mode -eq 'Rehearsal'
$isBooth = $Mode -eq 'Visitors'
if (Test-Path -LiteralPath $demoDir) {
    if (-not (Test-Path -LiteralPath $markerPath)) { throw 'Existing directory is not owned by this launcher. No files changed.' }
    if ((Get-Content -LiteralPath $markerPath -Raw).Trim() -ne $Mode) { throw 'Demo mode marker mismatch. No files changed.' }
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if ($settings.developer -ne $isRehearsal -or $settings.booth -ne $isBooth) {
        throw 'The app mode was changed in settings. Restore its original mode before using this shortcut.'
    }
}
Write-Output ('Mode: ' + $Mode)
Write-Output ('Application: ' + $appFile.FullName)
Write-Output ('Separate data root: ' + $demoDir)
if ($InspectOnly) { Write-Output 'Inspection only. No app launched and no files written.'; return }
if (-not (Test-Path -LiteralPath $demoDir)) {
    New-Item -ItemType Directory -Path $demoDir -Force | Out-Null
    $settings = [ordered]@{ version = 1; developer = $isRehearsal; booth = $isBooth; plugins = @{}; fileFilteringEnabled = $false }
    [IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($markerPath, $Mode, [Text.UTF8Encoding]::new($false))
}

# Child-only setup: do not inherit a real profile, external MCP config or hidden-test mode.
$savedEnv = @{}
$names = @('ELECTRON_RUN_AS_NODE') + @(Get-ChildItem Env: | Where-Object { $_.Name -like 'LCA_*' } | ForEach-Object Name)
$names += @('LCA_DATA_DIR', 'LCA_BOOTH', 'LCA_TEST_SILENT', 'LCA_PROVIDERS_FILE', 'LCA_CDP_PORT', 'LCA_MCP_PORT', 'LCA_MINI_OPAQUE')
$names = @($names | Select-Object -Unique)
foreach ($name in $names) {
    $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
try {
    $env:LCA_DATA_DIR = $demoDir
    $env:LCA_TEST_SILENT = '0'
    $env:LCA_PROVIDERS_FILE = Join-Path $demoDir 'connections\no-provider-fallback.json'
    if ($isBooth) { $env:LCA_BOOTH = '1' }
    if ($isRehearsal) { $env:LCA_CDP_PORT = '9627'; $env:LCA_MCP_PORT = '5375' }
    if ($OpaqueMini) { $env:LCA_MINI_OPAQUE = '1' }
    # This is the interactive application explicitly requested by the operator.
    $launched = Start-Process -FilePath $appFile.FullName -WorkingDirectory $appFile.DirectoryName -WindowStyle Normal -PassThru
    Write-Output ('Launch requested. PID: ' + $launched.Id)
    Write-Output 'Configure providers inside this separate book. No credentials or personal data were copied.'
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process') }
}
