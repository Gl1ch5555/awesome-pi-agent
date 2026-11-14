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
$CmdName = "pi-awesome"
$InstallRoot = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".pi-awesome" }
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
Write-Info "install dir: $InstallRoot"
Write-Info "command:     $CmdName"

Write-Step "2/4" "Fetching $RepoOwner/$RepoName"

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-awesome-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ZipPath = Join-Path $TempDir "repo.zip"
    $ExtractDir = Join-Path $TempDir "extract"
    $Headers = @{ "User-Agent" = "awesome-pi-agent-installer" }
    if ($Token) {
        $Headers["Authorization"] = "token $Token"
        $ZipUrl = "https://api.github.com/repos/${RepoOwner}/${RepoName}/zipball/main"
    } else {
        $ZipUrl = "https://github.com/${RepoOwner}/${RepoName}/archive/refs/heads/main.zip"
    }

    $Downloaded = $false
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            Write-Info "Downloading archive (attempt $attempt/4)..."
            Invoke-WebRequest -Uri $ZipUrl -Headers $Headers -OutFile $ZipPath -UseBasicParsing
            $Downloaded = $true
            break
        } catch {
            if ($attempt -eq 4) { throw }
            Start-Sleep -Seconds 2
        }
    }

    if (-not $Downloaded) {
        throw "Failed to download source archive."
    }

    Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force
    $InnerDir = Get-ChildItem -Path $ExtractDir -Directory | Select-Object -First 1
    if (-not $InnerDir) {
        throw "Extracted archive is empty."
    }

    if (Test-Path $SrcDir) { Remove-Item -Recurse -Force $SrcDir }
    Move-Item -Path $InnerDir.FullName -Destination $SrcDir
    Write-Ok "Source extracted to $SrcDir"
} finally {
    if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue }
}

Write-Step "3/4" "Installing dependencies & building $CmdName"

Push-Location $SrcDir
try {
    Write-Info "npm install --ignore-scripts"
    npm install --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

    Write-Info "Hydrating model data & building packages"
    npm run hydrate:model-data
    if ($LASTEXITCODE -ne 0) { throw "npm run hydrate:model-data failed" }

    npm run build:offline
    if ($LASTEXITCODE -ne 0) { throw "npm run build:offline failed" }
} finally {
    Pop-Location
}
Write-Ok "Build complete"

Write-Step "4/4" "Installing $CmdName command"

$CliEntry = Join-Path $SrcDir "packages\coding-agent\dist\bundle\cli.js"
if (-not (Test-Path $CliEntry)) {
    throw "Build artifact missing: $CliEntry"
}

$CmdShim = Join-Path $BinDir "$CmdName.cmd"
$PsShim = Join-Path $BinDir "$CmdName.ps1"

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
Write-Host "Open a new terminal (or run directly) and execute: $CmdName" -ForegroundColor White
Write-Host ""
