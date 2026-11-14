# Awesome Pi Agent - Windows Installer (prebuilt binary first, source fallback)
# Usage:
#   irm https://raw.githubusercontent.com/Gl1ch5555/awesome-pi-agent/main/install.ps1 | iex

param(
    [string]$Token = $env:PI_GH_TOKEN,
    [switch]$Source
)

$ErrorActionPreference = "Stop"

if (-not $Token) {
    $Token = $env:GITHUB_TOKEN
}

$RepoOwner = "Gl1ch5555"
$RepoName = "awesome-pi-agent"
$CmdName = "pi-awesome"
$InstallRoot = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".pi-awesome" }
$AppDir = Join-Path $InstallRoot "app"
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

Write-Step "1/3" "Detecting platform & install paths"

$Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) { "arm64" } else { "x64" }
$AssetName = "pi-windows-$Arch.zip"
$ReleaseBase = "https://github.com/$RepoOwner/$RepoName/releases/download/latest"

Write-Ok "platform windows-$Arch"
Write-Info "install dir: $InstallRoot"
Write-Info "command:     $CmdName"

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-awesome-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

$PrebuiltOk = $false

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $Headers = @{ "User-Agent" = "awesome-pi-agent-installer" }
    if ($Token) { $Headers["Authorization"] = "token $Token" }

    if (-not $Source -and $env:PI_FORCE_SOURCE -ne "1") {
        Write-Step "2/3" "Downloading prebuilt binary ($AssetName)"
        $ZipPath = Join-Path $TempDir $AssetName
        $StageDir = Join-Path $TempDir "stage"

        try {
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                try {
                    Write-Info "Downloading $AssetName (attempt $attempt/3)..."
                    Invoke-WebRequest -Uri "$ReleaseBase/$AssetName" -Headers $Headers -OutFile $ZipPath -UseBasicParsing
                    break
                } catch {
                    if ($attempt -eq 3) { throw }
                    Start-Sleep -Seconds 2
                }
            }

            Expand-Archive -Path $ZipPath -DestinationPath $StageDir -Force
            $ExePath = Join-Path $StageDir "pi.exe"
            if (Test-Path $ExePath) {
                if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
                $VersionsDir = Join-Path $InstallRoot "versions"
                if (Test-Path $VersionsDir) { Remove-Item -Recurse -Force $VersionsDir -ErrorAction SilentlyContinue }
                Move-Item -Path $StageDir -Destination $AppDir
                $PrebuiltOk = $true
                Write-Ok "Installed prebuilt binary into $AppDir"
            }
        } catch {
            Write-Warn "Prebuilt release download failed, falling back to source build..."
        }
    }

    $CmdShim = Join-Path $BinDir "$CmdName.cmd"
    $PsShim = Join-Path $BinDir "$CmdName.ps1"

    if ($PrebuiltOk) {
        Write-Step "3/3" "Linking $CmdName & saving version metadata"
        $AppExe = Join-Path $AppDir "pi.exe"

        @"
@echo off
"$AppExe" %*
"@ | Set-Content -Path $CmdShim -Encoding ASCII

        @"
#!/usr/bin/env pwsh
& "$AppExe" @args
"@ | Set-Content -Path $PsShim -Encoding UTF8

        Write-Ok "Installed $CmdShim"

        try {
            Invoke-WebRequest -Uri "$ReleaseBase/version.json" -Headers $Headers -OutFile (Join-Path $InstallRoot "version.json") -UseBasicParsing -TimeoutSec 10
        } catch {
            @{ version = "1.5.2"; tag = "latest"; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json | Set-Content -Path (Join-Path $InstallRoot "version.json") -Encoding UTF8
        }
    } else {
        Write-Step "2/3" "Building from source (Node.js >= 22.19 required)"
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
            if (Get-Command winget -ErrorAction SilentlyContinue) {
                Write-Info "Installing Node.js LTS via winget..."
                winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
            } else {
                throw "Node.js >= 22.19 is required for source fallback."
            }
        }

        $ZipPath = Join-Path $TempDir "repo.zip"
        $ExtractDir = Join-Path $TempDir "extract"
        $ZipUrl = if ($Token) { "https://api.github.com/repos/$RepoOwner/$RepoName/zipball/main" } else { "https://github.com/$RepoOwner/$RepoName/archive/refs/heads/main.zip" }
        Invoke-WebRequest -Uri $ZipUrl -Headers $Headers -OutFile $ZipPath -UseBasicParsing
        Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force
        $InnerDir = Get-ChildItem -Path $ExtractDir -Directory | Select-Object -First 1
        if (Test-Path $SrcDir) { Remove-Item -Recurse -Force $SrcDir }
        Move-Item -Path $InnerDir.FullName -Destination $SrcDir

        Push-Location $SrcDir
        try {
            npm install --ignore-scripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
            npm run hydrate:model-data
            if ($LASTEXITCODE -ne 0) { Write-Warn "Online model catalog refresh skipped (using bundled models)" }
            npm run build:offline
            if ($LASTEXITCODE -ne 0) { throw "npm run build:offline failed" }
        } finally {
            Pop-Location
        }

        Write-Step "3/3" "Installing $CmdName command"
        $CliEntry = Join-Path $SrcDir "packages\coding-agent\dist\bundle\cli.js"
        @"
@echo off
node "$CliEntry" %*
"@ | Set-Content -Path $CmdShim -Encoding ASCII
        @"
#!/usr/bin/env pwsh
& node "$CliEntry" @args
"@ | Set-Content -Path $PsShim -Encoding UTF8
        Write-Ok "Installed $CmdShim"

        try {
            $commitMeta = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoOwner/$RepoName/commits/main" -Headers $Headers -TimeoutSec 5
            $pkgMeta = Get-Content (Join-Path $SrcDir "packages\coding-agent\package.json") -Raw | ConvertFrom-Json
            if ($commitMeta.sha) {
                @{ sha = $commitMeta.sha; version = $pkgMeta.version; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json | Set-Content -Path (Join-Path $InstallRoot "version.json") -Encoding UTF8
            }
        } catch {}
    }
} finally {
    if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue }
}

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
