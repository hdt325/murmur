# Murmur — Windows launcher (PowerShell)
# Equivalent of launch.sh for macOS

$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Dir

# Install deps if needed
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..."
    npm install --silent
}

# Install Electron deps if needed
if (-not (Test-Path "electron\node_modules")) {
    Write-Host "Installing Electron dependencies..."
    Push-Location electron
    npm install --silent
    Pop-Location
}

# Start server in background
Write-Host "Starting server..."
$server = Start-Process -NoNewWindow -PassThru -FilePath "npx" -ArgumentList "tsx", "server.ts"
Write-Host "Server started (PID $($server.Id)) on port 3457"

# Wait for server to be ready
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", 3457)
        $tcp.Close()
        $ready = $true
        break
    } catch {
        Start-Sleep -Milliseconds 200
    }
}

if (-not $ready) {
    Write-Host "Warning: Server did not start within 6 seconds"
}

# Launch Electron
Write-Host "Launching Murmur..."
Push-Location electron
npx electron .
Pop-Location

# Cleanup on exit
Write-Host "Shutting down..."
if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
