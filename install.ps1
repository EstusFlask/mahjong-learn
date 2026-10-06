Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoDir = $PSScriptRoot
$venvDir = Join-Path $repoDir ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"

function Test-PythonVersion($pythonPath) {
    & $pythonPath -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" *> $null
    return $LASTEXITCODE -eq 0
}

function Invoke-Pip($pythonPath, [string[]]$arguments) {
    & $pythonPath -m pip @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "pip failed with exit code $LASTEXITCODE."
    }
}

try {
    if (-not (Test-Path $venvPython)) {
        $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
        if ($launcher) {
            $selectedVersion = $null
            foreach ($version in @("3.12", "3.13", "3.11", "3.10", "3.14")) {
                & $launcher.Source "-$version" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" *> $null
                if ($LASTEXITCODE -eq 0) {
                    $selectedVersion = $version
                    break
                }
            }

            if (-not $selectedVersion) {
                throw "Python 3.10 or newer was not found. Install Python and its py launcher, then run install.bat again."
            }

            & $launcher.Source "-$selectedVersion" -m venv $venvDir
        } else {
            $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
            if (-not $pythonCommand -or -not (Test-PythonVersion $pythonCommand.Source)) {
                throw "Python 3.10 or newer was not found. Install Python and add it to PATH, then run install.bat again."
            }
            & $pythonCommand.Source -m venv $venvDir
        }

        if ($LASTEXITCODE -ne 0) {
            throw "Could not create the .venv environment."
        }
    }

    if (-not (Test-Path $venvPython)) {
        throw "The .venv environment does not contain Scripts\python.exe."
    }
    if (-not (Test-PythonVersion $venvPython)) {
        throw "The existing .venv uses Python older than 3.10. Rename or remove .venv, then run install.bat again."
    }

    $pythonVersion = (& $venvPython --version).Trim()
    Write-Host "Using $pythonVersion in .venv"
    Write-Host "Installing the project and Web dependencies. The C++ extension is built from this checkout."

    Invoke-Pip $venvPython @("install", "--upgrade", "pip")
    try {
        Invoke-Pip $venvPython @("install", "--editable", $repoDir, "--no-cache-dir", "--force-reinstall")
    } catch {
        Write-Host "The source build failed. Verify Visual Studio Build Tools with the C++ workload and Internet access, then run install.bat again." -ForegroundColor Yellow
        Write-Host "CMake is provided by the Python build system." -ForegroundColor Yellow
        throw
    }
    Invoke-Pip $venvPython @("install", "-r", (Join-Path $repoDir "web\requirements.txt"))

    & $venvPython -c "import fastapi, numpy, pymahjong, sse_starlette, uvicorn, MahjongPyWrapper as pm; missing = [name for name in ('normal_round_to_win', 'is_ordinary_agari') if not hasattr(pm, name)]; raise SystemExit('Missing current MahjongPyWrapper API: ' + ', '.join(missing) if missing else 0)"
    if ($LASTEXITCODE -ne 0) {
        throw "The installation completed, but the Python bindings failed validation. Run install.bat again or review the build output."
    }

    Write-Host "Installation complete. Double-click start.bat to launch the game."
    exit 0
} catch {
    Write-Host "Installation failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
