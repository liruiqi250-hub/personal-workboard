[CmdletBinding(DefaultParameterSetName='Local')]
param(
 [Parameter(Mandatory=$true,ParameterSetName='Local')][string]$PackagePath,
 [Parameter(Mandatory=$true,ParameterSetName='GitHub')][string]$Repository,
 [Parameter(Mandatory=$true,ParameterSetName='GitHub')][string]$Tag,
 [Parameter(Mandatory=$true,ParameterSetName='GitHub')][string]$AssetName,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
 [string]$DataDir,[int]$Port=18327,[switch]$NoStart,
 [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')][string]$ExpectedVersion
)
$maintenanceArgs=@{Action='Update';ExpectedSha256=$ExpectedSha256;Port=$Port;NoStart=$NoStart}
if($DataDir){$maintenanceArgs.DataDir=$DataDir};if($ExpectedVersion){$maintenanceArgs.ExpectedVersion=$ExpectedVersion}
if($PSCmdlet.ParameterSetName -eq 'GitHub'){$maintenanceArgs.Repository=$Repository;$maintenanceArgs.Tag=$Tag;$maintenanceArgs.AssetName=$AssetName}else{$maintenanceArgs.PackagePath=$PackagePath}
& (Join-Path $PSScriptRoot 'maintenance.ps1') @maintenanceArgs
