[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$PreviousDir, [string]$DataDir, [int]$Port = 18327, [switch]$NoStart)
. (Join-Path $PSScriptRoot 'common.ps1')
$context = Get-BoardContext $DataDir $Port -AllowMissingProgram
Enter-BoardMaintenance $context
try {
$previousBase = Join-Path $context.Root '.workboard-previous'
$previous = Resolve-BoardPath $PreviousDir; $null = Assert-BoardTarget $previous $previousBase
$metaFile = Join-Path $previous 'update-metadata.json'
if (-not (Test-Path -LiteralPath $metaFile)) { throw '指定目录缺少 update-metadata.json，不能确认程序和数据是否对应。' }
$meta = Get-Content -LiteralPath $metaFile -Raw | ConvertFrom-Json
if ((Resolve-BoardPath $meta.dataDir) -ne $context.DataDir -or [int]$meta.port -ne $Port) { throw '回退记录的数据目录或端口不同，请使用当时的 -DataDir 和 -Port。' }
$snapshot = Resolve-BoardPath $meta.dataBackupDir; $null = Assert-BoardTarget $snapshot $context.DataDir
if (-not (Test-Path -LiteralPath (Join-Path $snapshot 'workboard.sqlite'))) { throw '回退记录对应的数据库快照不存在；未覆盖程序。' }
foreach ($entry in $meta.moved) {
    if ($entry -notin (Get-BoardProgramEntries)) { throw '回退清单包含未知程序路径。' }
    $source = Join-Path $previous ('program/' + $entry); $null = Assert-BoardTarget $source $previous
    if (-not (Test-Path -LiteralPath $source)) { throw "回退程序不完整：$entry" }
}
Stop-BoardService $context
$saveProgram = Join-Path $previousBase ('before-rollback-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
$null = Assert-BoardTarget $saveProgram $context.Root
New-Item -ItemType Directory -Path $saveProgram -Force | Out-Null
$entries = @($meta.moved) + @($meta.installed) | Select-Object -Unique
foreach ($entry in $entries) {
    if ($entry -notin (Get-BoardProgramEntries)) { throw '回退清单包含未知程序路径。' }
    $target = Join-Path $context.Root $entry; $null = Assert-BoardTarget $target $context.Root
    if (Test-Path -LiteralPath $target) {
        $saved = Join-Path $saveProgram $entry; $null = Assert-BoardTarget $saved $context.Root
        New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
        Move-Item -LiteralPath $target -Destination $saved
    }
    $old = Join-Path $previous ('program/' + $entry)
    if (Test-Path -LiteralPath $old) { New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null; Copy-Item -LiteralPath $old -Destination $target -Recurse }
}
$savedData = Restore-BoardSnapshot $context $snapshot
if (-not $NoStart) { Start-BoardService $context }
Write-Host "已恢复 V$($meta.fromVersion) 及升级前对应的数据库和凭据。"
Write-Host "回退前的数据另存于：$savedData"
Write-Host "回退前的程序另存于：$saveProgram"
Write-Host '报告文件没有删除；升级后新产生的任务记录保留在回退前数据快照中，可供后续人工核对。'
} finally {
    Exit-BoardMaintenance
}
