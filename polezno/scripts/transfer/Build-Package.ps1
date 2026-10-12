param(
    [Parameter(Mandatory=$true)][string]$ProjectPath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [string]$NodePath = 'node',
    [switch]$LiveSnapshot,
    [switch]$IncludeKey
)
$ErrorActionPreference='Stop'
$poleznoProject=(Resolve-Path -LiteralPath $ProjectPath).Path
$poleznoOutput=[IO.Path]::GetFullPath($OutputPath)
$poleznoArchive=$poleznoOutput+'.zip'
if (Test-Path -LiteralPath $poleznoArchive) { throw 'Archive already exists; choose a new output path' }
$poleznoArguments=@((Join-Path $PSScriptRoot 'build-transfer.mjs'),'--project',$poleznoProject,'--out',$poleznoOutput)
if ($LiveSnapshot) { $poleznoArguments+='--live-snapshot' }
& $NodePath @poleznoArguments
if ($LASTEXITCODE -ne 0) { throw 'Transfer preparation failed; source bot was not changed' }
if ($IncludeKey) {
    & $NodePath (Join-Path $PSScriptRoot 'include-private-key.mjs') $poleznoOutput
    if ($LASTEXITCODE -ne 0) { throw 'Single private archive preparation failed' }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($poleznoOutput,$poleznoArchive,[IO.Compression.CompressionLevel]::Optimal,$false)
& $NodePath (Join-Path $poleznoOutput 'verify-package.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Package checksum verification failed' }
[pscustomobject]@{Archive=$poleznoArchive;Bytes=(Get-Item -LiteralPath $poleznoArchive).Length;KeyIncluded=[bool]$IncludeKey;SourceBotStopped=$false}|ConvertTo-Json -Compress
