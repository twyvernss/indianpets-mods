# Puts Node on PATH for the current PowerShell session.
#
# Usage - note the leading dot and space, which makes it run IN your shell
# instead of a child process (without it, nothing happens):
#
#   . .\tools\use-node.ps1
#
# Safe to run more than once.

$ErrorActionPreference = 'Stop'

# If a system Node is already on PATH, leave everything alone.
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "node $(node -v) already on PATH" -ForegroundColor Green
    return
}

$candidates = @(
    'C:\Temp\node\node-v24.21.0-win-x64',
    'C:\Program Files\nodejs',
    "$env:LOCALAPPDATA\Programs\nodejs"
)

$found = $candidates | Where-Object { Test-Path (Join-Path $_ 'node.exe') } | Select-Object -First 1

if (-not $found) {
    Write-Host 'No Node install found. Install Node 24+ from https://nodejs.org' -ForegroundColor Red
    Write-Host 'or edit the $candidates list at the top of this script.' -ForegroundColor Red
    return
}

$env:Path = "$found;$env:Path"
Write-Host "node $(node -v) ready (from $found)" -ForegroundColor Green
