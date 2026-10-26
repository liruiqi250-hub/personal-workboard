[CmdletBinding()]
param(
 [ValidateSet('Update','Rollback','RecoverLegacy')][string]$Action='Update',
 [string]$ProgramDir,[string]$DataDir,[int]$Port=18327,
 [string]$PackagePath,[string]$Repository,[string]$Tag,[string]$AssetName,
 [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
 [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')][string]$ExpectedVersion,
 [string]$PreviousDir,[switch]$NoStart,[string]$ReceiptPath,
 [switch]$PreviewUpdateTest,[switch]$MaintenanceTest
)
. (Join-Path $PSScriptRoot 'common.ps1')
$toolRoot=$script:BoardRoot; $toolNode=Get-BoardNode
if(-not $ProgramDir){$ProgramDir=$toolRoot}
$targetRoot=Resolve-BoardPath $ProgramDir
if($targetRoot -notmatch '^[A-Za-z]:\\' -or $targetRoot -eq [IO.Path]::GetPathRoot($targetRoot).TrimEnd('\')){throw '程序目录必须是本机盘符内的专用绝对目录。'}
function Assert-MaintenanceAncestors([string]$Target){
 if($Target -notmatch '^[A-Za-z]:\\' -or $Target.Substring(2).Contains(':')){throw '维护路径只接受本机盘符绝对路径，拒绝设备或数据流别名。'}
 foreach($part in $Target.Substring(3).Split('\')){if($part -and ($part -match '[. ]$' -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)')){throw '维护路径包含保留名称或尾部别名。'}}
 $walk=$Target
 while($walk){
  if(Test-Path -LiteralPath $walk){if((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '维护目录不能经由链接或联接。'}}
  $next=Split-Path -Parent $walk; if(-not $next -or $next -eq $walk){break};$walk=$next
 }
}
Assert-MaintenanceAncestors $targetRoot
foreach($broad in @($env:USERPROFILE,$env:LOCALAPPDATA,$env:APPDATA,$env:WINDIR,$env:PROGRAMFILES)){if($broad -and $targetRoot.Equals((Resolve-BoardPath $broad),[StringComparison]::OrdinalIgnoreCase)){throw '程序必须使用专用子目录，不能使用用户或系统资料根目录。'}}
if(-not(Test-Path -LiteralPath $targetRoot -PathType Container)){throw '目标程序目录不存在。'}
$script:BoardRoot=$targetRoot; $context=Get-BoardContext $DataDir $Port -AllowMissingProgram
Assert-MaintenanceAncestors $context.DataDir
if($PreviewUpdateTest){Assert-BoardPreviewTestContext $context;$context.PreviewUpdateTest=$true}
$testHook=$env:BOARD_MAINTENANCE_TEST_HOOK_FILE
if($MaintenanceTest){
 Assert-BoardPreviewTestContext $context
 $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
 if(-not(Test-BoardWithin $targetRoot $tempRoot) -or -not(Test-BoardWithin $context.DataDir $tempRoot) -or -not $testHook){throw '故障测试必须显式使用TEMP内独立程序/数据及外部TEMP hook。'}
 $testHook=Resolve-BoardPath $testHook;Assert-MaintenanceAncestors $testHook
 if(-not(Test-BoardWithin $testHook $tempRoot) -or (Test-BoardWithin $testHook $targetRoot) -or (Test-BoardWithin $testHook $context.DataDir)){throw '故障hook必须位于程序和数据目录之外。'}
}
$controlId='controller-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)
$control=Join-Path $targetRoot ('.workboard-updates/'+$controlId);$null=Assert-BoardTarget $control $targetRoot
$runner=Join-Path $control 'runner';$script:requestCounter=0
$receipt=[ordered]@{schema=1;controllerVersion='0.3.3';action=$Action;programDir=$targetRoot;dataDir=$context.DataDir;port=$Port;controllerDir=$control;previousDir=$null;beforeRollbackDataDir=$null;state='initializing';completed=$false}
function Write-MaintenanceJson([string]$File,$Value,[switch]$AllowReplace){
 Assert-MaintenanceAncestors $File
 $parent=Split-Path -Parent $File;if(-not(Test-Path -LiteralPath $parent)){New-Item -ItemType Directory -Path $parent -Force|Out-Null}
 $temporary=$File+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
 [IO.File]::WriteAllText($temporary,($Value|ConvertTo-Json -Depth 30),(New-Object Text.UTF8Encoding($false)))
 if(Test-Path -LiteralPath $File){
  if(-not $AllowReplace){throw '维护输出必须使用新文件，不覆盖原文件。'}
  $backup=$File+'.previous-'+[Guid]::NewGuid().ToString('N')
  [IO.File]::Replace($temporary,$File,$backup)
 }else{[IO.File]::Move($temporary,$File)}
}
if(-not $ReceiptPath){$ReceiptPath=Join-Path $control 'receipt.json'}else{$ReceiptPath=Resolve-BoardPath $ReceiptPath}
Assert-MaintenanceAncestors $ReceiptPath
if((Test-BoardWithin $ReceiptPath $context.DataDir) -or ((Test-BoardWithin $ReceiptPath $targetRoot) -and -not(Test-BoardWithin $ReceiptPath $control))){throw '回执不能写入个人数据或程序文件；请选择目录外的新文件。'}
if(Test-Path -LiteralPath $ReceiptPath){throw '回执必须使用新文件，不能覆盖已有文件。'}
$script:receiptOwned=$false
function Save-MaintenanceReceipt([string]$State){$receipt.state=$State;$receipt.updatedAt=(Get-Date).ToUniversalTime().ToString('o');Write-MaintenanceJson $ReceiptPath $receipt -AllowReplace:$script:receiptOwned;$script:receiptOwned=$true}
function Invoke-MaintenanceEngine([string]$Command,$Request){
 $script:requestCounter++;$requestFile=Join-Path $runner "request-$($script:requestCounter).json";$outputFile=Join-Path $runner "response-$($script:requestCounter).json"
 Write-MaintenanceJson $requestFile $Request
 $priorFlag=$env:BOARD_MAINTENANCE_TEST;$priorHook=$env:BOARD_MAINTENANCE_TEST_HOOK_FILE
 try{
  $forwardTest=$MaintenanceTest -and $Command -ne 'inspect-package'
  $env:BOARD_MAINTENANCE_TEST=if($forwardTest){'1'}else{$null};$env:BOARD_MAINTENANCE_TEST_HOOK_FILE=if($forwardTest){$testHook}else{$null}
  & (Join-Path $runner 'node.exe') (Join-Path $runner 'maintenance-engine.cjs') $Command --request $requestFile --output $outputFile
  if($LASTEXITCODE -ne 0){throw "维护步骤 $Command 失败；现场和快照保留。回执：$ReceiptPath"}
 }finally{$env:BOARD_MAINTENANCE_TEST=$priorFlag;$env:BOARD_MAINTENANCE_TEST_HOOK_FILE=$priorHook}
 if(-not(Test-Path -LiteralPath $outputFile)){throw '维护组件未生成回执。'}
 return(Read-BoardJson $outputFile)
}
function Prepare-MaintenancePackage{
 if(-not $ExpectedSha256){throw '必须提供可信ZIP的ExpectedSha256。'}
 if($Repository){
  if($PackagePath -or $Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $AssetName -notmatch '^[A-Za-z0-9_.-]+\.zip$' -or $Tag -notmatch '^[A-Za-z0-9_.-]+$'){throw '仓库、tag或资产参数无效。'}
  $script:maintenancePackage=Join-Path $control 'package.zip';[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri "https://github.com/$Repository/releases/download/$Tag/$AssetName" -OutFile $script:maintenancePackage -UseBasicParsing
 }else{if(-not $PackagePath){throw '请选择部署ZIP。'};$script:maintenancePackage=Resolve-BoardPath $PackagePath}
 Assert-MaintenanceAncestors $script:maintenancePackage
 if(-not(Test-Path -LiteralPath $script:maintenancePackage -PathType Leaf) -or (Get-Item -LiteralPath $script:maintenancePackage).Length -gt 419430400){throw 'ZIP不存在或超过400MiB。'}
 if((Get-FileHash -LiteralPath $script:maintenancePackage -Algorithm SHA256).Hash -ne $ExpectedSha256){throw 'ZIP SHA-256不符；尚未停止服务。'}
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 $archive=[IO.Compression.ZipFile]::OpenRead($script:maintenancePackage)
 try{
  $names=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase);[long]$expanded=0
  if($archive.Entries.Count -gt 100000){throw 'ZIP文件数量超限。'}
  foreach($entry in $archive.Entries){$name=$entry.FullName.Replace('\','/')
   if(-not $name -or $name.StartsWith('/') -or $name.Contains(':') -or ($name.Split('/') -contains '..') -or ($name.Split('/') -contains '.') -or -not $names.Add($name) -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000){throw 'ZIP包含越界、重复或链接条目。'}
   $expanded+=$entry.Length;if($entry.Length -gt 536870912 -or $expanded -gt 2147483648){throw 'ZIP解压大小超限。'}
  }
 }finally{$archive.Dispose()}
 $incoming=Join-Path $control 'incoming';$null=Assert-BoardTarget $incoming $targetRoot
 [IO.Compression.ZipFile]::ExtractToDirectory($script:maintenancePackage,$incoming)
 $request=@{incomingDir=$incoming};if($ExpectedVersion){$request.expectedVersion=$ExpectedVersion}
 $info=Invoke-MaintenanceEngine 'inspect-package' $request
 $receipt.packageSha256=$ExpectedSha256.ToLowerInvariant();$receipt.toVersion=$info.version
 return $incoming
}
Enter-BoardMaintenance $context
try{
 New-Item -ItemType Directory -Path $runner -Force|Out-Null
 foreach($file in @('maintenance-engine.cjs','maintenance-legacy.cjs')){$source=Join-Path $PSScriptRoot $file
  if(-not(Test-Path -LiteralPath $source -PathType Leaf)){throw '维护工具不完整，请使用完整可信V0.3.3工具目录。'}
  Copy-Item -LiteralPath $source -Destination (Join-Path $runner $file)
  if((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath (Join-Path $runner $file)).Hash){throw '维护runner副本校验失败。'}
 }
 Copy-Item -LiteralPath $toolNode -Destination (Join-Path $runner 'node.exe')
 if((Get-FileHash -LiteralPath $toolNode).Hash -ne (Get-FileHash -LiteralPath (Join-Path $runner 'node.exe')).Hash){throw '独立Node副本校验失败。'}
 $receipt.runner=$runner;Save-MaintenanceReceipt 'validating';$incoming=$null
 if($Action -ne 'Rollback'){$incoming=Prepare-MaintenancePackage}
 if($Action -ne 'Update'){
  if(-not $PreviousDir){throw '恢复必须提供PreviousDir；尚未停止服务。'}
  $previous=Resolve-BoardPath $PreviousDir;$null=Assert-BoardTarget $previous (Join-Path $targetRoot '.workboard-previous')
  $legacy=Read-BoardJson (Join-Path $previous 'update-metadata.json')
  if((Resolve-BoardPath $legacy.dataDir) -ne $context.DataDir -or [int]$legacy.port -ne $Port){throw '恢复记录数据目录或端口不符；尚未停止服务。'}
  if($Action -eq 'Rollback' -and (Get-BoardProperty $legacy 'schema') -ne 2){throw '旧记录请用RecoverLegacy及当时目标ZIP核对恢复；尚未停止服务。'}
  if($Action -eq 'RecoverLegacy' -and $legacy.packageSha256 -ne $ExpectedSha256.ToLowerInvariant()){throw 'ZIP与旧记录packageSha256不同；尚未停止服务或改变现场。'}
 }
 if($Action -eq 'Update'){
  $oldPackage=Read-BoardJson (Join-Path $targetRoot 'package.json')
  if($oldPackage.name -ne 'personal-workboard' -or $oldPackage.version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$'){throw '目标程序名称或版本无效；尚未停止服务。'}
  if([version]$receipt.toVersion -le [version]$oldPackage.version){throw '更新包版本必须高于当前版本；尚未停止服务。同版不能重装，旧版请使用恢复入口。'}
 }
 if($Action -eq 'Rollback' -and -not $PreviousDir){throw '回退必须提供PreviousDir；尚未停止服务。'}
 $owned=Get-BoardOwnedHealth $context;$requestedPreview=[bool]$context.PreviewUpdateTest
 if($PreviewUpdateTest){$requestedPreview=$true;Assert-BoardPreviewTestContext $context}
 Stop-BoardService $context
 if($Action -eq 'Update'){
  $dataSnapshot=New-BoardDataSnapshot $context 'before-update'
  $prepared=Invoke-MaintenanceEngine 'prepare-update' @{programDir=$targetRoot;incomingDir=$incoming;dataDir=$context.DataDir;dataSnapshot=$dataSnapshot;port=$Port;expectedSha256=$ExpectedSha256.ToLowerInvariant();expectedVersion=$ExpectedVersion;previewUpdateTest=$requestedPreview}
  $receipt.previousDir=$prepared.previousDir;$receipt.fromVersion=$prepared.fromVersion;$receipt.toVersion=$prepared.toVersion;Save-MaintenanceReceipt 'prepared'
  $null=Invoke-MaintenanceEngine 'apply-update' @{programDir=$targetRoot;previousDir=$prepared.previousDir;dataDir=$context.DataDir;port=$Port}
  $expectedHealthVersion=$prepared.toVersion;$markMode='updated'
 }else{
  if(-not $PreviousDir){throw '回退必须提供PreviousDir。'};$previous=Resolve-BoardPath $PreviousDir
  if($Action -eq 'RecoverLegacy'){
   $imported=Invoke-MaintenanceEngine 'import-legacy' @{programDir=$targetRoot;previousDir=$previous;incomingDir=$incoming;dataDir=$context.DataDir;port=$Port;expectedSha256=$ExpectedSha256.ToLowerInvariant()}
   $previous=$imported.previousDir;$receipt.legacyPreviousDir=(Resolve-BoardPath $PreviousDir)
  }
  $receipt.previousDir=$previous;Save-MaintenanceReceipt 'preparing-rollback'
  $prepared=Invoke-MaintenanceEngine 'prepare-rollback' @{programDir=$targetRoot;previousDir=$previous;dataDir=$context.DataDir;port=$Port}
  $receipt.beforeRollbackDataDir=Get-BoardProperty $prepared 'beforeRollbackDataDir'
  $receipt.fromVersion=$prepared.fromVersion;$receipt.toVersion=$prepared.toVersion;Save-MaintenanceReceipt 'rollback-prepared'
  $null=Invoke-MaintenanceEngine 'apply-rollback' @{programDir=$targetRoot;previousDir=$previous;dataDir=$context.DataDir;port=$Port}
  $expectedHealthVersion=$prepared.fromVersion;$markMode='rolled-back'
 }
 Save-MaintenanceReceipt 'program-verified'
 if(-not $NoStart){
  $context.PreviewUpdateTest=$requestedPreview;Start-BoardService $context;$health=Get-BoardOwnedHealth $context
  if(-not $health -or $health.version -ne $expectedHealthVersion -or [bool](Get-BoardProperty $health 'previewUpdateTest') -ne $requestedPreview){throw '维护后健康版本或模式不符，现场与快照保留。'}
  $null=Invoke-MaintenanceEngine 'mark-running' @{programDir=$targetRoot;previousDir=$receipt.previousDir;dataDir=$context.DataDir;port=$Port;mode=$markMode}
  $receipt.healthVersion=$health.version;$receipt.previewUpdateTest=$requestedPreview
 }
 $receipt.completed=$true;Save-MaintenanceReceipt 'completed'
 Write-Host "维护完成，回执：$ReceiptPath";Write-Host "完整旧程序和数据快照：$($receipt.previousDir)"
 if($receipt.beforeRollbackDataDir){Write-Host "首次回退前完整数据保留：$($receipt.beforeRollbackDataDir)"}
}catch{$receipt.completed=$false;try{Save-MaintenanceReceipt 'failed-preserved'}catch{Write-Warning '回执写入也失败，请保留维护目录与现场。'};throw}finally{Exit-BoardMaintenance}
