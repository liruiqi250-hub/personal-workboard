# 交给 Codex 的本机安装说明 V1.10.1

> **V0.3.7 版本说明（开发预览通道）：** 本版提供页面与后台版本差异提示和未保存内容保护、每秒北京时间时钟、可选天气与一次定位、已配置来源的立即整理、默认全部状态看板，以及邮箱／钉钉配置入口；公开说明同步实际发行状态。实际公开状态、资产校验值和本版验收结果以[GitHub发行记录](https://github.com/liruiqi250-hub/personal-workboard/releases)为准。

> **已发布基线：** [V0.3.6](https://github.com/liruiqi250-hub/personal-workboard/releases/tag/v0.3.6) 已作为 Pre-release 公开，非正式 latest。V0.3.6 的程序、数据回退快照、标签与发行资产保留；旧包内的候选措辞属于冻结时点的历史说明。

> 本版文件名为 `personal-workboard-0.3.7-windows-x64.zip` 和 `personal-workboard-0.3.7-public-source.zip`。下载前从发行列表核对实际存在的 `v0.3.7`、文件大小、SHA-256 及预览状态；不从文件名或本文推断网络资产已经存在。

> **V0.3.2 已知更新恢复缺口（UPD-RECOVERY-01）：** 被占用的子文件可能使旧程序目录只移动一部分，旧回退记录会漏记该目录。V0.3.2 仍为已发布的 Pre-release、非正式 latest，原冻结包保留。V0.3.3 已按开发预览发布，限定完整部署故障场景经独立复核通过；已有数据实例的首次迁移和旧失败记录恢复使用本指南的新可信外部维护入口，不能调用旧 V0.3.2 的 update.ps1 代替。详见 [V0.3.2 发行说明](https://github.com/liruiqi250-hub/personal-workboard/releases/tag/v0.3.2)。

本文对应 V0.3.7 开发预览，既有 V0.3.6、V0.3.3 及更早发行保留；V0.3.2 已发布为 Pre-release、非正式 latest，并保留 UPD-RECOVERY-01 披露。离线测试、签名验证和部署不代表真实渠道或真人界面验收通过。

目标：在使用者自己的 Windows x64 电脑上运行个人待办事项看板。每人一个独立数据目录，打开浏览器使用。本文不要求 Docker、Electron、公网域名或云服务器。安装时明确选择实际存在的 V0.3.7 预览发行及对应校验值，旧版及已知缺口说明继续保留；首次迁移使用新可信外部工具，不直接调用旧V0.3.2脚本。

## 先确认下载材料

公开仓库为 https://github.com/liruiqi250-hub/personal-workboard ，owner=liruiqi250-hub，repo=personal-workboard。[GitHub发行列表](https://github.com/liruiqi250-hub/personal-workboard/releases)中选择实际存在的 V0.3.7 预览发行，取得含 Node 的 `personal-workboard-0.3.7-windows-x64.zip`，大小与 SHA-256 以该发行的校验文件为准，以及需另行构建的源码包。核对实际预览状态、版本和校验，不把外部手动维护当作旧客户端完整自动更新。

在下载后、解压前用 `Get-FileHash -Algorithm SHA256` 与可信发行记录比对。`.sha256` 与 ZIP 从同一未知来源取得只能用于检测传输损坏，不能证明发行者身份。完整解压后，程序根目录应包含 `package.json`、`server`、`dist`、`scripts` 和 `release-manifest.json`；部署包还包含 `node_modules`。

## 执行部署

在解压目录打开 PowerShell；以下相对路径均相对于程序根目录：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 -DownloadNode -SkipInstall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnose.ps1
```

`-DownloadNode` 仅在找不到合适运行时时，从 `https://nodejs.org/dist/v24.15.0/` 获取 Windows x64 ZIP 和官方校验清单。必须 SHA-256 一致后才解压启用。下载留在程序目录 `vendor`，不修改全局 PATH。已有 Node 24+ 时优先复用；部署包可选只附带 Node 运行时与许可证，未必包含 npm。

源码 checkout 或源码 ZIP 通常没有完整 Windows 部署包的原 release-manifest.json，不能直接作为事务升级目标。需要切换到完整 Windows 包时，先在独立目录受控部署，安全停服并备份原数据，再核对原 DataDir/Port 与实际任务、设置和报告后切换；不能仅因目录或文件存在就报告数据迁移已完成。

从源码安装时先确认有含 npm 的 Node 24+，运行不带 `-SkipInstall` 的命令：脚本执行 `npm ci` 和 `npm run build`。断网时不应声称安装完成；保留报错并说明缺哪个依赖。基础命令 `node server/main.cjs` 适合前台开发，交付使用 `start.ps1` 隐藏后台启动。

脚本默认 `DataDir=%LOCALAPPDATA%\PersonalWorkboard`、`Port=18327`，也支持项目外绝对 `-DataDir` 和 `-Port`。一旦指定，两项参数在启动、停止、诊断、更新和回退中必须一致。不要把数据目录放进程序目录，不要让多个端口共用同一数据库。

## 验证正在运行的实例

用 `Invoke-RestMethod http://127.0.0.1:18327/health` 确认 `ok:true`、正确版本和 `service=personal-workboard`。与独立数据目录 `service.json` 的端口、版本、启动时间和可用的 instanceId 比对，不能只凭端口响应复用服务。`start.ps1` 已执行这些核对，重复运行只会复用符合条件的实例。

使用当前实际可用的浏览器检查中文、首次向导、空状态、任务和报告主要交互。按用户最新要求，Codex优先使用内置浏览器；隔离测试页只用合成数据，遇连接问题先核对当前任务可见状态及浏览器运行时并排查。HTTP/CLI与浏览器目视分别记录，缺少截图或交互检查时不能宣称通过。软件双击启动仍使用员工电脑的系统默认浏览器。

停止采用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop.ps1
```

脚本先取得本机会话 token，以 `X-Board-Token` 调用 `service.stop` 并等候端口释放。发生实例不符、服务拒绝或停止超时时保留现场，不强杀未知 PID。关闭浏览器窗口不等于停服。

## 交给用户自己授权

请用户自己选择报告目录、填写本人称呼、提供邮箱和所需来源信息。先配置一个真实来源并测试成功，再将状态记为接入；钉钉组织权限、微信二维码、手机确认、登录和验证码由用户本人处理。测试前必须告诉用户实际会发送的内容和接收对象；没有授权不得发送。

微信遥控需另行启用：确认本机 Codex CLI 可用，选定允许的项目，扫码绑定本人并发测试消息。验证 `/codex` 提交、审批和回传时，报告各环节的实际状态。平台接受发送不代表用户已读。定时任务要求电脑开机、未休眠且后台运行。

## 告知保存位置与限制

报告原件位于软件“设置→报告保存文件夹”，默认独立数据目录的“报告”；下载副本由浏览器设置决定。HTML/Word 不依赖 PDF 打印，PDF 需要 Edge 或 Chrome。数据库与 Windows DPAPI 凭据留在本机，跨电脑迁移需要重新登录。

V0.3.7开发预览未提供公网访问、跨机同步、系统服务注册、开机自启安装器或桌面 EXE。真实账户、第三方接口或当次更新链路没有验证时，保留“待配置/未验证”，不将手动导入结果冒充自动采集。最后用中文报告：已完成项、健康与实际交互证据、数据和报告位置、待用户扫码或授权项、可用的启动/停止方法。

## V0.3.7 首次迁移与旧失败记录恢复

以下入口沿用V0.3.3历史已验的完整故障机制；V0.3.5 与 V0.3.6 已直接验证限定新装、升级与普通停启，V0.3.7 的新功能和部署另行记录，不能沿用为已通过；完整维护故障矩阵仍为 V0.3.3 的历史证据；每次实际操作仍需核对实例、资料和回执。V0.3.2 原包、原数据与备份均保留。已有数据实例不能把旧 V0.3.2 的原地 update.ps1/rollback.ps1 当作本次修复入口。

先取得维护者提供的完整可信V0.3.7 Windows ZIP 与明确 SHA-256，核对后解压到与旧程序、旧数据相互独立的新工具目录。工具目录应包含 maintenance.ps1、maintenance-engine.cjs、maintenance-legacy.cjs 和可用 Node；不能只拷一个脚本到旧目录。在新工具目录打开 PowerShell。下列旧路径和端口应从原 service.json 与实际实例核对，不能根据示例猜测。

### 从V0.3.2迁移到V0.3.7

```powershell
$oldProgram = (Resolve-Path -LiteralPath (Read-Host '旧V0.3.2程序目录绝对路径')).Path
$oldData = (Resolve-Path -LiteralPath (Read-Host '原DataDir绝对路径')).Path
$oldPort = [int](Read-Host '原service.json记录的端口，通常18327')
$newZip = (Resolve-Path -LiteralPath (Read-Host '完整V0.3.7 Windows ZIP绝对路径')).Path
$newSha256 = (Read-Host '可信交接记录中的V0.3.7 ZIP 64位SHA-256').Trim()
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintenance.ps1 -Action Update -ProgramDir $oldProgram -DataDir $oldData -Port $oldPort -PackagePath $newZip -ExpectedSha256 $newSha256 -ExpectedVersion 0.3.7
```

该命令使用新可信工具，而不是调用旧 update.ps1。它先核对 ZIP 和内部清单、严格升版及实例，安全停服后建立完整可验证旧程序和数据快照，再开始事务替换；维护 runner 使用独立 Node 副本。按输出回执检查 completed:true，重新核对 health 的版本/实例/模式及任务、设置、报告。若使用 -NoStart，只完成离线文件和数据维护，未验证服务重启，还要实际启动核对。

### 恢复已生成的旧 needs-rollback

保留旧 .workboard-previous、.workboard-updates、分裂程序目录和原数据。找到旧 update-metadata.json 所在目录；ZIP 是当时失败目标的原部署包，不一定是本次V0.3.7。ExpectedSha256 从可信发行记录取得，外壳会同时要求与旧记录 packageSha256 相符。

```powershell
$oldProgram = (Resolve-Path -LiteralPath (Read-Host '旧失败程序目录绝对路径')).Path
$oldData = (Resolve-Path -LiteralPath (Read-Host '原DataDir绝对路径')).Path
$oldPort = [int](Read-Host '旧记录绑定的原端口')
$legacyPrevious = (Resolve-Path -LiteralPath (Read-Host '含旧update-metadata.json的PreviousDir绝对路径')).Path
$failedZip = (Resolve-Path -LiteralPath (Read-Host '当时失败目标的原部署ZIP绝对路径')).Path
$failedSha256 = (Read-Host '可信发行记录中该目标ZIP的64位SHA-256').Trim()
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintenance.ps1 -Action RecoverLegacy -ProgramDir $oldProgram -DataDir $oldData -Port $oldPort -PreviousDir $legacyPrevious -PackagePath $failedZip -ExpectedSha256 $failedSha256
```

恢复模块按旧完整 manifest 检查每个原件，从 live/saved 重建新的完整旧程序快照，再核对数据绑定。缺失原件、未知修改、同版清单不一致或路径/端口冲突会拒绝，现场保留。不要手工拼凑缺失项后把它记为已验证。恢复前完整数据会额外保存，升级后新任务可从第一次回退前快照核对；报告原件不删除。

导入成功后，回执 previousDir 指向新的 schema2 事务。如果回退过程中又遇占用或中断，释放明确的占用后，用同一新 previousDir 重试 Rollback，不能重新导入并改写首次快照：

```powershell
$recoveryPrevious = (Resolve-Path -LiteralPath (Read-Host '回执中新schema2 PreviousDir绝对路径')).Path
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintenance.ps1 -Action Rollback -ProgramDir $oldProgram -DataDir $oldData -Port $oldPort -PreviousDir $recoveryPrevious
```

回退会使当前数据库回到对应旧快照，回退前新增记录保存在首次 before-rollback 快照；保留该目录，先完整复制到独立临时目录，再打开副本查询核对。只读 SQLite 工具也可能生成 `-wal`/`-shm`，不要直接连接原密封快照；原快照保持原样供重试。未知冲突、缺失快照或 health 不符必须报告，不能改清单或反复覆盖原文件来尝试“修好”。

## 更新来源与隔离测试

V0.3.2 起内置本项目真实更新公钥，默认来源为 `project-default`、默认通道为 `stable`。员工不需要运行签名工具，也不填写维护者私钥。设置中显示的默认指纹应为 `SHA256:65b116f1c4d1c91be3a108ed51051b29683d69654fed638065f8e9a30d7edebd`。既有非空自定义公钥或其他仓库按 `custom` 保留；无效自定义配置需要明确修正，不能在迁移时静默覆盖。

正式通道只查 GitHub 正式 latest，拒绝草稿和 Pre-release；没有正式版本时不将 V0.3.1 预览冒充正式更新。预览通道需填写固定标签，例如 `v0.3.1`。普通主服务可以验证预览下载，但没有安装权限；当前或更旧版本不能降级安装。V0.3.1 已追加独立签名清单，原 ZIP 未变；它仅提供验签输入，不代表旧客户端已有新公钥或正式更新通过。

只有维护者明确执行预览安装演练时，才在候选程序目录中使用另一个空闲端口与独立数据目录。以下路径位于当前用户 TEMP，专供测试，不与默认数据目录共用：

```powershell
$testData = Join-Path $env:TEMP ('PersonalWorkboard-preview-' + [guid]::NewGuid().ToString('N'))
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1 -DataDir $testData -Port 18338 -PreviewUpdateTest
Invoke-RestMethod http://127.0.0.1:18338/health
```

开始前确认端口空闲；检查 health 与该目录 `service.json` 的 `previewUpdateTest` 都为 true，且版本/实例一致。后续停止、更新和回退始终传相同 `-DataDir $testData -Port 18338`。普通启动不带该开关，并核对 `previewUpdateTest:false`。仅新增预览的严格高版本可在测试模式准备安装；同版或旧版即使验签下载成功仍不可安装。已运行实例的模式不一致时先安全停服，不能直接复用。

活服务维护可保留已核对的测试模式；完全停服后需要再次显式选择 `-PreviewUpdateTest`。回退到不支持该标记的旧版时，只按普通隔离实例验收，不声称旧版提供预览安装权限。维护者签名、一次性票据及公钥轮换见 [RELEASE_FOR_CODEX.md](RELEASE_FOR_CODEX.md)。

## 配置平台采集器（由本机 Codex 准备）

先完成看板安装，再按用户确切选择准备工具。工具放在程序目录外的独立用户工具目录；本版钉钉使用 `%LOCALAPPDATA%\PersonalWorkboardTools\dingtalk`，不放数据库目录内部，避免程序升级或数据恢复使工具路径混乱；工具和账户资料不属于公开源代码 stage。不能为配置而扫描全部微信账号、全部群或所有钉钉组织。未知范围保留待配置。

微信仅读取明确本人账号、明确稳定会话 ID，适配以下固定上游版本，GUI 单文件 EXE 不适用于本适配器：

- [wechat-chat-export 源码提交 2c49469](https://github.com/zhuzhangxue/wechat-chat-export/tree/2c49469a91e2f3b0c73a581e15a8ad2db25b7923)，源码 V1.4.0。可在独立工具目录执行 `git clone --no-checkout https://github.com/zhuzhangxue/wechat-chat-export.git`，进入克隆目录后执行 `git checkout --detach 2c49469a91e2f3b0c73a581e15a8ad2db25b7923`。已存在工具时先核对状态，不覆盖本地文件。
- 使用独立 Python 虚拟环境，按该提交的 `requirements.txt` 安装依赖；必须为 `wechatauto-replica==1.2.4.4`。不要安装或调用全量聊天导出、账号自动搜索和进程密钥扫描；本看板执行的是固定 helper，并不直接运行上游 GUI/昵称搜索。
- 安装后先核对 `exporter_core.py` SHA-256 `c8cd97e9a0c681a0a1abebd93f5709cc958f35b2d708e8f1cd312a2a857a66b1`，`cli.py` 为 `330b9cae069d253748e3c541701a2cb00c8cace9bbcb27e1355cbb3f58acf0ca`，该 Python 环境的 `wechatauto/db.py` 为 `5ffe4d83247159b4ede26bd51a15045fe7e80d8fb0c7cbc231c3aecc4b55b841`。不匹配停止并交维护者更新适配，不能自行放宽哈希检查。
- 在“消息来源”选微信、定时读取平台会话。填写真实 Python EXE、上述 `cli.py`、本人唯一账号目录（直接含 `db_storage`）、本人稳定 username、已授权会话的稳定 username（群通常为 `...@chatroom`）。昵称不作为采集 ID。
- 必须由本人提供该账号已授权的离线逐库密钥 JSON，形状为 `{相对 db_storage 的数据库路径: 64或96位十六进制key}`。不得伪造或从其他账号缓存复制。本程序不自动提取进程密钥。没有这些材料时保持 `needs_credential`，请本人或其授权维护人员准备，不能用等待或一次扫码替代。
- 页面密钥框只负责提交给本机服务，留空保留，不回填。服务把账号 ID、唯一账号目录与 keys 组成绑定封套，经 Windows DPAPI 存 `source-wechat:<sourceId>`；采集时只经 stdin 传 helper。不得把密钥放 `source.config`、脚本参数、SQLite、诊断或公开输出。接口 `source.save` 的独立字段为 `wechatKeys`（raw keys JSON 文本），不要把它混入 `config`。
- 保存前由本人核对账号/会话并勾选授权。检测仅检查源码、依赖及凭据是否具备，不打开聊天；实际整理只读这些范围。微信每轮重读指定会话，持久去重在 AI 前完成。图片、语音、视频、附件正文不在覆盖内。快照/WAL不完整时保留旧检查点，不能说无新消息。强制终止可能使上游本次敏感临时缓存留下，按上游清理功能核对，不猜目录递归删除。

钉钉适配依据为 [官方 dingtalk-workspace-cli 核实提交 6648438](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/tree/6648438a10a4bd1f0619f27dc0b069a37d17e75c)，本版准备工具固定到 [官方 V1.0.65 Windows 原生发行](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/tag/v1.0.65) 的 `dws-windows-amd64.zip`。从“我的设置 → 消息来源配置 → 钉钉”进入唯一来源表单，在工具区点击检测或准备官方工具，核验完成后使用填入路径入口，不需要手敲安装命令。`.cmd`、`.bat`、`.ps1` 不能作为采集器原生可执行文件。

准备下载只接受固定官方 HTTPS 地址和受控跳转，ZIP 应为 20,603,005 字节，SHA-256 `db7cd21655ede7375676a349f44f5d9116fe28a8836276244341e109314407b7`；`dws.exe` SHA-256 为 `7c42d3180e16a72fc55c1e8ba1a24dbafa506dbcb5c7e62d43633127c3ce05e3`。安装目录为 `%LOCALAPPDATA%\PersonalWorkboardTools\dingtalk\v1.0.65-windows-amd64`，在程序和数据库目录之外，保留原 LICENSE、NOTICE 及安装回执。不覆盖校验不符的既有文件；错误现场保留，不能静默改用其它版本。

已完成的真实工具准备只验证版本和命令帮助兼容，没有选择本人的组织身份，也没有运行实际登录态探测、登录或读取群消息。安装工具不等于企业已授权；登录、设备码、组织许可、`corpId:userId`、稳定 `cid...` 群编号和首次读取起点仍由本人确认。

页面通过本机 `runtime.dingtalkStatus` 和 `runtime.dingtalkPrepare` 完成检测／准备；这两个入口不选择组织账号、不登录、不拉取聊天。准备阶段仅运行 `dws.exe --version`、`dws.exe chat +chat-messages --help`、`dws.exe auth status --help`。本人明确选择组织身份后，来源连接检测才可使用 `dws.exe auth status --readonly --profile corpId:userId --format json`；不刷新登录、不自动扫码。保存用户确认的 `corpId:userId`、稳定 `cid...` 群 ID，以及带时区的首次采集起点，例如 `2026-10-26T00:00:00+08:00`（示例不是已选择日期）。本机配置字段：

```js
config.collector = {
  kind: 'dingtalk-dws',
  executable: '由本机实际安装核对的 dws.exe 绝对路径',
  authorized: true, // 必须由本人明确确认，不能预设
  profile: '本人实际 corpId:userId',
  startAt: '本人选择的带时区起点'
};
// source.scope 是已授权稳定 cid 群 ID 数组，不能填群昵称。
```

实际参数固定为 `chat +chat-messages --conversation-id <已选cid> --start <起点> --end <截止> --order asc --page-all --page-limit 50 --max-items 5000 --no-reactions --profile <已选身份> --format json`。每轮最多一天、每群50页/5000条；未完整分页、失败或断网只记部分，不推进检查点，下一轮从旧窗口重试且 AI 前去重。当前不读取单聊、媒体内容、话题或 reaction，不标记消息已读。

来源状态分别解释：`not_installed` 工具未安装；`needs_login` 待本人登录或授权；`needs_scope` 范围未定；`needs_credential` 微信离线凭据不足；`snapshot_incomplete` 文字快照不完整；`partial` 部分；`no_new` 完整处理且没有未入库消息；`collected` 本轮完整处理；`cancelled` 已取消；`failure` 失败。`platformCollectedAt` 表示平台调用完成时刻，`fileProcessedAt` 只表示本机解析时刻，均不等于业务已完成或媒体已查看。

## 受管会话、文件与恢复

微信连接需本人扫码、核对绑定并建立私聊上下文。遥控另外开启并选择允许项目。`/codex 内容` 创建受管会话，`/继续 会话编号 内容` 或 `/继续 最近 内容` 明确续接；`/停止` 停止最近受管工作。重启后的活动态为待核对，没有自动重发和审批码恢复。超长/当前协议不支持的审批在生成可批准码之前明确拒绝，需转本机处理。

只回传首次登记报告、完整结果文字文件及本轮成功 fileChange 明确新增/修改的受支持文件，不扫描项目、不解析聊天里的任意路径作为产物。发送前重新检查 realpath、当前项目授权、文件类型、20 MiB 上限和首次登记 SHA-256。完整文字软件上限4 MiB，超过明确报错保留本机受管结果，不静默截断。报告摘要与文件分别发送。未知发送必须本人核对，人工重试只补未接受分段；旧审批通知永不重试。主进程退出后的 uploading/sending 状态保守恢复为待核对，不能重启即重发。

本预览继承已配置的默认 GitHub 仓库与公钥；实际签名下载、安装、重启与回退仍分别记录当次证据，不能跳过验签。发布由维护者统一协调。给同事的最终提示使用真实仓库、实际发布并验收的版本与校验值，当前文档不构成正式安装成功声明。

## 验证证据与边界

V0.3.7 的自动测试、实际浏览器交互、Windows 新装、源码安装和原位升级分别记录。发行说明应列出当次实际完成的项目、未通过项和未覆盖范围；本文件不预填测试数量、资产 hash 或通过结论。后台版本检测与未保存内容保护必须经过实际旧页面跨后台版本变化的隔离验证，不能用 health 成功替代。

已发布 V0.3.6 的历史证据为：279 项自动测试及生产构建通过；已登录 Codex 的固定合成示例取得严格任务 JSON 和完整成功轮次；Chrome 合成设置页的桌面、窄屏交互及 Impeccable 检测通过。Windows 隔离新装 17 项、源码隔离安装 7 项是 HTTP／CLI 部署验证，不包含实际浏览器目视或真人验收；主实例原位升级与普通停启另有核验。上述结果不自动覆盖 V0.3.7。

本版已记录两项独立的真实技术验证：MET Norway 对北京公开城市中心样例返回可用预报，没有读取浏览器或本人位置、没有改用户设置；官方钉钉 Windows 原生 DWS V1.0.65 已下载并核验，版本与只读命令帮助兼容，Apache-2.0 的 LICENSE／NOTICE 已保留。尚未选择本人的组织身份，未执行实际身份登录态探测、登录或群消息拉取。这些技术结果不等于本人天气定位、企业授权、来源接入或本版完整界面验收。

历史本人微信菜单、连接测试与一次手动日报已确认收到，接口已读仍未知，旧 failed／unknown 账本保留。真实来源分析、Codex 遥控编程、文件往返、实际定时与跨日，以及完整正式自动更新仍待分别验收。完整维护故障矩阵属于 V0.3.3 的限定历史证据。

## Codex 任务分析（自 V0.3.6 提供）

在“我的设置 → 任务分析方式”选择“Codex 分析（使用本机已登录账号）”。先检测连接，勾选同意将已选来源的消息文字发送到 Codex 服务，再用固定示例测试分析，最后保存。需要安装兼容的 Codex CLI 并由本人登录；不需要填写 API 地址或密钥。分析不更改微信遥控开关，不接管已有 Codex 会话。默认仍为本机规则，升级不会自动切换分析方式。

该模式不是本机离线模型。分析在独立临时目录运行，跳过用户配置及规则，禁用命令、插件、MCP、浏览器和图片等能力，使用 CLI 内建默认模型及已保存登录授权；不继承日常编程的自定义模型或工具配置。不支持受限调用参数的旧 CLI 显示需更新，不回退到放宽权限的调用。失败、取消、超时或格式不合格的消息保留待重试，不自动提交 coding 任务或发送微信。


## 后台版本变化与页面刷新（V0.3.7）

页面加载的客户端版本与后台运行版本分别核对。V0.3.7 页面通过只读健康检查检测后台升级或回退；发现版本不一致时给出提示，由本人主动刷新，不自动重载页面或重新读取并覆盖表单。检测失败不能当作已有新版本，也不能自动安装软件。

有未保存内容时，先继续编辑并保存，再使用刷新入口。刷新确认应明确提示未保存内容，取消后继续保留当前输入。保护只针对当前页面内存，不等于自动保存或可跨页面恢复草稿；密码、密钥和其他表单内容不写入浏览器持久存储。浏览器关闭或手动刷新前仍应保存需要保留的内容。

**已在 V0.3.6 或更早版本打开的标签，需要本人先保存，再手动刷新一次，才能加载 V0.3.7 的检测逻辑。** 已加载的旧 JavaScript 不能通过替换后台文件自动获得新功能；维护人员不要擅自刷新用户的旧设置页。之后仍保持用户主动刷新与未保存内容保护。


## V0.3.7 新增使用入口

- **北京时间时钟**：顶部显示完整年月日、星期和时分秒，每秒更新，按 Asia/Shanghai 显示；它使用电脑当前时间，不替代操作系统校时。
- **天气与位置**：天气默认关闭，联网条款同意默认未勾选。打开顶部天气设置，本人阅读条款并同意后，可启用天气；首次默认采用一次浏览器精确定位方式，权限仍由本人按浏览器正常流程选择。拒绝、失败或超时均可改选城市／区县。只保存最后选择的位置，不持续定位、不保存轨迹。
- **立即整理**：在任务页启动本轮整理，仅使用已启用来源及其已保存的范围、凭据和授权配置，复用原有同步与去重流程，不扩大到未选账号、群或文件夹。逐来源展示等待、正在整理、成功、跳过或失败及实际数量；可请求取消，已入库记录保留。整轮结束不等于每个来源都成功，要逐项核对。此入口不生成日报，也不发送微信。
- **默认看板**：首页进入全部状态的看板，包含已完成列；今天要做仍保留日期范围，全部任务页可核对更完整的任务集合。
- **邮箱与钉钉**：从“我的设置 → 消息来源配置”进入同一份来源表单；不在设置页另存一套账号。一条邮箱来源只读取一个邮件文件夹，保存范围与实际读取一致，SSL/TLS 固定开启。钉钉表单提供本机工具检测、官方工具准备和程序路径填入入口，准备工具不等于企业已授权。

天气的城市／区县名称使用随程序提供的 GeoNames 中国地名索引在本机搜索，共 5,722 条，来源日期为 2026-10-27；索引包含筛选后的省市区县等候选地名，不代表最新行政边界或全国全覆盖，重名时请核对省市。搜索文字不发送给第三方。开启天气后，仅把选定经纬度作为位置参数发送至固定 HTTPS 的 MET Norway 接口，坐标最多保留四位小数；请求带程序标识，并按接口缓存规则复用预报。天气显示为数值预报，不是气象站现场实测；失败或使用旧缓存会显示对应状态和时间。

[MET Norway](https://www.met.no/) 预报和 [GeoNames](https://www.geonames.org/) 地名数据均按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 归因。GeoNames 原始 CN.zip 来源、下载日期、筛选说明和索引 SHA-256 保存在随包的 `public/china-places-meta.json`，数据在 `public/china-places.json`。

## 邮箱、天气与本轮整理的首次配置

邮箱：在“我的设置 → 消息来源配置”打开邮箱入口，填写本人 IMAP 服务器、加密端口、账号和专用授权码。每条邮箱来源只填一个唯一文件夹，常见收件箱为 `INBOX`；需要多个文件夹时分别建来源。保存的 `scope` 与 `config.mailbox` 必须一致，SSL/TLS 固定开启。检测成功只证明连接与该文件夹可用，实际入库还需本人执行一次整理核对。

天气：预报请求固定使用 `https://api.met.no/weatherapi/locationforecast/2.0/compact`，不接受表单传入替代服务地址；维护时保留应用 User-Agent、缓存与 CC BY 4.0 归因。点击顶部天气设置，阅读服务条款并本人勾选发送坐标授权，再启用天气。首次位置方式默认一次浏览器精确定位，按钮触发浏览器正常权限；本人可以拒绝，不以脚本代点权限。拒绝、超时或不支持时切换城市／区县，在本机索引搜索并核对正确结果后保存；也有手动坐标入口。最后位置与开关存于本机设置，重用已保存位置，不持续定位或保存轨迹。关闭天气或撤回同意后不继续获取预报，正在请求的结果不得按旧授权回填。

立即整理：来源配置、凭据和范围由本人保存后，从任务页启动。观察每个来源的状态与实际数量；没有可用来源时仍明确显示待配置，不生成虚假消息或示例结果。取消只停止后续读取，已经入库的记录保留，分页不完整或失败时按原同步规则保留检查点。分析采用当前已授权的任务分析方式；开启在线／Codex 分析时，仍遵守其单独的文字发送授权。

## 阿里企业邮默认配置

新建邮箱来源默认预填 `imap.qiye.aliyun.com`、端口 `993`、SSL/TLS 和单一文件夹 `INBOX`；已保存配置保留，其他邮箱可手动修改服务器。本人填写完整邮箱地址与三方客户端安全密码，管理员需已允许第三方客户端和 IMAP。密码不回填、不进入浏览器持久存储。参见[阿里邮箱官方服务器说明](https://help.aliyun.com/zh/document_detail/36576.html)与[三方客户端安全密码](https://help.aliyun.com/zh/document_detail/444269.html)。默认参数不代表账号已经接入，不代为登录或读取邮件。
