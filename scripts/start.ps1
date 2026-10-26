[CmdletBinding()]
param([string]$DataDir, [int]$Port = 18327, [switch]$OpenBrowser, [switch]$PreviewUpdateTest)
. (Join-Path $PSScriptRoot 'common.ps1')
$context = Get-BoardContext $DataDir $Port
Start-BoardService $context -OpenBrowser:$OpenBrowser -PreviewUpdateTest:$PreviewUpdateTest
