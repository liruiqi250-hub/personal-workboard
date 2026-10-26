# 维护、升级与公开发版 V1.3.0

当前为 V0.3.2 开发预览；离线测试与本机部署不代表真实渠道或真人界面验收通过。

软件当前 V0.3.2 开发预览；每次变更都递增 `package.json`、锁文件中的版本，更新 README 与 CHANGELOG，保留上一程序及对应数据。真实目标仓库为 https://github.com/liruiqi250-hub/personal-workboard 。[v0.3.1](https://github.com/liruiqi250-hub/personal-workboard/releases/tag/v0.3.1) 已作为 Pre-release 发布，非正式 latest；V0.3.2 本次同样按 Pre-release 发布、非正式 latest，实际资产以对应发行页为准。发布由维护者统一协调，开发阶段准备干净 stage、版本 ZIP 和明确文件清单，避免并发 push 或创建 Release。

## 构建公开部署包

前端构建会按最终 chunk 收集实际包版本及 Vite/Rolldown 注入的运行时代码，生成完整第三方原件、汇总及许可 manifest 到 `public` 和 `dist`。缺少完整许可原件或遇到未知有输出的虚拟模块时停止，不用链接或手写许可摘要替代。固定官方精确版本的缺件原件在 `public/third-party-license-sources/`，原件 SHA 与来源记录随包保留；不可把其他版本许可替换进来。

发行验证器检查两份声明完整且字节一致，删除汇总、遗漏实际依赖条目或缺少原件即使重算外层发行清单也会拒绝。`Get-BoardProgramEntries` 中的 `public`、`dist` 是整体升级与回退项，包含这些声明；不能只搬 JS bundle。Node 与后端原件继续保留。项目整体 LICENSE 由维护者另行决定，本流程不代选。

先完成适合本次变更的测试、构建和独立目录启动。Windows 上使用 Node 24+：

```powershell
npm ci
npm run build
npm test
node .\scripts\package.cjs
```

默认生成含 `dist` 和生产 `node_modules` 的部署包。打包器在 `work/package` 下的独立副本按锁文件执行 `npm ci --omit=dev --ignore-scripts`，不删除开发目录依赖。可选 `--with-node-runtime` 将当前 Windows x64 Node 可执行文件及完整 LICENSE 加入包。许可证优先取 Node 安装目录的 `LICENSE` 或 `LICENSE.txt`；缺失时从 `raw.githubusercontent.com/nodejs/node` 对应当前 Node 版本的官方 tag 获取，限时 30 秒，并核对 Node 标题与 MIT 许可段。取得失败或内容不符则拒绝分发，不修改 Node 安装目录。`--source-only` 生成需在目标机安装依赖的源码包，不可用于直接自动升级。运行打包器不会发布 GitHub。

输出位于程序目录 `release/`：ZIP、`.zip.sha256`。ZIP 内有 `release-manifest.json`，登记每个公开文件的相对路径和 SHA-256；不包含机器路径。相同版本同类型的 ZIP 已存在时拒绝覆盖，要求先递增版本。`validate-package.cjs` 会核对清单、版本、链接和额外文件。

已通过公开白名单和清单验证的干净 stage 保留在 `work/package`，可供之后筹备公开源码提交。随包附带的 `.gitignore` 忽略内部监督、计划、验证、需求资料、工作目录、上一程序/更新暂存和 vendor 运行时；公开 Git 提交仍应从干净 stage 审查，不能对原始工作目录直接 `git add .`。本机已跟踪的内部文件不会因新增 ignore 自动解除跟踪，公开前仍要检查实际拟提交清单。

只允许公开根文件、`dist`、`server`、`scripts`、`src`、`public`、生产 `node_modules`、可选 `vendor/node`，以及本目录中的两份安装/发版指南。不得打包 `docs/oversight`、内部 specs/plans/verification、`work`、真实数据库、密钥、私有配置、`.env`、日志、service 元数据、聊天标识、个人绝对路径或原始账号资料。绝不直接压缩整个工作目录。白名单和文本扫描只是辅助，仍需检查最终 ZIP 文件列表与独立解压启动。

## 更新到另一版本

V0.3.2 默认使用 `sourceMode=project-default`，内置本项目 owner/repo 与 Ed25519 公钥，员工不需要配置签名材料。`public/update-trust.json` 与 `dist/update-trust.json` 必须字节一致，keyId 为公钥 SPKI DER 的 SHA-256。当前指纹为 `SHA256:65b116f1c4d1c91be3a108ed51051b29683d69654fed638065f8e9a30d7edebd`。原有明确自定义仓库或非空公钥保留为 `custom`；无效自定义配置显示错误，不能静默变成项目默认来源。

`stable` 查询正式 latest，并拒绝 draft/prerelease。`preview` 要求明确固定 tag，且实际 Release 必须为 Pre-release；普通主服务只验签下载，安装需显式隔离测试模式。任何通道都不允许同版或降级安装。没有正式 Release 时不把预览或“最新标签”当成正式更新。

程序先验证固定协议的 Ed25519 签名，再绑定 owner/repo/channel/version/tag/assetName/platform/URL/SHA-256/bytes/keyId/sequence/createdAt，实际 GitHub Release 和资产也必须一致。ZIP 限 400 MiB，受控 GitHub HTTPS 重定向且有大小/超时上限。持久账本按来源、通道和公钥记录序号与一次性安装票据；安装准备占用票据、重读文件、备份、再次核对后消费。已消费或中断的票据不能自动重放。仅备份阶段明确失败时，需使用者显式重新下载核验后申请新票据，失败记录保留。

手动维护时仍须从可信发行记录取得新 ZIP 和真实 SHA-256。命令行更新进行 HTTPS 资产下载、ZIP SHA-256、内部文件清单及可选 `ExpectedVersion` 核验，不替代程序内的签名验证入口。

本地已下载包：

```powershell
.\scripts\update.ps1 -PackagePath (Resolve-Path '.\新版本部署包.zip').Path -ExpectedSha256 '填写发行记录中的64位SHA256'
```

也可传入使用者已核实的真实 `-Repository owner/repo -Tag v版本 -AssetName 资产.zip -ExpectedSha256 校验值`，脚本仅构造 `https://github.com/.../releases/download/...`。这些是参数说明，不是真实仓库。HTTP 下载和缺少校验值均不支持。

从程序内安装时必须传入已验签的 `-ExpectedVersion`；脚本在停服前核对包内实际版本与声明一致，并拒绝同版和降级。手动维护可以同时传此参数加强版本核对。不要为了安装预览而修改默认用户数据目录或 `18327` 主服务的模式。

脚本先在 `.workboard-updates` 验证包，再核对本机实例并通过 `service.stop` 停服。独立数据目录的 `backups/before-update-*` 保存数据库、凭据及数据目录内的报告等文件；日志、打印临时文件和已有 backups 不重复复制。自定义到数据目录之外的报告原件仍由原位置保管，升级不覆盖它们。

上一程序存于 `.workboard-previous/时间-标识/program`，`update-metadata.json` 将旧/新版本、端口、独立数据目录、包校验值和对应快照绑定。此目录包含本机路径，只留本地，不能加入公共包。替换失败会保留已移动文件与进度，并输出指定回退命令；它不会谎报更新完成。正常更新后核对新版本健康与主要功能。

## 回退时匹配数据库

使用更新脚本输出的上一版本目录：

```powershell
.\scripts\rollback.ps1 -PreviousDir (Resolve-Path '.\.workboard-previous\实际目录名').Path
```

自定义部署要补上原来的 `-DataDir` 和 `-Port`。脚本拒绝目录/端口不符或快照缺失的回退；先停服，保留回退前程序及完整数据快照，再恢复上一程序和升级前匹配的数据库、凭据。升级后新增任务会留在“回退前”快照中，当前界面退回升级前状态；报告文件不删除。不要只放回一个旧 JS/EXE 后宣称回退成功，也不要递归清空用户数据。

独立演练时可使用所有脚本的 `-DataDir`、`-Port`、部署的 `-SkipInstall` 和升级/回退的 `-NoStart`。验收不得使用真实用户数据库。静态解析通过只能证明脚本语法可解析，仍需核验下载、校验失败保护、端口冲突、重复启动、安全停服、更新和回退的实际行为。

预览安装测试必须通过 `start.ps1 -PreviewUpdateTest`，同时显式指定项目外、非默认的数据目录及非 `18327` 端口；health 与 service 元数据的 `previewUpdateTest` 必须一致为 true。普通启动剥离继承的测试环境变量。活服务更新/回退可保留已核实模式；完全停服后须显式重新选择。回退到不支持该模式的旧版时只做普通隔离升级/回退验证。完整命令见安装指南。

## 维护者签名与密钥轮换

签名工具只绑定 `liruiqi250-hub/personal-workboard`，不会上传或发布。维护者在自己的 Windows 用户下显式操作；员工部署和普通启动不调用 `init`。真实私钥只存在项目外的当前用户 DPAPI 封套，默认目录为 `%LOCALAPPDATA%\PersonalWorkboardPublisher\liruiqi250-hub\personal-workboard`。封套不能纳入代码、ZIP、日志、诊断或发给员工；不可借用其他项目的发布密钥。

在程序根目录运行：

```powershell
node .\scripts\sign-update.cjs init
node .\scripts\sign-update.cjs public
```

`init` 首次创建密钥，重复执行核对已有封套，不轮换或覆盖；`public` 只输出公钥、keyId 和指纹。工具不提供明文私钥导入/导出。可用 `--key-dir` 明确选择项目外本机盘符绝对目录；目录或祖先为链接、位于项目内或为设备/UNC 等别名时拒绝。

先完成部署包冻结、独立启动与回退检查，再签实际 ZIP。下面为 V0.3.2 候选的预览签名准备命令，输出不会自动发布，序号 2 延续本公钥预览通道已用的序号 1：

```powershell
$zip = (Resolve-Path '.\release\personal-workboard-0.3.2-windows-x64.zip').Path
$signingOutput = Join-Path (Get-Location).Path 'release-metadata\v0.3.2-preview'
node .\scripts\sign-update.cjs sign --zip $zip --version 0.3.2 --tag v0.3.2 --channel preview --sequence 2 --output-dir $signingOutput
```

工具核对 ZIP 包内项目名称、版本、部署类型与平台，再计算实际大小/hash并签名，输出 `update-manifest.json`。签名后不能改 ZIP；相同输出文件只有完全相同时才允许复用，不覆盖不同内容。每个 owner/repo/channel/keyId 范围内维护严格递增的正整数 sequence，不能重签旧序号冒充新发布；正式与预览通道分别记账。上传前逐项复核清单与 ZIP 的版本、tag、通道、资产名、字节数和 hash，上传由维护者统一协调。

现有 V0.3.1 Pre-release 已追加独立 `update-manifest.json`：734 字节，SHA-256 `64777b758294f0d8ea29fccc3731a38f4174225d0d086463e7acf53036626b9f`，preview 通道 sequence=1。原 Windows ZIP 保持 45,476,907 字节，SHA-256 `e3ffcfd818260a1f384ae5ea73ad70f703ed2a9e417a0a77c9581ad7416960eb`。追加清单不修改原包、不把它改成正式 latest，也不使旧客户端自动具备新公钥。验签下载、实际安装、重启和回退各自需真实证据。

轮换时先发布由旧可信密钥签名、包内带新公钥和指纹的过渡版本，确认过渡安排后再用新密钥签发后续版本；当前程序只信任所选公钥，不实现网络下载后自动信任另一把 key。没有收到可信过渡版本的用户，通过核对发行者、文件和校验值的可信安装流程恢复。自定义来源由使用者明确更新，不能自动覆盖。DPAPI 绑定当前 Windows 用户，换账户/换机不能假定旧封套可用；不要临时生成新 key 后继续声称与原指纹相同。

## 试装转发文案

当前只能按已发布且核验过的明确预览版本试装。V0.3.2 发布后另行核对资产与校验值，再更新转发版本。建议文案：

> 个人待办事项看板已提供 V0.3.1 开发预览：https://github.com/liruiqi250-hub/personal-workboard/releases/tag/v0.3.1 。请在自己的 Windows 电脑上让 Codex 读取 README.md、AGENTS.md 与安装指南，核对该页 Windows ZIP 的 SHA-256 后完成隔离试装。数据库和报告存自己电脑；微信扫码、邮箱及其他账号授权由本人完成。安装后核验版本、待办、报告及安全重启，并说明尚未通过的真实渠道和界面验收。

发布还需使用者明确授权和可用的仓库权限。文案示例不代表已经发布、安装或向同事发送。
