# One-time setup to run parthib-claude on an always-on Windows laptop.
# Usage: copy this folder (with .env) to the laptop, open PowerShell *as Administrator*, then:
#   cd claude-chat; powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
Set-Location $PSScriptRoot
$BotDir = $PSScriptRoot
$TaskName = 'claude-chat'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host 'Run this from PowerShell opened with "Run as administrator".'; exit 1 }

function Stop-BotProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object CommandLine -like '*bot.js*' |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$HOME\.local\bin"
}

Write-Host '==> Node, git, gh'
foreach ($id in 'OpenJS.NodeJS.LTS', 'Git.Git', 'GitHub.cli') {
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements
}
Refresh-Path

Write-Host '==> Claude Code'
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression }
Refresh-Path

Write-Host '==> Bot dependencies'
npm install
if ($LASTEXITCODE) { exit 1 }
New-Item -ItemType Directory -Force "$HOME\projects" | Out-Null
if (-not (Test-Path .env)) { Write-Host 'Missing .env (copy it from your laptop)'; exit 1 }

Write-Host '==> GitHub login (pick your personal account, HTTPS, login with browser)'
gh auth status *> $null
if ($LASTEXITCODE) { gh auth login }
gh auth setup-git

Write-Host '==> Claude login'
claude -p 'reply ok' *> $null
if ($LASTEXITCODE) {
  Write-Host "Claude isn't logged in yet. Run 'claude', type /login, finish in the browser, then /exit and re-run this script."
  exit 1
}

Write-Host '==> Keep the laptop awake when plugged in, even with the lid closed'
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 5
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT

Write-Host '==> Start the bot at login and restart it if it crashes'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $BotDir `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$BotDir\start-windows.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Stop-BotProcess  # stop a bot left over from a previous run
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName $TaskName

Start-Sleep 8
Get-Content bot.log -Tail 5 -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "Done. Logs: Get-Content $BotDir\bot.log -Wait -Tail 20"
$killBot = 'Get-CimInstance Win32_Process -Filter "Name = ''node.exe''" | ? CommandLine -like ''*bot.js*'' | % { Stop-Process -Id $_.ProcessId -Force }'
Write-Host "Restart:    Stop-ScheduledTask $TaskName; $killBot; Start-ScheduledTask $TaskName"
Write-Host "Stop:       Stop-ScheduledTask $TaskName; $killBot; Disable-ScheduledTask $TaskName"
