# Awesome Pi Agent - Windows Installer
# Usage:
#   $env:PI_GH_TOKEN = "ghp_xxx"
#   $h = @{ Authorization = "token $env:PI_GH_TOKEN" }
#   irm -Headers $h "https://raw.githubusercontent.com/Gl1ch5555/awesome-pi-agent/main/install.ps1" | iex

param(
    [string]$Token = $env:PI_GH_TOKEN
)

$ErrorActionPreference = "Stop"

if (-not $Token) {
    $Token = $env:GITHUB_TOKEN
}

$RepoOwner = "Gl1ch5555"
$RepoName = "awesome-pi-agent"
$InstallRoot = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".awesome-pi-agent" }
$SrcDir = Join-Path $InstallRoot "src"
$BinDir = if ($env:PI_BIN_DIR) { $env:PI_BIN_DIR } else { Join-Path $env:USERPROFILE ".local\bin" }

function Write-Step([string]$Num, [string]$Title) {
    Write-Host ""
    Write-Host "[$Num] " -ForegroundColor Gray -NoNewline
    Write-Host $Title -ForegroundColor White
}

function Write-Ok([string]$Msg) {
    Write-Host "  ok  " -ForegroundColor Green -NoNewline
    Write-Host $Msg -ForegroundColor Gray
}

function Write-Info([string]$Msg) {
    Write-Host "  --  " -ForegroundColor DarkGray -NoNewline
    Write-Host $Msg -ForegroundColor Gray
}

function Write-Warn([string]$Msg) {
    Write-Host "  warn " -ForegroundColor Yellow -NoNewline
    Write-Host $Msg -ForegroundColor Gray
}

Write-Host ""
Write-Host "  awesome-pi-agent :: installer (windows)" -ForegroundColor White
Write-Host "  ----------------------------------------" -ForegroundColor DarkGray

Write-Step "1/4" "Checking runtime requirements"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Info "Installing Git via winget..."
        winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    } else {
        throw "git is not installed. Install Git for Windows and re-run."
    }
}
Write-Ok (git --version)

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Info "Installing Node.js LTS via winget..."
        winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    } else {
        throw "Node.js >= 22.19 is required. Install Node.js 22+ and re-run."
    }
}

$nodeRaw = (node -v).Trim().TrimStart("v")
$parts = $nodeRaw.Split(".")
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 19)) {
    throw "Node.js >= 22.19.0 is required (found v$nodeRaw)."
}
Write-Ok "node v$nodeRaw"

Write-Step "2/4" "Fetching $RepoOwner/$RepoName"

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$AuthUrl = if ($Token) {
    "https://x-access-token:${Token}@github.com/${RepoOwner}/${RepoName}.git"
} else {
    "https://github.com/${RepoOwner}/${RepoName}.git"
}
$CleanUrl = "https://github.com/${RepoOwner}/${RepoName}.git"

if (Test-Path (Join-Path $SrcDir ".git")) {
    Write-Info "Updating existing checkout in $SrcDir"
    git -C $SrcDir remote set-url origin $AuthUrl
    git -C $SrcDir fetch --depth 1 origin main
    git -C $SrcDir reset --hard origin/main
    git -C $SrcDir remote set-url origin $CleanUrl
} else {
    if (Test-Path $SrcDir) { Remove-Item -Recurse -Force $SrcDir }
    Write-Info "Cloning repository into $SrcDir"
    git clone --depth 1 $AuthUrl $SrcDir
    git -C $SrcDir remote set-url origin $CleanUrl
}
Write-Ok "Source ready"

Write-Step "3/4" "Installing dependencies & building pi"

Push-Location $SrcDir
try {
    Write-Info "npm install --ignore-scripts"
    npm install --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

    Write-Info "Building workspace packages"
    npm run build:offline
    if ($LASTEXITCODE -ne 0) { throw "npm run build:offline failed" }
} finally {
    Pop-Location
}
Write-Ok "Build complete"

Write-Step "4/4" "Installing pi command"

$CliEntry = Join-Path $SrcDir "packages\coding-agent\dist\bundle\cli.js"
if (-not (Test-Path $CliEntry)) {
    throw "Build artifact missing: $CliEntry"
}

$CmdShim = Join-Path $BinDir "pi.cmd"
$PsShim = Join-Path $BinDir "pi.ps1"

@"
@echo off
node "$CliEntry" %*
"@ | Set-Content -Path $CmdShim -Encoding ASCII

@"
#!/usr/bin/env pwsh
& node "$CliEntry" @args
"@ | Set-Content -Path $PsShim -Encoding UTF8

Write-Ok "Installed $CmdShim"

$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
$pathEntries = $userPath.Split(";") | Where-Object { $_ }
if ($pathEntries -notcontains $BinDir) {
    $newPath = ($pathEntries + $BinDir) -join ";"
    [System.Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    $env:Path = "$BinDir;$env:Path"
    Write-Ok "Added $BinDir to User PATH"
}

Write-Host ""
Write-Host "  Done. " -ForegroundColor Green -NoNewline
Write-Host "Open a new terminal (or run directly) and execute: pi" -ForegroundColor White
Write-Host ""
