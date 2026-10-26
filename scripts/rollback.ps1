[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PreviousDir,[string]$DataDir,[int]$Port=18327,[switch]$NoStart)
$maintenanceArgs=@{Action='Rollback';PreviousDir=$PreviousDir;Port=$Port;NoStart=$NoStart}
if($DataDir){$maintenanceArgs.DataDir=$DataDir}
& (Join-Path $PSScriptRoot 'maintenance.ps1') @maintenanceArgs
