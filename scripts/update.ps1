[CmdletBinding(DefaultParameterSetName = 'Local')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Local')][string]$PackagePath,
    [Parameter(Mandatory = $true, ParameterSetName = 'GitHub')][string]$Repository,
    [Parameter(Mandatory = $true, ParameterSetName = 'GitHub')][string]$Tag,
    [Parameter(Mandatory = $true, ParameterSetName = 'GitHub')][string]$AssetName,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
    [string]$DataDir, [int]$Port = 18327, [switch]$NoStart
)
. (Join-Path $PSScriptRoot 'common.ps1')
$context = Get-BoardContext $DataDir $Port
Enter-BoardMaintenance $context
try {
$id = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$stage = Join-Path $context.Root ('.workboard-updates/' + $id)
$null = Assert-BoardTarget $stage $context.Root
New-Item -ItemType Directory -Path $stage -Force | Out-Null
if ($PSCmdlet.ParameterSetName -eq 'GitHub') {
    if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $AssetName -notmatch '^[A-Za-z0-9_.-]+\.zip$' -or $Tag -notmatch '^[A-Za-z0-9_.-]+$') { throw '请使用真实 owner/repo、发行标签和 zip 资产名，不接受任意下载地址。' }
    $PackagePath = Join-Path $stage 'download.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "https://github.com/$Repository/releases/download/$Tag/$AssetName" -OutFile $PackagePath -UseBasicParsing
} else { $PackagePath = Resolve-BoardPath $PackagePath }
if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { throw '本地更新包不存在。' }
if ((Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw '更新包 SHA-256 与可信发行记录不符；没有停止服务或覆盖程序。' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
try {
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName.Replace('\','/')
        if ($name.StartsWith('/') -or $name.Contains(':') -or ($name.Split('/') -contains '..') -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw '更新包包含越界路径或符号链接；拒绝解压。' }
    }
} finally { $archive.Dispose() }
$incoming = Join-Path $stage 'incoming'; $null = Assert-BoardTarget $incoming $context.Root
Expand-Archive -LiteralPath $PackagePath -DestinationPath $incoming
$node = Get-BoardNode
& $node (Join-Path $PSScriptRoot 'validate-package.cjs') $incoming --update
if ($LASTEXITCODE -ne 0) { throw '更新包清单验证失败；没有停止服务或覆盖程序。' }
if (-not (Test-Path -LiteralPath (Join-Path $incoming 'node_modules')) -or -not (Test-Path -LiteralPath (Join-Path $incoming 'dist/index.html'))) { throw '自动更新要求含生产依赖与已构建界面的部署包；源码包请先构建。' }
$newPackage = Get-Content -LiteralPath (Join-Path $incoming 'package.json') -Raw | ConvertFrom-Json
$oldPackage = Get-Content -LiteralPath (Join-Path $context.Root 'package.json') -Raw | ConvertFrom-Json
if ([version]($newPackage.version -replace '-.*$', '') -le [version]($oldPackage.version -replace '-.*$', '')) { throw '更新包版本必须高于当前版本；没有覆盖程序。同版请使用 start.ps1，恢复旧版请使用 rollback.ps1。' }
$null = Get-BoardOwnedHealth $context
Stop-BoardService $context
$snapshot = New-BoardDataSnapshot $context 'before-update'
$previous = Join-Path $context.Root ('.workboard-previous/' + $id); $null = Assert-BoardTarget $previous $context.Root
New-Item -ItemType Directory -Path (Join-Path $previous 'program') -Force | Out-Null
$metadata = [ordered]@{ state = 'prepared'; fromVersion = $oldPackage.version; toVersion = $newPackage.version; dataDir = $context.DataDir; dataBackupDir = $snapshot; port = $Port; packageSha256 = $ExpectedSha256.ToLowerInvariant(); createdAt = (Get-Date).ToUniversalTime().ToString('o'); moved = @(); installed = @() }
$metaFile = Join-Path $previous 'update-metadata.json'
$metadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $metaFile -Encoding UTF8
try {
    foreach ($entry in Get-BoardProgramEntries) {
        $source = Join-Path $incoming $entry
        # 可选运行时未随包提供时保留本机已验证的运行时。
        if ($entry -eq 'vendor/node' -and -not (Test-Path -LiteralPath $source)) { continue }
        $target = Join-Path $context.Root $entry; $null = Assert-BoardTarget $target $context.Root
        $saved = Join-Path $previous ('program/' + $entry); $null = Assert-BoardTarget $saved $context.Root
        if (Test-Path -LiteralPath $target) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
            Move-Item -LiteralPath $target -Destination $saved
            $metadata.moved += $entry
            $metadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $metaFile -Encoding UTF8
        }
        if (Test-Path -LiteralPath $source) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
            Move-Item -LiteralPath $source -Destination $target
            $metadata.installed += $entry
            $metadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $metaFile -Encoding UTF8
        }
    }
    $metadata.state = 'installed'; $metadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $metaFile -Encoding UTF8
    if (-not $NoStart) { Start-BoardService $context }
    Write-Host "已从 V$($oldPackage.version) 更新到 V$($newPackage.version)。"
    Write-Host "上一程序与回退记录：$previous"
    Write-Host "对应数据快照：$snapshot"
} catch {
    $metadata.state = 'needs-rollback'; $metadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $metaFile -Encoding UTF8
    Write-Warning "更新未完成。上一程序和对应数据已保留在 $previous。请运行 rollback.ps1 -PreviousDir 指定该目录，并使用相同 -DataDir/-Port。"
    throw
}
} finally {
    Exit-BoardMaintenance
}
