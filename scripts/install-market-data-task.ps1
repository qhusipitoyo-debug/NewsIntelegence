$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bat = Join-Path $root 'publish-market-data.bat'
$taskName = 'aiterminaltrading-market-data'

if (-not (Test-Path $bat)) {
    throw "Publisher not found: $bat"
}

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c ""{0}""' -f $bat)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 15) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Run aiterminaltrading fetcher and push live market data every 15 minutes while this Windows user is logged on.' `
    -Force | Out-Null

Write-Host "Scheduled task '$taskName' created: publish-market-data.bat every 15 minutes."
Write-Host "Log: $root\bridge\market-data.log"
Write-Host "Node and direct internet access are required on this PC."
