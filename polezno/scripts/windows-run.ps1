param(
    [ValidateSet('Bot', 'Backup')][string]$Mode = 'Bot',
    [Parameter(Mandatory = $true)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
try {
    $projectRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
    $nodeExecutable = (Resolve-Path -LiteralPath $NodePath).Path
    if ([IO.Path]::GetFileName($nodeExecutable) -ne 'node.exe') { throw 'Node executable required' }
    $logDirectory = Join-Path $projectRoot 'var\logs'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $label = $Mode.ToLowerInvariant()
    $stdoutPath = Join-Path $logDirectory "$label.stdout.log"
    $stderrPath = Join-Path $logDirectory "$label.stderr.log"
    foreach ($logPath in @($stdoutPath, $stderrPath)) {
        if (Test-Path -LiteralPath $logPath) {
            Move-Item -LiteralPath $logPath -Destination "$logPath.previous" -Force
        }
    }
    $entryPoint = if ($Mode -eq 'Bot') { 'src/main.ts' } else { 'scripts/backup-daily.ts' }
    $child = Start-Process -FilePath $nodeExecutable -ArgumentList @('--env-file=.env', $entryPoint) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru -Wait
    exit $child.ExitCode
} catch {
    Write-Error 'Polezno task failed. Check the runtime path, local settings and file permissions.'
    exit 1
}
