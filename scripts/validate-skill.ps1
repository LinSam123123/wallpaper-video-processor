[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$validator = Join-Path $codexHome "skills\.system\skill-creator\scripts\quick_validate.py"
$skillPath = Join-Path $projectRoot "skill\make-video-wallpaper"

function Test-RepositorySkill {
    $requiredFiles = @(
        "SKILL.md",
        "agents\openai.yaml",
        "references\parameters.md",
        "scripts\invoke-wallpaper-video.ps1",
        "scripts\wallpaper-video-cli.mjs"
    )
    foreach ($relativePath in $requiredFiles) {
        $path = Join-Path $skillPath $relativePath
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Required skill file is missing: $relativePath"
        }
    }

    $skillText = Get-Content -LiteralPath (Join-Path $skillPath "SKILL.md") -Raw
    $frontmatter = [regex]::Match(
        $skillText,
        '\A---\r?\n(?<yaml>.*?)\r?\n---\r?\n',
        [Text.RegularExpressions.RegexOptions]::Singleline
    )
    if (-not $frontmatter.Success) { throw "SKILL.md must start with YAML frontmatter." }
    if ($frontmatter.Groups["yaml"].Value -notmatch '(?m)^name:\s*make-video-wallpaper\s*$') {
        throw "SKILL.md frontmatter must declare name: make-video-wallpaper."
    }
    if ($frontmatter.Groups["yaml"].Value -notmatch '(?m)^description:\s*\S.+$') {
        throw "SKILL.md frontmatter must include a non-empty description."
    }

    $agentText = Get-Content -LiteralPath (Join-Path $skillPath "agents\openai.yaml") -Raw
    foreach ($field in @("display_name", "short_description", "default_prompt")) {
        if ($agentText -notmatch "(?m)^\s*$field\s*:\s*\S.+$") {
            throw "agents/openai.yaml is missing interface.$field."
        }
    }
    if ($agentText -notmatch '\$make-video-wallpaper') {
        throw "agents/openai.yaml default_prompt must invoke `$make-video-wallpaper."
    }

    $bundle = Get-Item -LiteralPath (Join-Path $skillPath "scripts\wallpaper-video-cli.mjs")
    if ($bundle.Length -lt 1024) { throw "Bundled CLI is unexpectedly small." }
    Write-Host "Skill structure is valid (repository fallback)."
}

if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) {
    Test-RepositorySkill
    exit 0
}

$bundledPython = Join-Path $HOME ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$python = if (Test-Path -LiteralPath $bundledPython -PathType Leaf) {
    $bundledPython
} else {
    (Get-Command python.exe -CommandType Application -ErrorAction Stop).Path
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

$bootstrap = "import runpy,sys; sys.path.insert(0,sys.argv[1]); script=sys.argv[2]; skill=sys.argv[3]; sys.argv=[script,skill]; runpy.run_path(script,run_name='__main__')"
& $python -I -c $bootstrap $validatorPackages $validator $skillPath
exit $LASTEXITCODE
