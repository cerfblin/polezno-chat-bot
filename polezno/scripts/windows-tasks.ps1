param(
    [ValidateSet('Plan', 'Install', 'Start', 'Stop', 'Status', 'Uninstall')][string]$Action = 'Plan',
    [string]$NodePath
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try { $projectHash = ([BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 12) }
finally { $hashAlgorithm.Dispose() }
$taskPrefix = "Polezno-$projectHash"
$description = "Managed by Polezno at $projectRoot"
$taskNames = @("$taskPrefix-Bot", "$taskPrefix-Backup")
function Get-OwnedTask([string]$name) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task -and $task.Description -ne $description) { throw 'Task name belongs to another installation' }
    return $task
}
foreach ($name in $taskNames) { $null = Get-OwnedTask $name }
if ($Action -eq 'Plan') {
    [pscustomobject]@{ Applied = $false; Tasks = $taskNames; BotTrigger = 'Current user logon'; RestartDelaySeconds = 60; BackupTrigger = 'Daily 03:00 local time and current user logon'; BackupDeletion = 'Disabled'; RunLevel = 'Limited' } | ConvertTo-Json
    exit 0
}
if ($Action -eq 'Install') {
    if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
    $nodeExecutable = (Resolve-Path -LiteralPath $NodePath).Path
    if ([IO.Path]::GetFileName($nodeExecutable) -ne 'node.exe') { throw 'Node executable required' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
    $runnerPath = Join-Path $PSScriptRoot 'windows-run.ps1'
    foreach ($mode in @('Bot', 'Backup')) {
        $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runnerPath + '" -Mode ' + $mode + ' -NodePath "' + $nodeExecutable + '"'
        $taskAction = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $projectRoot
        $triggers = @(New-ScheduledTaskTrigger -AtLogOn -User $identity)
        if ($mode -eq 'Backup') { $triggers += New-ScheduledTaskTrigger -Daily -At '03:00' }
        $limit = if ($mode -eq 'Bot') { [TimeSpan]::Zero } else { New-TimeSpan -Minutes 10 }
        $retryCount = if ($mode -eq 'Bot') { 999 } else { 3 }
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit $limit -RestartCount $retryCount -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName "$taskPrefix-$mode" -Action $taskAction -Trigger $triggers -Settings $settings -Principal $principal -Description $description -Force | Out-Null
    }
} elseif ($Action -eq 'Start') {
    foreach ($name in $taskNames) { if (-not (Get-OwnedTask $name)) { throw 'Install tasks first' } }
    foreach ($name in $taskNames) { Start-ScheduledTask -TaskName $name }
} elseif ($Action -eq 'Stop' -or $Action -eq 'Uninstall') {
    foreach ($name in $taskNames) {
        if (Get-OwnedTask $name) {
            Stop-ScheduledTask -TaskName $name
            if ($Action -eq 'Uninstall') { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
        }
    }
}
$taskStatus = foreach ($name in $taskNames) {
    $task = Get-OwnedTask $name
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $name
        [pscustomobject]@{ TaskName = $name; State = [string]$task.State; LastResult = $info.LastTaskResult; NextRun = $info.NextRunTime }
    }
}
$taskStatus | ConvertTo-Json
