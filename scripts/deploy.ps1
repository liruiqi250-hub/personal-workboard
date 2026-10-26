[CmdletBinding()]
param([string]$DataDir, [int]$Port = 18327, [switch]$DownloadNode, [switch]$SkipInstall, [switch]$NoStart, [switch]$OpenBrowser)
. (Join-Path $PSScriptRoot 'common.ps1')
$context = Get-BoardContext $DataDir $Port
$node = Get-BoardNode -DownloadNode:$DownloadNode
$health = Get-BoardOwnedHealth $context
if ($health) { Write-Host '服务正在运行，部署未覆盖程序。重复打开请使用 start.ps1；升级请使用 update.ps1。'; if ($OpenBrowser) { Open-BoardBrowser $context.Url }; exit 0 }
Assert-BoardOffline $context
if (-not $SkipInstall) { Invoke-BoardNpm $node @('ci','--no-audit','--no-fund') }
elseif (-not (Test-Path -LiteralPath (Join-Path $context.Root 'node_modules'))) { throw '-SkipInstall 需要已有 node_modules。' }
if (Test-Path -LiteralPath (Join-Path $context.Root 'node_modules/vite')) { Invoke-BoardNpm $node @('run','build') }
elseif (-not (Test-Path -LiteralPath (Join-Path $context.Root 'dist/index.html'))) { throw '交付包既没有构建结果，也没有 Vite。请不带 -SkipInstall 部署源码。' }
Write-Host "部署已准备好：$($context.Root)"
if (-not $NoStart) { Start-BoardService $context -OpenBrowser:$OpenBrowser }
