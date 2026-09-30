[CmdletBinding()]
param(
    [string]$DestinationRoot = $(
        if ($env:CODEX_HOME) {
            Join-Path $env:CODEX_HOME "skills"
        } else {
            Join-Path (Join-Path $HOME ".codex") "skills"
        }
    )
)

$ErrorActionPreference = "Stop"
$source = Join-Path (Split-Path -Parent $PSScriptRoot) "skill\make-video-wallpaper"
$destinationRootFull = [IO.Path]::GetFullPath($DestinationRoot)
$destination = [IO.Path]::GetFullPath((Join-Path $destinationRootFull "make-video-wallpaper"))
$staging = "$destination.staging"
$backup = "$destination.backup"
$rootPrefix = $destinationRootFull.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

foreach ($target in @($destination, $staging, $backup)) {
    if (-not $target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the selected skills directory: $target"
    }
}

if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Skill source not found: $source"
}
$bundledCli = Join-Path $source "scripts\wallpaper-video-cli.mjs"
if (-not (Test-Path -LiteralPath $bundledCli -PathType Leaf)) {
    throw "Bundled skill CLI not found. Run npm run skill:bundle first: $bundledCli"
}

New-Item -ItemType Directory -Path $destinationRootFull -Force | Out-Null

if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
}

Copy-Item -LiteralPath $source -Destination $staging -Recurse -Force
if (Test-Path -LiteralPath $destination) {
    if (Test-Path -LiteralPath $backup) {
        Remove-Item -LiteralPath $backup -Recurse -Force
    }
    try {
        Move-Item -LiteralPath $destination -Destination $backup
        Move-Item -LiteralPath $staging -Destination $destination
        Remove-Item -LiteralPath $backup -Recurse -Force
    } catch {
        if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $destination)) {
            Move-Item -LiteralPath $backup -Destination $destination
        }
        throw
    }
} else {
    Move-Item -LiteralPath $staging -Destination $destination
}

Write-Output "Installed make-video-wallpaper to $destination"
