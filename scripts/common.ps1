Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# 经 Node 从 PowerShell 7 启动 Windows PowerShell 时，继承的 PSModulePath
# 可能先找到不兼容的 7.x Utility 模块。只在本进程显式加载当前宿主模块。
foreach ($boardModuleName in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Archive')) {
    $boardModuleManifest = Join-Path $PSHOME ("Modules/$boardModuleName/$boardModuleName.psd1")
    if (-not (Test-Path -LiteralPath $boardModuleManifest -PathType Leaf)) { throw "当前 PowerShell 缺少内置模块 $boardModuleName，请使用完整 Windows PowerShell 5.1 或 PowerShell 7。" }
    Import-Module -Name $boardModuleManifest -Force -ErrorAction Stop
}
$script:BoardRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\', '/')
$script:BoardMaintenanceHeld = $false
$script:BoardMaintenanceHandle = $null

function Read-BoardJson([string]$File) {
    try {
        $encoding = New-Object Text.UTF8Encoding($false, $true)
        $text = [IO.File]::ReadAllText($File, $encoding)
        return (ConvertFrom-Json -InputObject $text -ErrorAction Stop)
    } catch {
        throw 'JSON 记录无法读取或 UTF-8 格式无效；请保留文件核对，诊断不会回显文件正文。'
    }
}

function Resolve-BoardPath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path)) { throw '请提供绝对路径。' }
    return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}
function Test-BoardWithin([string]$Path, [string]$Base) {
    $p = Resolve-BoardPath $Path; $b = Resolve-BoardPath $Base
    return $p.Equals($b, [StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($b + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function Assert-BoardTarget([string]$Path, [string]$Base) {
    $p = Resolve-BoardPath $Path; $b = Resolve-BoardPath $Base
    if (-not (Test-BoardWithin $p $b) -or $p -eq $b) { throw "拒绝操作边界之外或根目录本身：$p" }
    $walk = $p
    while (Test-BoardWithin $walk $b) {
        if (Test-Path -LiteralPath $walk) {
            $item = Get-Item -LiteralPath $walk -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "拒绝通过链接或联接操作：$walk" }
        }
        if ($walk -eq $b) { break }
        $walk = Split-Path -Parent $walk
    }
    return $p
}
function Enter-BoardMaintenance($Context) {
    if ($script:BoardMaintenanceHeld) { throw '当前进程已持有维护锁，不能重复进入维护流程。' }
    $lockPath = Join-Path $Context.Root '.workboard-maintenance.lock'
    $null = Assert-BoardTarget $lockPath $Context.Root
    try {
        # 独占句柄跨进程互斥；进程退出后由操作系统释放，空文件保留可重用。
        $script:BoardMaintenanceHandle = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $script:BoardMaintenanceHeld = $true
    } catch [IO.IOException] {
        throw '另一进程正在启动、升级或回退此程序；请等待该操作结束后重试。不会按 PID 强制结束其他进程。'
    } catch {
        throw '无法取得程序维护锁，请检查程序目录的写入权限。'
    }
}
function Exit-BoardMaintenance {
    try {
        if ($null -ne $script:BoardMaintenanceHandle) { $script:BoardMaintenanceHandle.Dispose() }
    } finally {
        $script:BoardMaintenanceHandle = $null
        $script:BoardMaintenanceHeld = $false
    }
}
function Get-BoardContext([string]$DataDir, [int]$Port = 18327, [switch]$AllowMissingProgram) {
    $dataDirExplicit = -not [string]::IsNullOrWhiteSpace($DataDir)
    if ($Port -lt 1024 -or $Port -gt 65535) { throw '端口必须在 1024 至 65535 之间。' }
    if (-not $AllowMissingProgram -and -not (Test-Path -LiteralPath (Join-Path $script:BoardRoot 'server/main.cjs'))) { throw '请把 scripts 文件夹与程序一起解压后运行。' }
    if (-not $DataDir) {
        if (-not $env:LOCALAPPDATA) { throw '未找到 LOCALAPPDATA，请通过 -DataDir 指定独立数据目录。' }
        $DataDir = Join-Path $env:LOCALAPPDATA 'PersonalWorkboard'
    }
    $data = Resolve-BoardPath $DataDir
    if ((Test-BoardWithin $data $script:BoardRoot) -or (Test-BoardWithin $script:BoardRoot $data)) { throw '数据目录必须与程序目录相互独立，不能放在彼此内部。' }
    if ($data -eq [IO.Path]::GetPathRoot($data).TrimEnd('\', '/')) { throw '不能把磁盘根目录当作数据目录。' }
    foreach ($broad in @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:WINDIR, $env:PROGRAMFILES)) {
        if ($broad -and $data.Equals((Resolve-BoardPath $broad), [StringComparison]::OrdinalIgnoreCase)) { throw '请为看板指定专用数据子目录，不能使用用户、系统或应用资料根目录。' }
    }
    if (Test-Path -LiteralPath $data) {
        if ((Get-Item -LiteralPath $data).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '数据目录不能是链接或联接。' }
    }
    [pscustomobject]@{ Root = $script:BoardRoot; DataDir = $data; Port = $Port; Url = "http://127.0.0.1:$Port"; DataDirExplicit = $dataDirExplicit; PreviewUpdateTest = $false }
}
function Get-BoardHealth($Context) {
    try { return Invoke-RestMethod -Uri ($Context.Url + '/health') -TimeoutSec 3 -Method Get } catch { return $null }
}
function Get-BoardProperty($Object, [string]$Name) {
    if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name) { return $Object.$Name }
    return $null
}
function Assert-BoardPreviewTestContext($Context) {
    if ((Get-BoardProperty $Context 'DataDirExplicit') -ne $true) { throw '预览更新测试必须通过 -DataDir 显式指定独立数据目录。' }
    if ($Context.Port -eq 18327) { throw '预览更新测试不能使用默认端口 18327，请通过 -Port 指定独立测试端口。' }
    if ($env:LOCALAPPDATA -and (Resolve-BoardPath $Context.DataDir).Equals((Resolve-BoardPath (Join-Path $env:LOCALAPPDATA 'PersonalWorkboard')), [StringComparison]::OrdinalIgnoreCase)) { throw '预览更新测试不能使用默认 PersonalWorkboard 数据目录。' }
}
function Get-BoardOwnedHealth($Context) {
    $health = Get-BoardHealth $Context
    if (-not $health) { return $null }
    $metaPath = Join-Path $Context.DataDir 'service.json'
    if (-not (Test-Path -LiteralPath $metaPath)) { throw "端口 $($Context.Port) 已响应，但没有本数据目录的服务凭据；不会停止或复用未知服务。" }
    try { $meta = Read-BoardJson $metaPath } catch { throw 'service.json 损坏，请先运行 diagnose.ps1；不会猜测或结束进程。' }
    if (-not (Get-BoardProperty $health 'ok') -or (Get-BoardProperty $health 'service') -ne 'personal-workboard' -or [int]$meta.port -ne $Context.Port -or $meta.version -ne $health.version) { throw '当前端口和本数据目录的服务信息不匹配；请运行诊断或选择其他端口。' }
    $hi = Get-BoardProperty $health 'instanceId'; $mi = Get-BoardProperty $meta 'instanceId'
    if ($hi -or $mi) {
        if (-not $hi -or -not $mi -or $hi -ne $mi) { throw '服务实例标识不匹配；不会操作这个服务。' }
    } elseif ((Get-BoardProperty $health 'startedAt') -ne (Get-BoardProperty $meta 'startedAt')) { throw '服务启动时间不匹配；不会操作这个服务。' }
    $healthPreview = Get-BoardProperty $health 'previewUpdateTest'; $metaPreview = Get-BoardProperty $meta 'previewUpdateTest'
    if (($null -ne $healthPreview -and $healthPreview -isnot [bool]) -or ($null -ne $metaPreview -and $metaPreview -isnot [bool]) -or [bool]$healthPreview -ne [bool]$metaPreview) { throw '服务预览测试模式与本数据目录记录不匹配；不会操作这个服务。' }
    if ($healthPreview) { Assert-BoardPreviewTestContext $Context }
    $Context | Add-Member -NotePropertyName PreviewUpdateTest -NotePropertyValue ([bool]$healthPreview) -Force
    return $health
}
function Test-BoardPort([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try { return $client.ConnectAsync('127.0.0.1', $Port).Wait(600) -and $client.Connected } catch { return $false } finally { $client.Dispose() }
}
function Invoke-BoardCall($Context, [string]$Method, $Payload = @{}) {
    $owned = Get-BoardOwnedHealth $Context
    if (-not $owned) { throw '该数据目录的本机服务未运行。' }
    $session = Invoke-RestMethod -Uri ($Context.Url + '/api/session') -Method Get -TimeoutSec 5
    $body = @{ method = $Method; payload = $Payload } | ConvertTo-Json -Depth 10 -Compress
    $result = Invoke-RestMethod -Uri ($Context.Url + '/api/call') -Method Post -Headers @{ 'X-Board-Token' = $session.token } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30
    if (-not $result.ok) { throw $result.error }
    return $result.data
}
function Stop-BoardService($Context) {
    $health = Get-BoardOwnedHealth $Context
    if (-not $health) {
        if (Test-BoardPort $Context.Port) { throw '端口由未知服务占用；不会结束任何进程。' }
        Write-Host '本数据目录的服务已经停止。'; return
    }
    $null = Invoke-BoardCall $Context 'service.stop'
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        if (-not (Test-BoardPort $Context.Port)) { Write-Host '本机服务已安全停止。'; return }
    }
    throw '安全停止尚未完成。请检查诊断日志；脚本不会强行结束 PID。'
}
function Assert-BoardOffline($Context) {
    if (Test-BoardPort $Context.Port) { throw '操作前必须先使用相同端口安全停止服务。' }
    $metaPath = Join-Path $Context.DataDir 'service.json'
    if (Test-Path -LiteralPath $metaPath) {
        $meta = Read-BoardJson $metaPath
        $oldPort = [int](Get-BoardProperty $meta 'port')
        if ($oldPort -ge 1024 -and $oldPort -le 65535 -and $oldPort -ne $Context.Port -and (Test-BoardPort $oldPort)) { throw '此数据目录的原端口仍有服务，请用原端口安全停服后再操作。' }
    }
}
function Get-BoardNode([switch]$DownloadNode) {
    $node = Join-Path $script:BoardRoot 'vendor/node/node.exe'
    if (-not (Test-Path -LiteralPath $node)) {
        $command = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $command) { $command = Get-Command node -ErrorAction SilentlyContinue }
        if ($command) { $node = $command.Source } else { $node = $null }
    }
    if ($node) {
        $version = & $node -p 'process.versions.node'
        if ($LASTEXITCODE -eq 0 -and [int]($version.Split('.')[0]) -ge 24) { return $node }
    }
    if (-not $DownloadNode) { throw '需要 Node.js 24 或以上版本。可重新执行 deploy.ps1 -DownloadNode，下载校验后的本项目专用 Node；不修改全局 PATH。' }
    if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -notmatch 'AMD64|x64') { throw '自动下载只支持 Windows x64，请在受支持的电脑上部署。' }
    $version = 'v24.15.0'; $filename = "node-$version-win-x64.zip"
    $vendor = Join-Path $script:BoardRoot 'vendor'; $null = Assert-BoardTarget $vendor $script:BoardRoot
    $stage = Join-Path $vendor ('download-' + [Guid]::NewGuid().ToString('N')); $null = Assert-BoardTarget $stage $script:BoardRoot
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt" -OutFile (Join-Path $stage 'SHASUMS256.txt') -UseBasicParsing
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/$filename" -OutFile (Join-Path $stage $filename) -UseBasicParsing
    $line = Get-Content -LiteralPath (Join-Path $stage 'SHASUMS256.txt') -Encoding UTF8 | Where-Object { $_ -match ('\s+' + [Regex]::Escape($filename) + '$') } | Select-Object -First 1
    if (-not $line) { throw 'Node 官方校验清单没有目标文件；下载停止。' }
    $expected = ($line.Trim() -split '\s+')[0]
    if ((Get-FileHash -LiteralPath (Join-Path $stage $filename) -Algorithm SHA256).Hash -ne $expected) { throw 'Node SHA-256 校验失败；未启用下载的运行时。' }
    Expand-Archive -LiteralPath (Join-Path $stage $filename) -DestinationPath $stage
    $destination = Join-Path $vendor 'node'; $null = Assert-BoardTarget $destination $script:BoardRoot
    if (Test-Path -LiteralPath $destination) { Move-Item -LiteralPath $destination -Destination (Join-Path $vendor ('node-previous-' + [Guid]::NewGuid().ToString('N'))) }
    Move-Item -LiteralPath (Join-Path $stage "node-$version-win-x64") -Destination $destination
    return Join-Path $destination 'node.exe'
}
function Invoke-BoardNpm([string]$Node, [string[]]$Arguments, [string]$Directory = $script:BoardRoot) {
    $cli = Join-Path (Split-Path -Parent $Node) 'node_modules/npm/bin/npm-cli.js'
    if (-not (Test-Path -LiteralPath $cli)) { throw '所选 Node 缺少 npm，请使用包含 npm 的 Node 官方发行包。' }
    Push-Location -LiteralPath $Directory
    try { & $Node $cli @Arguments; if ($LASTEXITCODE -ne 0) { throw ('npm 执行失败：' + ($Arguments -join ' ')) } } finally { Pop-Location }
}
function Open-BoardBrowser([string]$Url) {
    # 通过 Windows 默认外部浏览器打开；不使用 Codex 内置浏览器。
    Start-Process -FilePath $Url
}
function Start-BoardService {
    [CmdletBinding()]
    param($Context, [switch]$OpenBrowser, [switch]$PreviewUpdateTest)
    $requestedPreview = if ($PSBoundParameters.ContainsKey('PreviewUpdateTest')) { [bool]$PreviewUpdateTest } else { (Get-BoardProperty $Context 'PreviewUpdateTest') -eq $true }
    if ($requestedPreview) { Assert-BoardPreviewTestContext $Context }
    $acquiredMaintenance = -not $script:BoardMaintenanceHeld
    if ($acquiredMaintenance) { Enter-BoardMaintenance $Context }
    try {
    $owned = Get-BoardOwnedHealth $Context
    if ($owned) {
        if ([bool](Get-BoardProperty $owned 'previewUpdateTest') -ne $requestedPreview) { throw '正在运行的服务与本次请求的预览测试模式不同；请先使用相同目录和端口安全停服，再明确选择启动模式。' }
        Write-Host "复用正在运行的 V$($owned.version)：$($Context.Url)"; if ($OpenBrowser) { Open-BoardBrowser $Context.Url }; return
    }
    $Context | Add-Member -NotePropertyName PreviewUpdateTest -NotePropertyValue $requestedPreview -Force
    if (Test-BoardPort $Context.Port) { throw "端口 $($Context.Port) 已被占用。请运行 diagnose.ps1，或对 deploy/start/stop 使用同一个 -Port。" }
    $metaPath = Join-Path $Context.DataDir 'service.json'
    if (Test-Path -LiteralPath $metaPath) {
        $old = Read-BoardJson $metaPath
        if ([int]$old.port -ne $Context.Port -and (Test-BoardPort ([int]$old.port))) { throw '此数据目录可能已在另一个端口运行。请先使用原端口停止，不能让两个服务同时写同一数据库。' }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Context.Root 'dist/index.html'))) { throw '缺少构建结果，请先运行 deploy.ps1。' }
    $node = Get-BoardNode
    New-Item -ItemType Directory -Path $Context.DataDir -Force | Out-Null
    $logs = Join-Path $Context.DataDir 'logs'; $null = Assert-BoardTarget $logs $Context.DataDir
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $oldPort = $env:BOARD_PORT; $oldData = $env:BOARD_DATA_DIR; $oldPreview = $env:BOARD_PREVIEW_UPDATE_TEST
    try {
        $env:BOARD_PORT = [string]$Context.Port; $env:BOARD_DATA_DIR = $Context.DataDir
        $env:BOARD_PREVIEW_UPDATE_TEST = if ($requestedPreview) { '1' } else { $null }
        $process = Start-Process -FilePath $node -ArgumentList '"server/main.cjs"' -WorkingDirectory $Context.Root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'service.stdout.log') -RedirectStandardError (Join-Path $logs 'service.stderr.log') -PassThru
    } finally { $env:BOARD_PORT = $oldPort; $env:BOARD_DATA_DIR = $oldData; $env:BOARD_PREVIEW_UPDATE_TEST = $oldPreview }
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 250
        $process.Refresh()
        if ($process.HasExited) { throw "启动失败，请查看 $logs\service.stderr.log 或运行 diagnose.ps1。" }
        $health = Get-BoardOwnedHealth $Context
        if ($health) {
            if ([bool](Get-BoardProperty $health 'previewUpdateTest') -ne $requestedPreview) { throw '启动回执的预览测试模式与请求不同，请运行诊断核对服务。' }
            Write-Host "已启动 V$($health.version)：$($Context.Url)"; Write-Host "独立数据目录：$($Context.DataDir)"; if ($OpenBrowser) { Open-BoardBrowser $Context.Url }; return
        }
    }
    throw '15 秒内未取得健康回执，请运行 diagnose.ps1。后台进程不会被盲目结束。'
    } finally {
        if ($acquiredMaintenance) { Exit-BoardMaintenance }
    }
}
function New-BoardDataSnapshot($Context, [string]$Label) {
    Assert-BoardOffline $Context
    $base = Join-Path $Context.DataDir 'backups'; New-Item -ItemType Directory -Path $base -Force | Out-Null
    $snapshot = Join-Path $base ($Label + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
    $null = Assert-BoardTarget $snapshot $Context.DataDir; New-Item -ItemType Directory -Path $snapshot | Out-Null
    Get-ChildItem -LiteralPath $Context.DataDir -Force | Where-Object { $_.Name -notin @('backups','logs','print','service.json') } | ForEach-Object {
        $null = Assert-BoardTarget $_.FullName $Context.DataDir
        if ($_.PSIsContainer) { Get-ChildItem -LiteralPath $_.FullName -Recurse -Force | ForEach-Object { $null = Assert-BoardTarget $_.FullName $Context.DataDir } }
        Copy-Item -LiteralPath $_.FullName -Destination $snapshot -Recurse
    }
    return $snapshot
}
function Get-BoardProgramEntries {
    # 前端第三方完整声明 public/THIRD_PARTY_NOTICES.txt、public/third-party-licenses/
    # 及 dist 中对应副本随 public/dist 整体升级和回退，不能只替换 JS bundle。
    return @('dist','server','scripts','src','public','tests','node_modules','vendor/node','docs/INSTALL_FOR_CODEX.md','docs/RELEASE_FOR_CODEX.md','.gitignore','README.md','AGENTS.md','CHANGELOG.md','package.json','package-lock.json','index.html','vite.config.mjs','release-manifest.json')
}
function Restore-BoardSnapshot($Context, [string]$Snapshot) {
    $null = Assert-BoardTarget $Snapshot $Context.DataDir
    if (-not (Test-Path -LiteralPath (Join-Path $Snapshot 'workboard.sqlite'))) { throw '对应数据快照缺少 workboard.sqlite；未执行恢复。' }
    $saved = New-BoardDataSnapshot $Context 'before-rollback'
    foreach ($name in @('workboard.sqlite','workboard.sqlite-wal','workboard.sqlite-shm','credentials.dpapi.json','restore-next-start.sqlite')) {
        $file = Join-Path $Context.DataDir $name; $null = Assert-BoardTarget $file $Context.DataDir
        if (Test-Path -LiteralPath $file) { Move-Item -LiteralPath $file -Destination (Join-Path $saved ($name + '.displaced')) }
        if (Test-Path -LiteralPath (Join-Path $Snapshot $name)) { Copy-Item -LiteralPath (Join-Path $Snapshot $name) -Destination $file }
    }
    return $saved
}
