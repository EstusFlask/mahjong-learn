param(
    [string]$PythonPath,
    # Accepted here so install.bat can forward its arguments unchanged.
    [switch]$NoPause
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoDir = $PSScriptRoot
$venvDir = Join-Path $repoDir ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$runtimeDir = Join-Path $repoDir ".runtime"
$logPath = Join-Path $runtimeDir "install.log"
$transcriptStarted = $false
$locationPushed = $false
$exitCode = 1

function Test-Python([string]$pythonPath, [string[]]$prefixArgs = @()) {
    # Windows PowerShell 5.1 turns redirected native stderr into errors.
    # A missing launcher version is an expected probe failure; try the next one.
    $ErrorActionPreference = "Continue"
    try {
        & $pythonPath @prefixArgs -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) and sys.maxsize > 2**32 else 1)" *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Invoke-LoggedPython([string]$pythonPath, [string[]]$arguments) {
    $ErrorActionPreference = "Continue"
    # Explicitly write native output to the host so PowerShell 5.1 transcribes it.
    & $pythonPath @arguments 2>&1 |
        ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                Write-Host $_.Exception.Message
            } else {
                Write-Host "$_"
            }
        }
    return $LASTEXITCODE
}

function Invoke-Pip([string]$pythonPath, [string[]]$arguments) {
    $pipExit = Invoke-LoggedPython $pythonPath (@("-m", "pip", "--disable-pip-version-check") + $arguments)
    if ($pipExit -ne 0) {
        throw "pip failed with exit code $pipExit. See $logPath."
    }
}

try {
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    Start-Transcript -Path $logPath -Force | Out-Null
    $transcriptStarted = $true
    Push-Location -LiteralPath $repoDir
    $locationPushed = $true
    Write-Host "Installation log: $logPath"
    Write-Host "[1/4] Preparing the Python environment..."

    if (-not (Test-Path -LiteralPath $venvPython)) {
        $basePython = $null
        $baseArgs = @()
        if ($PythonPath) {
            if (-not (Test-Python $PythonPath)) {
                throw "-PythonPath must point to a working 64-bit Python 3.10+ executable."
            }
            $basePython = $PythonPath
        } else {
            $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
            if ($launcher) {
                foreach ($version in @("3.12", "3.13", "3.11", "3.10", "3.14")) {
                    if (Test-Python $launcher.Source @("-$version")) {
                        $basePython = $launcher.Source
                        $baseArgs = @("-$version")
                        break
                    }
                }
            }
            if (-not $basePython) {
                foreach ($name in @("python.exe", "python3.exe")) {
                    $pythonCommand = Get-Command $name -ErrorAction SilentlyContinue
                    if ($pythonCommand -and (Test-Python $pythonCommand.Source)) {
                        $basePython = $pythonCommand.Source
                        break
                    }
                }
            }
        }
        if (-not $basePython) {
            throw "64-bit Python 3.10+ was not found. Install Python 3.12, or use install.bat -PythonPath C:\path\python.exe."
        }
        $venvExit = Invoke-LoggedPython $basePython ($baseArgs + @("-m", "venv", $venvDir))
        if ($venvExit -ne 0) {
            throw "Could not create the .venv environment."
        }
    } elseif ($PythonPath) {
        Write-Host "Reusing .venv; -PythonPath only selects Python when creating a new environment."
    }

    if (-not (Test-Python $venvPython)) {
        throw "The existing .venv is invalid or is not 64-bit Python 3.10+. Rename .venv as a backup, then run install.bat again."
    }
    $pythonVersion = (& $venvPython --version).Trim()
    Write-Host "Using $pythonVersion in .venv"

    Write-Host "[2/4] Preparing pip..."
    # Environments created by uv can exist without pip.
    & $venvPython -c "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('pip') else 1)"
    if ($LASTEXITCODE -ne 0) {
        $ensurePipExit = Invoke-LoggedPython $venvPython @("-m", "ensurepip", "--upgrade")
        if ($ensurePipExit -ne 0) {
            throw "Could not install pip into .venv."
        }
    }
    Invoke-Pip $venvPython @("install", "--upgrade", "pip")

    Write-Host "[3/4] Building this checkout and installing Web dependencies..."
    Write-Host "Visual Studio C++ Build Tools is required. CMake is supplied by the Python build system."
    # Keep installed dependencies and download/build caches; only rebuild this project.
    # Use a separate persistent build directory for each Python/architecture wheel tag.
    Invoke-Pip $venvPython @(
        "install", "--verbose", "--editable", $repoDir,
        "--config-settings=build-dir=.runtime/build/{wheel_tag}",
        "-r", (Join-Path $repoDir "web\requirements.txt")
    )

    Write-Host "[4/4] Checking dependencies and the Web server imports..."
    Invoke-Pip $venvPython @("check")
    # Validate from the same directory as start.ps1, not only the repository root.
    Push-Location -LiteralPath (Join-Path $repoDir "web")
    try {
        $validateWeb = @'
import fastapi, numpy, scipy, torch, pymahjong, sse_starlette, uvicorn
import MahjongPyWrapper as pm
missing = [name for name in ('normal_round_to_win', 'is_ordinary_agari') if not hasattr(pm, name)]
if missing:
    raise SystemExit('Missing current MahjongPyWrapper API: ' + ', '.join(missing))
import server
print('Python package: ' + pymahjong.__file__)
print('C++ bindings: ' + pm.__file__)
'@
        $validationExit = Invoke-LoggedPython $venvPython @("-c", $validateWeb)
        if ($validationExit -ne 0) {
            throw "The Web server or C++ bindings failed validation. Review $logPath."
        }
    } finally {
        Pop-Location
    }

    Write-Host "Installation complete. Double-click start.bat to launch the game."
    $exitCode = 0
} catch {
    Write-Host "Installation failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Log: $logPath"
} finally {
    if ($locationPushed) {
        Pop-Location
    }
    if ($transcriptStarted) {
        Stop-Transcript | Out-Null
    }
}
exit $exitCode
