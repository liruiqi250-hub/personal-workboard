# Codex 安装与维护约定 V1.3.0

目标公开仓库：https://github.com/liruiqi250-hub/personal-workboard 。[v0.3.1](https://github.com/liruiqi250-hub/personal-workboard/releases/tag/v0.3.1) 已按开发预览发布，属于 Pre-release、非正式 latest；V0.3.2 本次按开发预览发布，发行页为 https://github.com/liruiqi250-hub/personal-workboard/releases/tag/v0.3.2 ，仍非正式 latest。本文件不授权发布。

当前软件为 V0.3.2 开发预览。离线协议、签名元数据或部署测试不代表真实微信、邮箱、钉钉、跨日发送或真人界面验收通过。

所有用户沟通使用中文。软件每次变更都递增版本号，更新 CHANGELOG，保留可回退的上一程序及对应数据快照。UI 改动优先使用已安装的 Impeccable 技能，复用现有 Ant Design 组件，运行实际页面并检查中文、布局、溢出、主要状态与 Impeccable 检测结果。

本项目是 Windows 本机 Web 程序：Node.js 24+、React、Ant Design、Vite、Node HTTP 和 SQLite。默认只监听 `127.0.0.1:18327`；`BOARD_PORT` 与 `BOARD_DATA_DIR` 可以覆盖。不得把它误写为已经交付的 Electron EXE、Docker 服务、公网网站或已完成真实账户接入。

## 在新电脑安装

先阅读 `docs/INSTALL_FOR_CODEX.md`。从可信发行页取得已核验 SHA-256 的部署 ZIP，完整解压到独立程序目录。命令均从该程序目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 -DownloadNode -SkipInstall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnose.ps1
```

源码 checkout 使用不带 `-SkipInstall` 的部署命令。`npm ci` → `npm run build` → `node server/main.cjs` 是基础流程；交付脚本将最后一步隐藏到后台。缺 Node 时只从 nodejs.org HTTPS 下载并校验 SHA-256，运行时只放 `vendor/node`，不能擅改系统 PATH。双击启动通过 Windows 默认外部浏览器打开页面；自动验证不要切换到 Codex 内置浏览器。先检查实际连接的 Edge/Chrome；外部扩展不可用时使用 HTTP/CLI 完成可完成的检查并如实说明截图验证缺失。

## 重复运行与安全停服

已运行时用 `scripts/start.ps1` 复用。先读取 `/health`，再比对数据目录 `service.json` 中的端口、版本、启动时间及实例标识。存在响应但实例不匹配时报告端口冲突，不接管未知服务。安全停止使用先取 `/api/session` token，再 POST `/api/call` 的 `service.stop`，不根据旧 PID 猜测或强杀其他 Node 进程。关闭网页不会停止后台。

隔离验证统一传入同一个项目外绝对 `-DataDir` 和空闲 `-Port`，验证后使用相同参数停服。数据目录默认 `%LOCALAPPDATA%\PersonalWorkboard`，不能放在程序目录内部；不得让两个实例写同一数据库。

健康接口 HTTP 200 且 `ok:true` 只证明服务在运行。仍需实际检查页面和主要交互。不要把计划执行的命令、文件存在、源码搜索命中或平台 `accepted` 当作整体验收通过。

## 用户自己完成的步骤

请用户在本机页面填自己的称呼、报告目录与所需来源；不要编造员工、邮箱、钉钉或微信信息。微信扫码、验证码、手机确认、重新登录和授权只能由用户本人操作。扫码后核对绑定对象、实发测试回执，再验证消息接收；只有二维码或接口 accepted 不能宣称用户已读或完整接入。Codex 遥控先检查 CLI，再启用本人绑定、遥控开关和允许项目；不要把普通聊天当任意 shell 命令。

报告原件目录由软件设置决定；浏览器下载副本目录由浏览器决定，分别报告。凭据文件 `credentials.dpapi.json` 与数据库不入公共仓库，也不放入公开部署 ZIP。

## 升级和回退

先读 `docs/RELEASE_FOR_CODEX.md`。只接受已核验 ZIP 或真实 GitHub 仓库的发行资产，`ExpectedSha256` 必填。没有正式仓库地址时不得编造远端、发行链接或宣称已发布。`scripts/update.ps1` 在覆盖前保留独立数据快照与 `.workboard-previous` 中的上一程序。`scripts/rollback.ps1` 只能恢复带 `update-metadata.json` 的指定上一版本，数据库与凭据恢复到匹配快照，回退前数据和报告文件均保留。

V0.3.2 默认 `sourceMode=project-default`，使用 `public/update-trust.json` 里的本项目仓库、公钥和指纹；员工启动不生成维护者密钥。旧设置中明确的自定义仓库/公钥必须保留；旧自定义配置无效时显示配置错误，不能静默抹除或替换。正式通道 `stable` 只接受非草稿、非 Pre-release 的正式发行；`preview` 必须明确固定 `v主.次.修订` 标签。普通主服务只能验签下载预览，不能安装；同版和旧版只能验证，不能降级。

预览安装仅用于明确的隔离测试：`start.ps1 -PreviewUpdateTest` 加项目外独立绝对 `-DataDir`、非默认数据目录、非 `18327` 端口，检查 `/health` 与 `service.json` 的 `previewUpdateTest:true`。普通启动必须保持 false，不能用继承环境变量绕过隔离。安装使用持久一次性票据，改来源/通道/公钥后重新检查；已消费或重启中断的票据先人工核对，不自动重放。安装入口向更新脚本传递已验签的 `ExpectedVersion`，在停服前核对包内版本。

维护者签名只使用显式 `node scripts/sign-update.cjs init/public/sign`。默认私钥封套在项目外 `%LOCALAPPDATA%\PersonalWorkboardPublisher\liruiqi250-hub\personal-workboard`，受当前 Windows 用户 DPAPI 保护；禁止把封套、明文私钥或凭据纳入源码、部署包、日志或诊断。轮换需经已可信版本带入新公钥，错过过渡版本使用可信安装流程，不从未验证网络内容自动替换信任。发布和资产上传由维护者统一协调。

脚本读写、移动和复制前必须检查绝对路径边界，拒绝路径联接和越界包条目。不能递归删除用户资料，不能为发布而扫描或打包聊天、私人配置和真实数据库。公开包由 `scripts/package.cjs` 显式白名单构建，禁止直接压缩整个工作目录。

发布前检查实际构建、测试、包内清单和独立目录启动；只有实际完成的检查才记为通过。Git 操作、发布和安装账户授权遵从当前用户指令；此文件不授权推送、登录账号或发送消息。

## 来源与遥控维护

先读 `docs/INSTALL_FOR_CODEX.md` 的平台采集配置。不能把 GUI 导出器当成已支持的 CLI；微信仅适配明列的 v1.4.0 源码和依赖哈希，钉钉需要兼容的原生 dws 可执行文件及企业授权。没有本人明确账号、该账号离线解密凭据与稳定会话 ID，不得执行微信平台采集。禁止自动扫描微信进程内存、跨账号和全局 key cache；凭据经 DPAPI 保存，仅在采集时通过 stdin 传固定 helper，不进入 config/SQLite/argv/日志/前端。Bot 扫码只建立私聊通道，不授予工作消息范围。探测只能 version/help/本地 readonly 登录态；微信 helper 的 check 不打开数据库。

Codex 只登记本组件创建的会话。重启活动态待核对，不重发、不恢复审批；明确继续时重新校验同一会话与授权目录。不得导入或接管桌面其他聊天。产出只接受本轮协议成功新增/修改的文件，先登记 hash 再发送；不能根据聊天里提到的路径或扫描整个项目选文件。

微信上传和消息接受分别记录，结果未知不自动重发；人工核对后只重试未接受部分。旧审批通知不可重试。凭据、CDN 下载参数和加密 key 不得进入前端或公开诊断。上游微信读取被强制终止时清理不能保证完成，按上游功能核对敏感临时缓存，不递归删除猜测的用户目录。
