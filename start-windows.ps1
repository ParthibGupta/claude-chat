# Runs the bot and restarts it if it crashes. Started at login by the scheduled task from setup-windows.ps1.
Set-Location $PSScriptRoot
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$HOME\.local\bin"
# Forward slashes so paths in the bot's prompt survive Claude's Git Bash shell.
if (-not $env:PROJECTS_DIR) { $env:PROJECTS_DIR = "$HOME\projects" -replace '\\', '/' }
while ($true) {
  cmd /c "npm start >> bot.log 2>&1"
  Add-Content bot.log "bot exited with code $LASTEXITCODE, restarting in 5s"
  Start-Sleep 5
}
