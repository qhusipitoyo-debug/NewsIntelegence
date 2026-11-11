$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bat = Join-Path $root 'publish-broker-quotes.bat'
$taskName = 'aiterminaltrading-broker-quotes'

if (-not (Test-Path $bat)) {
    throw "Publisher not found: $bat"
}

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c ""{0}""' -f $bat)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
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
    -Description 'Push MT5 broker bid/ask to the public forex board every 5 minutes while MT5 is running.' `
    -Force | Out-Null

Write-Host "Scheduled task '$taskName' created: publish-broker-quotes.bat every 5 minutes."
Write-Host "Log: $root\bridge\broker-quotes.log"
Write-Host "MT5 must be open and logged in for a quote to be published."
