[CmdletBinding()]
param([string]$DataDir, [int]$Port = 18327)
. (Join-Path $PSScriptRoot 'common.ps1')
$context = Get-BoardContext $DataDir $Port
$package = Read-BoardJson (Join-Path $context.Root 'package.json')
Write-Host "程序版本：$($package.version)"
Write-Host "程序目录：$($context.Root)"
Write-Host "数据目录：$($context.DataDir)"
Write-Host "本机地址：$($context.Url)"
try { $node = Get-BoardNode; Write-Host "Node：$(& $node --version)" } catch { Write-Warning $_.Exception.Message }
try { $health = Get-BoardOwnedHealth $context; if ($health) { Write-Host "健康：正常，服务版本 $($health.version)" } else { Write-Host "健康：未运行；端口占用：$(Test-BoardPort $Port)" } } catch { Write-Warning $_.Exception.Message }
foreach ($name in @('workboard.sqlite','credentials.dpapi.json','service.json','logs/service.stderr.log')) {
    $file = Join-Path $context.DataDir $name
    Write-Host "$name：$(Test-Path -LiteralPath $file)"
}
Write-Host '诊断不输出密码、令牌、邮件、微信消息或数据库正文。请勿把凭据文件或数据库上传到公共仓库。'
Write-Host '报告原件位置以网页“设置→报告保存文件夹”为准；浏览器下载副本位置由浏览器下载设置决定。'
