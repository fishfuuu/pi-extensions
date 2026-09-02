<#
.SYNOPSIS
    Install Pi extensions from canonical source to Pi agent extensions directory.

.DESCRIPTION
    Copies extension source from this repository to ~/.pi/agent/extensions/
    Supports individual or bulk installation with optional update mode.

.PARAMETER Plugin
    Extension name: pi-check, pi-quota, pi-db, pi-tool-presets, or 'all'

.PARAMETER Update
    Allow overwriting existing installation (creates backup first)

.PARAMETER DryRun
    Show what would be done without making changes

.EXAMPLE
    .\scripts\install.ps1 pi-db
    Install pi-db extension (fails if already exists)

.EXAMPLE
    .\scripts\install.ps1 pi-db -Update
    Update existing pi-db installation (creates backup)

.EXAMPLE
    .\scripts\install.ps1 all
    Install all extensions
#>

param(
    [Parameter(Mandatory=$true, Position=0)]
    [ValidateSet('pi-check', 'pi-quota', 'pi-db', 'pi-tool-presets', 'all')]
    [string]$Plugin,

    [switch]$Update,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Configuration
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ExtensionsSource = Join-Path $RepoRoot "extensions"
$DestinationRoot = Join-Path $HOME ".pi\agent\extensions"
$BackupRoot = Join-Path $DestinationRoot ".backups"

# Allowed plugins
$AllowedPlugins = @('pi-check', 'pi-quota', 'pi-db', 'pi-tool-presets')

# Files/directories to exclude from copy
$Exclusions = @(
    '.git',
    'node_modules',
    '.env',
    '.env.*',
    'logs',
    'coverage',
    'cache',
    'temp',
    '*.log'
)

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function Install-Extension {
    param(
        [string]$PluginName,
        [bool]$AllowUpdate,
        [bool]$IsDryRun
    )

    $Source = Join-Path $ExtensionsSource $PluginName
    $Destination = Join-Path $DestinationRoot $PluginName

    # Validate source exists
    if (-not (Test-Path $Source)) {
        Write-Fail "Source not found: $Source"
        return $false
    }

    Write-Info "Installing $PluginName..."
    if ($IsDryRun) { Write-Warn "DRY RUN - no changes will be made" }

    # Check if destination exists
    $DestinationExists = Test-Path $Destination

    if ($DestinationExists -and -not $AllowUpdate) {
        Write-Fail "Destination already exists: $Destination"
        Write-Info "Use -Update flag to overwrite (creates backup)"
        return $false
    }

    # Backup existing installation if updating
    if ($DestinationExists -and $AllowUpdate) {
        $Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $BackupPath = Join-Path $BackupRoot "$PluginName-$Timestamp"
        
        Write-Info "Backing up existing installation to: $BackupPath"
        
        if (-not $IsDryRun) {
            if (-not (Test-Path $BackupRoot)) {
                New-Item -ItemType Directory -Path $BackupRoot | Out-Null
            }
            Copy-Item -Path $Destination -Destination $BackupPath -Recurse -Force
            Write-Success "Backup created"
        }
    }

    # Copy source to destination
    Write-Info "Copying from: $Source"
    Write-Info "Copying to: $Destination"

    if (-not $IsDryRun) {
        if ($DestinationExists) {
            Remove-Item -Path $Destination -Recurse -Force
        }

        # Create destination parent directory if needed
        $DestinationParent = Split-Path -Parent $Destination
        if (-not (Test-Path $DestinationParent)) {
            New-Item -ItemType Directory -Path $DestinationParent | Out-Null
        }

        # Copy with exclusions
        $CopyParams = @{
            Path = $Source
            Destination = $Destination
            Recurse = $true
            Force = $true
            Exclude = $Exclusions
        }
        Copy-Item @CopyParams

        Write-Success "Files copied"
    }

    # Install dependencies if package.json exists
    $PackageJson = Join-Path $Destination "package.json"
    if (Test-Path $PackageJson) {
        Write-Info "Found package.json - installing dependencies"
        
        if (-not $IsDryRun) {
            Push-Location $Destination
            try {
                $PackageLock = Join-Path $Destination "package-lock.json"
                if (Test-Path $PackageLock) {
                    Write-Info "Running: npm ci"
                    npm ci 2>&1 | Out-Null
                } else {
                    Write-Info "Running: npm install"
                    npm install 2>&1 | Out-Null
                }
                Write-Success "Dependencies installed"
            }
            catch {
                Write-Fail "Dependency installation failed: $_"
                return $false
            }
            finally {
                Pop-Location
            }
        }
    }

    Write-Success "$PluginName installation complete"
    return $true
}

# Main execution
Write-Info "Pi Extensions Installer"
Write-Info "Repository: $RepoRoot"
Write-Info "Destination: $DestinationRoot"
Write-Info ""

$PluginsToInstall = if ($Plugin -eq 'all') { $AllowedPlugins } else { @($Plugin) }

$AllSuccess = $true
foreach ($PluginName in $PluginsToInstall) {
    $Success = Install-Extension -PluginName $PluginName -AllowUpdate $Update.IsPresent -IsDryRun $DryRun.IsPresent
    if (-not $Success) {
        $AllSuccess = $false
    }
    Write-Host ""
}

if ($AllSuccess) {
    Write-Success "Installation complete!"
    if (-not $DryRun.IsPresent) {
        Write-Info "Run '/reload' in Pi to load the updated extensions"
    }
    exit 0
} else {
    Write-Fail "Installation failed for one or more extensions"
    exit 1
}
