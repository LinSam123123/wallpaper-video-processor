Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$CliArguments = [string[]] @($args)

function Write-WrapperFailure {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Message,

        [string[]] $Searched = @()
    )

    $payload = [ordered]@{
        code = 'E_DEPENDENCY_MISSING'
        message = $Message
        details = @{ searched = @($Searched) }
    }
    [Console]::Error.WriteLine(($payload | ConvertTo-Json -Compress -Depth 5))
    exit 3
}

function Resolve-OverrideTarget {
    param([Parameter(Mandatory = $true)][string] $Value)

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        Write-WrapperFailure -Message 'WALLPAPER_VIDEO_CLI must be one executable path or command name.' -Searched @($Value)
    }

    if (Test-Path -LiteralPath $Value -PathType Leaf) {
        return (Resolve-Path -LiteralPath $Value).ProviderPath
    }

    if ($Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        Write-WrapperFailure -Message 'WALLPAPER_VIDEO_CLI was not found. Do not include arguments or quotes in this variable.' -Searched @($Value)
    }

    $command = Get-Command -Name $Value -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        Write-WrapperFailure -Message 'WALLPAPER_VIDEO_CLI was not found.' -Searched @($Value)
    }
    return $command.Path
}

function Invoke-CliTarget {
    param(
        [Parameter(Mandatory = $true)][string] $Target,
        [string[]] $Prefix = @(),
        [string[]] $Arguments = @()
    )

    $extension = [IO.Path]::GetExtension($Target).ToLowerInvariant()
    $allowed = @('.exe', '.com', '.cmd', '.bat', '.ps1', '.js', '.mjs', '.cjs')
    if ($extension -notin $allowed) {
        Write-WrapperFailure -Message "Unsupported CLI target type: $extension" -Searched @($Target)
    }

    $global:LASTEXITCODE = 0
    if ($extension -in @('.js', '.mjs', '.cjs')) {
        $nodeCommand = Get-Command -Name node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $nodeCandidates = [Collections.Generic.List[string]]::new()
        if ($null -ne $nodeCommand) { $nodeCandidates.Add($nodeCommand.Path) }
        $nodeCandidates.Add((Join-Path $HOME '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
        $nodePath = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        if ([string]::IsNullOrWhiteSpace($nodePath)) {
            Write-WrapperFailure -Message 'Node.js is required to run the bundled CLI.' -Searched $nodeCandidates.ToArray()
        }
        & $nodePath $Target @Prefix @Arguments
    }
    else {
        & $Target @Prefix @Arguments
    }

    if (-not $?) { exit 1 }
    exit ([int] $global:LASTEXITCODE)
}

$searched = [Collections.Generic.List[string]]::new()
$override = [Environment]::GetEnvironmentVariable('WALLPAPER_VIDEO_CLI')
if (-not [string]::IsNullOrWhiteSpace($override)) {
    $target = Resolve-OverrideTarget -Value $override
    Invoke-CliTarget -Target $target -Arguments $CliArguments
}

$programRoots = @()
if ($env:LOCALAPPDATA) { $programRoots += (Join-Path $env:LOCALAPPDATA 'Programs') }
if ($env:ProgramFiles) { $programRoots += $env:ProgramFiles }
if (${env:ProgramFiles(x86)}) { $programRoots += ${env:ProgramFiles(x86)} }

$directoryNames = @('Wallpaper Video Processor', 'AI Video Wallpaper', 'AI Video Wallpaper Desktop', 'ai-video-wallpaper-desktop')
foreach ($root in ($programRoots | Select-Object -Unique)) {
    foreach ($directoryName in $directoryNames) {
        $installDirectory = Join-Path $root $directoryName
        foreach ($launcherName in @('wallpaper-video.ps1', 'wallpaper-video.cmd')) {
            $candidate = Join-Path $installDirectory $launcherName
            $searched.Add($candidate)
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                Invoke-CliTarget -Target $candidate -Arguments $CliArguments
            }
        }
    }
}

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$projectEntry = Join-Path $projectRoot 'apps\cli\dist\index.js'
$searched.Add($projectEntry)
if (Test-Path -LiteralPath $projectEntry -PathType Leaf) {
    $projectArguments = [Collections.Generic.List[string]]::new()
    foreach ($argument in $CliArguments) { $projectArguments.Add($argument) }
    $hasCacheArgument = @($CliArguments | Where-Object { $_ -eq '--cache' -or $_.StartsWith('--cache=') }).Count -gt 0
    $projectCache = Join-Path $projectRoot 'runtime'
    if (-not $hasCacheArgument -and (Test-Path -LiteralPath $projectCache -PathType Container)) {
        $projectArguments.Add('--cache')
        $projectArguments.Add($projectCache)
    }
    Invoke-CliTarget -Target $projectEntry -Arguments $projectArguments.ToArray()
}

$bundledEntry = Join-Path $PSScriptRoot 'wallpaper-video-cli.mjs'
$searched.Add($bundledEntry)
if (Test-Path -LiteralPath $bundledEntry -PathType Leaf) {
    Invoke-CliTarget -Target $bundledEntry -Arguments $CliArguments
}

Write-WrapperFailure -Message 'AI Video Wallpaper CLI was not found. Reinstall the skill, build the project CLI, install the desktop console launcher, or set WALLPAPER_VIDEO_CLI.' -Searched $searched.ToArray()
