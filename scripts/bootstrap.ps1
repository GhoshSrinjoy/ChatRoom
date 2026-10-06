param([switch]$SkipConda)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envRoot = Join-Path $projectRoot '.conda\chatroom'
$toolRoot = Join-Path $envRoot 'tooling'
$env:CONDA_PKGS_DIRS = Join-Path $projectRoot '.conda\pkgs'
$env:npm_config_cache = Join-Path $envRoot 'npm-cache'
if (-not $SkipConda -and -not (Test-Path -LiteralPath (Join-Path $envRoot 'node.exe'))) {
    conda.exe create --prefix $envRoot --channel conda-forge --override-channels nodejs=22 --no-default-packages -y
    if ($LASTEXITCODE -ne 0) { throw 'Conda environment creation failed.' }
}
$env:PATH = "$envRoot;$env:PATH"
New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$tooling = @{ name = 'chatroom'; version = $manifest.version; private = $true; devDependencies = $manifest.devDependencies }
$tooling | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $toolRoot 'package.json') -Encoding utf8
$lock = Join-Path $projectRoot 'package-lock.json'
if (Test-Path -LiteralPath $lock) { Copy-Item -LiteralPath $lock -Destination (Join-Path $toolRoot 'package-lock.json') -Force }
& (Join-Path $envRoot 'npm.cmd') install --prefix $toolRoot --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
Copy-Item -LiteralPath (Join-Path $toolRoot 'package-lock.json') -Destination $lock -Force
$moduleLink = Join-Path $projectRoot 'node_modules'
if (-not (Test-Path -LiteralPath $moduleLink)) {
    New-Item -ItemType Junction -Path $moduleLink -Target (Join-Path $toolRoot 'node_modules') | Out-Null
}
Write-Host "Ready. Activate with: conda activate `"$envRoot`""
Write-Host 'Dependencies are stored inside the chatroom environment. Run npm run check, npm test, and npm run package.'
