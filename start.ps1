param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8000,
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoDir = $PSScriptRoot
$webDir = Join-Path $repoDir "web"
$venvPython = Join-Path $repoDir ".venv\Scripts\python.exe"
$server = $null

try {
    if (-not (Test-Path $venvPython)) {
        throw "The Python environment is missing. Run install.bat first."
    }

    Push-Location $webDir
    & $venvPython -c "import fastapi, numpy, pymahjong, sse_starlette, uvicorn, MahjongPyWrapper as pm; import server; missing = [name for name in ('normal_round_to_win', 'is_ordinary_agari') if not hasattr(pm, name)]; raise SystemExit('Missing current MahjongPyWrapper API: ' + ', '.join(missing) if missing else 0)"
    if ($LASTEXITCODE -ne 0) {
        throw "The project dependencies or C++ bindings are not ready. Run install.bat again."
    }

    $url = "http://127.0.0.1:$Port"
    $portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $portProbe.ExclusiveAddressUse = $true
    try {
        $portProbe.Start()
    } catch {
        throw "Port $Port is already in use or unavailable. Stop the existing server or choose another port."
    } finally {
        $portProbe.Stop()
    }

    $server = Start-Process -FilePath $venvPython `
        -ArgumentList @("-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "$Port") `
        -WorkingDirectory $webDir -PassThru -NoNewWindow
    # Retain the process handle so its exit code remains available after it stops.
    $null = $server.Handle

    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $server.Refresh()
        if ($server.HasExited) {
            throw "The Web server stopped during startup. Check the server output for details."
        }
        try {
            $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2
            if ($health.status -eq "ok") {
                $ready = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }

    if (-not $ready) {
        throw "The Web server did not become ready at $url. The port may already be in use."
    }

    if (-not $NoBrowser) {
        Start-Process $url
    }
    Write-Host "Mahjong is running at $url. Press Ctrl+C to stop the server."
    Wait-Process -Id $server.Id
    $server.Refresh()
    if ($server.ExitCode -ne 0) {
        throw "The Web server exited with code $($server.ExitCode). Check the server output for details."
    }
} catch {
    Write-Host "Could not start Mahjong: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($server) {
        $server.Refresh()
        if (-not $server.HasExited) {
            Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
        }
    }
    if ((Get-Location).Path -eq $webDir) {
        Pop-Location
    }
}
