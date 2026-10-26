# 交给 Codex 的本机安装说明 V1.1.0

当前为 V0.3.1 开发预览；离线测试与本机部署不代表真实渠道接入通过。

目标：在使用者自己的 Windows x64 电脑上运行个人待办事项看板 V0.3.1。每人一个独立数据目录，打开浏览器使用。本文不要求 Docker、Electron、公网域名或云服务器。

## 先确认下载材料

目标公开仓库为 https://github.com/liruiqi250-hub/personal-workboard ，owner=liruiqi250-hub，repo=personal-workboard。v0.3.1 为开发预览，可按实际发行页的明确版本试装；正式签名更新及最终业务验收尚未完成。先核对实际发布状态、已验版本、部署 ZIP 与对应 SHA-256，再下载；不能把仓库存在视为发行验收已通过，也不能将 GitHub 源码 ZIP 当作包含运行依赖的部署 ZIP。

在下载后、解压前用 `Get-FileHash -Algorithm SHA256` 与可信发行记录比对。`.sha256` 与 ZIP 从同一未知来源取得只能用于检测传输损坏，不能证明发行者身份。完整解压后，程序根目录应包含 `package.json`、`server`、`dist`、`scripts` 和 `release-manifest.json`；部署包还包含 `node_modules`。

## 执行部署

在解压目录打开 PowerShell；以下相对路径均相对于程序根目录：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 -DownloadNode -SkipInstall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnose.ps1
```

`-DownloadNode` 仅在找不到合适运行时时，从 `https://nodejs.org/dist/v24.15.0/` 获取 Windows x64 ZIP 和官方校验清单。必须 SHA-256 一致后才解压启用。下载留在程序目录 `vendor`，不修改全局 PATH。已有 Node 24+ 时优先复用；部署包可选只附带 Node 运行时与许可证，未必包含 npm。

从源码安装时先确认有含 npm 的 Node 24+，运行不带 `-SkipInstall` 的命令：脚本执行 `npm ci` 和 `npm run build`。断网时不应声称安装完成；保留报错并说明缺哪个依赖。基础命令 `node server/main.cjs` 适合前台开发，交付使用 `start.ps1` 隐藏后台启动。

脚本默认 `DataDir=%LOCALAPPDATA%\PersonalWorkboard`、`Port=18327`，也支持项目外绝对 `-DataDir` 和 `-Port`。一旦指定，两项参数在启动、停止、诊断、更新和回退中必须一致。不要把数据目录放进程序目录，不要让多个端口共用同一数据库。

## 验证正在运行的实例

用 `Invoke-RestMethod http://127.0.0.1:18327/health` 确认 `ok:true`、正确版本和 `service=personal-workboard`。与独立数据目录 `service.json` 的端口、版本、启动时间和可用的 instanceId 比对，不能只凭端口响应复用服务。`start.ps1` 已执行这些核对，重复运行只会复用符合条件的实例。

使用实际可用的外部 Edge/Chrome 检查页面，确认中文显示、首次向导、空数据状态、手动新增/修改/完成任务、报告预览与保存。网页自动化优先选择已经连接的外部浏览器扩展。外部浏览器连接不可用时，继续可完成的 CLI/HTTP 检查，说明缺少实际截图验证；不要自动改用 Codex 内置浏览器。

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

V0.3.1 未提供公网访问、跨机同步、系统服务注册、开机自启安装器或桌面 EXE。真实账户、第三方接口和自动更新源没有验证时，保留“待配置/未验证”，不将手动导入结果冒充自动采集。最后用中文报告：已完成项、健康与实际交互证据、数据和报告位置、待用户扫码或授权项、可用的启动/停止方法。

## 配置平台采集器（由本机 Codex 准备）

先完成看板安装，再按用户确切选择准备工具。工具放在程序目录外，例如独立数据目录的 `tools`，避免程序升级使路径失效；工具和账户资料不属于公开源代码 stage。不能为配置而扫描全部微信账号、全部群或所有钉钉组织。未知范围保留待配置。

微信仅读取明确本人账号、明确稳定会话 ID，适配以下固定上游版本，GUI 单文件 EXE 不适用于本适配器：

- [wechat-chat-export 源码提交 2c49469](https://github.com/zhuzhangxue/wechat-chat-export/tree/2c49469a91e2f3b0c73a581e15a8ad2db25b7923)，源码 V1.4.0。可在独立工具目录执行 `git clone --no-checkout https://github.com/zhuzhangxue/wechat-chat-export.git`，进入克隆目录后执行 `git checkout --detach 2c49469a91e2f3b0c73a581e15a8ad2db25b7923`。已存在工具时先核对状态，不覆盖本地文件。
- 使用独立 Python 虚拟环境，按该提交的 `requirements.txt` 安装依赖；必须为 `wechatauto-replica==1.2.4.4`。不要安装或调用全量聊天导出、账号自动搜索和进程密钥扫描；本看板执行的是固定 helper，并不直接运行上游 GUI/昵称搜索。
- 安装后先核对 `exporter_core.py` SHA-256 `c8cd97e9a0c681a0a1abebd93f5709cc958f35b2d708e8f1cd312a2a857a66b1`，`cli.py` 为 `330b9cae069d253748e3c541701a2cb00c8cace9bbcb27e1355cbb3f58acf0ca`，该 Python 环境的 `wechatauto/db.py` 为 `5ffe4d83247159b4ede26bd51a15045fe7e80d8fb0c7cbc231c3aecc4b55b841`。不匹配停止并交维护者更新适配，不能自行放宽哈希检查。
- 在“消息来源”选微信、定时读取平台会话。填写真实 Python EXE、上述 `cli.py`、本人唯一账号目录（直接含 `db_storage`）、本人稳定 username、已授权会话的稳定 username（群通常为 `...@chatroom`）。昵称不作为采集 ID。
- 必须由本人提供该账号已授权的离线逐库密钥 JSON，形状为 `{相对 db_storage 的数据库路径: 64或96位十六进制key}`。不得伪造或从其他账号缓存复制。本程序不自动提取进程密钥。没有这些材料时保持 `needs_credential`，请本人或其授权维护人员准备，不能用等待或一次扫码替代。
- 页面密钥框只负责提交给本机服务，留空保留，不回填。服务把账号 ID、唯一账号目录与 keys 组成绑定封套，经 Windows DPAPI 存 `source-wechat:<sourceId>`；采集时只经 stdin 传 helper。不得把密钥放 `source.config`、脚本参数、SQLite、诊断或公开输出。接口 `source.save` 的独立字段为 `wechatKeys`（raw keys JSON 文本），不要把它混入 `config`。
- 保存前由本人核对账号/会话并勾选授权。检测仅检查源码、依赖及凭据是否具备，不打开聊天；实际整理只读这些范围。微信每轮重读指定会话，持久去重在 AI 前完成。图片、语音、视频、附件正文不在覆盖内。快照/WAL不完整时保留旧检查点，不能说无新消息。强制终止可能使上游本次敏感临时缓存留下，按上游清理功能核对，不猜目录递归删除。

钉钉使用 [官方 dingtalk-workspace-cli 核实提交 6648438](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/tree/6648438a10a4bd1f0619f27dc0b069a37d17e75c)。先按官方发行资料准备兼容的 Windows 原生 `dws.exe`，核对来源/版本；`.cmd`、`.bat`、`.ps1` 不能作为本适配器可执行文件。安装工具不等于企业已授权，登录、设备码和组织许可由本人完成。

只读探测使用 `dws.exe --version`、`dws.exe chat +chat-messages --help`、`dws.exe auth status --help`、`dws.exe auth status --readonly --profile corpId:userId --format json`；不刷新登录、不自动扫码。保存用户确认的 `corpId:userId`、稳定 `cid...` 群 ID，以及带时区的首次采集起点，例如 `2026-10-26T00:00:00+08:00`（示例不是已选择日期）。本机配置字段：

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

真实 GitHub 默认目标已填写，签名公钥及正式 Release 未就绪时保持待配置；当前不应通过跳过验签让更新运行。发布由维护者统一协调。给同事的最终提示应使用真实仓库、实际发布并验收的版本与校验值，当前文档不构成正式安装成功声明。
