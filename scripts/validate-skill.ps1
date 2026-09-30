[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$validator = Join-Path $codexHome "skills\.system\skill-creator\scripts\quick_validate.py"
$bundledPython = Join-Path $HOME ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$python = if (Test-Path -LiteralPath $bundledPython -PathType Leaf) {
    $bundledPython
} else {
    (Get-Command python.exe -CommandType Application -ErrorAction Stop).Path
}

if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) {
    throw "Skill validator not found: $validator"
}

$pyYamlVersion = "6.0.2"
$validatorPackages = if ($env:WALLPAPER_SKILL_VALIDATOR_PYTHONPATH) {
    [IO.Path]::GetFullPath($env:WALLPAPER_SKILL_VALIDATOR_PYTHONPATH)
} else {
    $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
    Join-Path $localAppData "AI Video Wallpaper\developer\pyyaml-$pyYamlVersion"
}

function Test-PyYaml {
    param([Parameter(Mandatory = $true)][string] $PackagePath)

    if (-not (Test-Path -LiteralPath $PackagePath -PathType Container)) { return $false }
    $probe = "import sys; sys.path.insert(0, sys.argv[1]); import yaml; assert yaml.__version__ == sys.argv[2]; assert callable(yaml.safe_load)"
    & $python -I -c $probe $PackagePath $pyYamlVersion 2>$null
    return $LASTEXITCODE -eq 0
}

if (-not (Test-PyYaml -PackagePath $validatorPackages)) {
    New-Item -ItemType Directory -Path $validatorPackages -Force | Out-Null
    & $python -I -m pip install --disable-pip-version-check --no-deps --only-binary=:all: --upgrade --target $validatorPackages "PyYAML==$pyYamlVersion"
    if ($LASTEXITCODE -ne 0 -or -not (Test-PyYaml -PackagePath $validatorPackages)) {
        throw "Could not provision PyYAML $pyYamlVersion for the official skill validator."
    }
}

$skillPath = Join-Path $projectRoot "skill\make-video-wallpaper"
$bootstrap = "import runpy,sys; sys.path.insert(0,sys.argv[1]); script=sys.argv[2]; skill=sys.argv[3]; sys.argv=[script,skill]; runpy.run_path(script,run_name='__main__')"
& $python -I -c $bootstrap $validatorPackages $validator $skillPath
exit $LASTEXITCODE
