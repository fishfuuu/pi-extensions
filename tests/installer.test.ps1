# Deterministic installer verification for scripts/install.ps1.
#
# Run from the repo root (Windows PowerShell):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer.test.ps1
#
# Every scenario runs the REAL installer in a child powershell with HOME,
# HOMEDRIVE, HOMEPATH and USERPROFILE pointed at a temp sandbox, so the
# destination root is sandbox\.pi\agent\extensions and the real
# ~/.pi/agent/extensions is never touched. A guard aborts the run if that
# isolation ever fails.
#
# The pi-db / `all` scenarios run `npm ci` and need registry access; every
# other scenario is a pure file copy.

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Installer = Join-Path $RepoRoot "scripts/install.ps1"
$TestRoot = Join-Path $env:TEMP ("pi-extensions-installer-test-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path $TestRoot | Out-Null
# Child installers legitimately write to stderr (npm, native tools); do not
# let the PS 5.1 NativeCommandError gotcha turn that into a harness abort.
$ErrorActionPreference = "Continue"

$script:Passed = 0
$script:Failed = 0
$origHOME = $env:HOME
$origHOMEDRIVE = $env:HOMEDRIVE
$origHOMEPATH = $env:HOMEPATH
$origUSERPROFILE = $env:USERPROFILE

function Ok {
    param([string]$Name, [bool]$Condition, [string]$Detail = "")
    if ($Condition) {
        $script:Passed++
        Write-Host "PASS $Name"
    } else {
        $script:Failed++
        Write-Host "FAIL $Name$(if ($Detail) { " -- $Detail" })"
    }
}

function New-SandboxHome {
    param([string]$Name)
    $home_ = Join-Path $TestRoot $Name
    New-Item -ItemType Directory -Path $home_ | Out-Null
    return $home_
}

function Invoke-Installer {
    param([string]$SandboxHome, [string[]]$Arguments, [string]$Script = $Installer)
    $drive = [IO.Path]::GetPathRoot($SandboxHome).TrimEnd("\")
    $env:HOME = $SandboxHome
    $env:HOMEDRIVE = $drive
    $env:HOMEPATH = $SandboxHome.Substring($drive.Length)
    $env:USERPROFILE = $SandboxHome
    try {
        $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $Script @Arguments 2>&1
        $code = $LASTEXITCODE
    } finally {
        $env:HOME = $origHOME
        $env:HOMEDRIVE = $origHOMEDRIVE
        $env:HOMEPATH = $origHOMEPATH
        $env:USERPROFILE = $origUSERPROFILE
    }
    return [pscustomobject]@{ ExitCode = $code; Output = ($out | ForEach-Object { "$_" }) -join "`n" }
}

function Get-DestinationRoot {
    param([string]$SandboxHome)
    return Join-Path $SandboxHome ".pi\agent\extensions"
}

function Remove-SandboxRoot {
    # Freshly written node_modules can hold a transient handle; retry a few
    # times and never fail the run over temp hygiene.
    for ($i = 0; $i -lt 3; $i++) {
        Remove-Item -Path $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $TestRoot)) { return }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "WARN: could not remove test sandbox $TestRoot (temp hygiene only)"
}

# ---- guard: HOME isolation must actually reach the child powershell ----
$sandboxHome = New-SandboxHome "guard"
$drive = [IO.Path]::GetPathRoot($sandboxHome).TrimEnd("\")
$env:HOME = $sandboxHome
$env:HOMEDRIVE = $drive
$env:HOMEPATH = $sandboxHome.Substring($drive.Length)
$env:USERPROFILE = $sandboxHome
$probeHome = (& powershell -NoProfile -Command 'Write-Output $HOME') | Select-Object -First 1
$env:HOME = $origHOME
$env:HOMEDRIVE = $origHOMEDRIVE
$env:HOMEPATH = $origHOMEPATH
$env:USERPROFILE = $origUSERPROFILE
if ("$probeHome".Trim() -ne $sandboxHome) {
    Remove-SandboxRoot
    Write-Host "ABORT: child powershell HOME is '$probeHome', expected sandbox '$sandboxHome'. HOME isolation does not work on this host; refusing to run installer tests."
    exit 1
}
Ok "child powershell resolves isolated HOME" $true

# ---- scenario 1: selector install, quota absent -> quota auto-installed ----
$sandboxHome = New-SandboxHome "s1-selector-queue-dep"
$result = Invoke-Installer -SandboxHome $sandboxHome -Arguments @("pi-worker-selector")
$dest = Get-DestinationRoot $sandboxHome
Ok "s1 installer exits 0" ($result.ExitCode -eq 0) $result.Output
Ok "s1 output announces the queued dependency" ($result.Output -match "queueing it first") $result.Output
Ok "s1 pi-quota installed" (Test-Path (Join-Path $dest "pi-quota\index.ts")) (Get-ChildItem $dest -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Out-String)
Ok "s1 pi-worker-selector installed" (Test-Path (Join-Path $dest "pi-worker-selector\index.ts")) $result.Output
$dirs = (Get-ChildItem $dest -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ","
Ok "s1 destination contains exactly quota + selector" ($dirs -eq "pi-quota,pi-worker-selector") $dirs
Ok "s1 installer destination was inside the sandbox" ($result.Output -match [regex]::Escape($dest)) $result.Output

# canary: the selector's cross-directory import must resolve from the sandbox copy
$selectorTs = Join-Path $dest "pi-worker-selector\index.ts"
$selectorUrl = ([System.Uri] $selectorTs).AbsoluteUri
$importOut = & node --input-type=module -e "try { await import('$selectorUrl'); console.log('IMPORT-OK'); } catch (e) { console.log('IMPORT-FAILED: ' + String(e.message).split('\n')[0]); process.exit(1); }"
Ok "s1 selector cross-directory import resolves in sandbox" (($LASTEXITCODE -eq 0) -and ("$importOut" -match "IMPORT-OK")) ("$importOut")

# ---- scenario 2: selector install, quota already present -> untouched ----
$sandboxHome = New-SandboxHome "s2-quota-untouched"
$dest = Get-DestinationRoot $sandboxHome
New-Item -ItemType Directory -Path (Join-Path $dest "pi-quota") -Force | Out-Null
Set-Content -Path (Join-Path $dest "pi-quota\PRE-EXISTING.txt") -Value "marker"
$result = Invoke-Installer -SandboxHome $sandboxHome -Arguments @("pi-worker-selector")
$quotaDirListing = (Get-ChildItem (Join-Path $dest "pi-quota") | ForEach-Object { $_.Name }) -join ","
Ok "s2 installer exits 0" ($result.ExitCode -eq 0) $result.Output
Ok "s2 selector installed next to existing quota" (Test-Path (Join-Path $dest "pi-worker-selector\index.ts")) $result.Output
Ok "s2 existing pi-quota left untouched" ($quotaDirListing -eq "PRE-EXISTING.txt") $quotaDirListing

# ---- scenario 3: selector -Update -> only selector updated, quota untouched ----
$sandboxHome = New-SandboxHome "s3-update-selector-only"
$dest = Get-DestinationRoot $sandboxHome
$null = Invoke-Installer -SandboxHome $sandboxHome -Arguments @("pi-quota")
$null = Invoke-Installer -SandboxHome $sandboxHome -Arguments @("pi-worker-selector")
Set-Content -Path (Join-Path $dest "pi-quota\PRE-EXISTING.txt") -Value "marker"
Set-Content -Path (Join-Path $dest "pi-worker-selector\STALE.txt") -Value "stale"
$result = Invoke-Installer -SandboxHome $sandboxHome -Arguments @("pi-worker-selector", "-Update")
Ok "s3 update exits 0" ($result.ExitCode -eq 0) $result.Output
Ok "s3 stale selector file removed (update really ran)" (-not (Test-Path (Join-Path $dest "pi-worker-selector\STALE.txt"))) "STALE.txt survived"
Ok "s3 selector reinstalled" (Test-Path (Join-Path $dest "pi-worker-selector\index.ts")) $result.Output
Ok "s3 pi-quota not touched by selector -Update" (Test-Path (Join-Path $dest "pi-quota\PRE-EXISTING.txt")) "marker vanished"

# ---- scenario 4: DryRun shows the dependency plan, writes nothing ----
$sandboxHome = New-SandboxHome "s4-dryrun"
$result = Invoke-Installer -SandboxHome $sandboxHome -Arguments @("pi-worker-selector", "-DryRun")
$dest = Get-DestinationRoot $sandboxHome
Ok "s4 dryrun exits 0" ($result.ExitCode -eq 0) $result.Output
Ok "s4 dryrun announces the dependency plan" ($result.Output -match "queueing it first") $result.Output
Ok "s4 dryrun writes nothing" (-not (Test-Path (Join-Path $dest "pi-quota")) -and -not (Test-Path (Join-Path $dest "pi-worker-selector"))) (Get-ChildItem $dest -ErrorAction SilentlyContinue | Out-String)

# ---- scenario 5: dependency install failure -> selector skipped, non-zero ----
$sandboxHome = New-SandboxHome "s5-fail-fast"
$repoCopy = Join-Path $sandboxHome "repo"
New-Item -ItemType Directory -Path $repoCopy | Out-Null
Copy-Item -Path (Join-Path $RepoRoot "scripts") -Destination $repoCopy -Recurse
Copy-Item -Path (Join-Path $RepoRoot "extensions") -Destination $repoCopy -Recurse
Remove-Item -Path (Join-Path $repoCopy "extensions\pi-quota") -Recurse -Force
$result = Invoke-Installer -SandboxHome $sandboxHome -Arguments @("pi-worker-selector") -Script (Join-Path $repoCopy "scripts\install.ps1")
$dest = Get-DestinationRoot $sandboxHome
Ok "s5 exits non-zero" ($result.ExitCode -ne 0) "exit=$($result.ExitCode)"
Ok "s5 names the skipped dependent" ($result.Output -match "Skipping pi-worker-selector") $result.Output
Ok "s5 selector NOT installed on failed dependency" (-not (Test-Path (Join-Path $dest "pi-worker-selector"))) (Get-ChildItem $dest -ErrorAction SilentlyContinue | Out-String)

# ---- scenario 6: all other plugins unchanged ----
foreach ($plugin in @("pi-check", "pi-quota", "pi-tools-stats", "pi-bash-guard", "pi-tool-presets")) {
    $sandboxHome = New-SandboxHome "s6-$plugin"
    $result = Invoke-Installer -SandboxHome $sandboxHome -Arguments @($plugin)
    $dest = Get-DestinationRoot $sandboxHome
    $dirs = (Get-ChildItem $dest -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ","
    Ok "s6 $plugin installs alone" (($result.ExitCode -eq 0) -and ($dirs -eq $plugin)) "exit=$($result.ExitCode) dirs=$dirs"
}

# pi-db single (runs npm ci inside the sandbox destination)
$sandboxHome = New-SandboxHome "s6-pi-db"
$result = Invoke-Installer -SandboxHome $sandboxHome -Arguments @("pi-db")
$dest = Get-DestinationRoot $sandboxHome
$dirs = (Get-ChildItem $dest -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ","
Ok "s6 pi-db installs alone" (($result.ExitCode -eq 0) -and ($dirs -eq "pi-db")) "exit=$($result.ExitCode) dirs=$dirs"

# `all` keeps the default set (check, quota, db) and nothing else
$sandboxHome = New-SandboxHome "s6-all"
$result = Invoke-Installer -SandboxHome $sandboxHome -Arguments @("all")
$dest = Get-DestinationRoot $sandboxHome
$dirs = (Get-ChildItem $dest -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ","
$expected = "pi-check,pi-db,pi-quota"  # Get-ChildItem sorts alphabetically
Ok "s6 all installs exactly the default set" (($result.ExitCode -eq 0) -and ($dirs -eq $expected)) "exit=$($result.ExitCode) dirs=$dirs"

# re-install without -Update still fails with "already exists"
$result = Invoke-Installer -SandboxHome $sandboxHome -Arguments @("pi-check")
Ok "s6 second install without -Update still fails" (($result.ExitCode -ne 0) -and ($result.Output -match "already exists")) "exit=$($result.ExitCode)"

# ---- summary / cleanup ----
if ($script:Failed -eq 0) {
    Remove-SandboxRoot
    Write-Host "$($script:Passed)/$($script:Passed) installer tests passed"
    exit 0
} else {
    Write-Host "$($script:Passed) passed, $($script:Failed) failed -- sandbox kept at $TestRoot"
    exit 1
}
