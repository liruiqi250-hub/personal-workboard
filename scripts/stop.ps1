[CmdletBinding()]
param([string]$DataDir, [int]$Port = 18327)
. (Join-Path $PSScriptRoot 'common.ps1')
$context = Get-BoardContext $DataDir $Port
Stop-BoardService $context
