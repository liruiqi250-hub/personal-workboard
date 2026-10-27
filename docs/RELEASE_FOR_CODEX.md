# 维护、升级与公开发版 V1.10.1

> **V0.3.7 版本说明（开发预览通道）：** 本版提供页面与后台版本差异提示和未保存内容保护、每秒北京时间时钟、可选天气与一次定位、已配置来源的立即整理、默认全部状态看板，以及邮箱／钉钉配置入口；公开说明同步实际发行状态。实际公开状态、资产校验值和本版验收结果以[GitHub发行记录](https://github.com/liruiqi250-hub/personal-workboard/releases)为准。

> **已发布基线：** [V0.3.6](https://github.com/liruiqi250-hub/personal-workboard/releases/tag/v0.3.6) 已作为 Pre-release 公开，非正式 latest。V0.3.6 的程序、数据回退快照、标签与发行资产保留；旧包内的候选措辞属于冻结时点的历史说明。

> 本版文件名为 `personal-workboard-0.3.7-windows-x64.zip` 和 `personal-workboard-0.3.7-public-source.zip`。下载前从发行列表核对实际存在的 `v0.3.7`、文件大小、SHA-256 及预览状态；不从文件名或本文推断网络资产已经存在。

V0.3.7沿用V0.3.3已通过独立复核的维护实现；完整故障矩阵为V0.3.3历史证据，V0.3.6未重跑该矩阵，本版也不能未经实测声称覆盖，UPD-RECOVERY-01在新维护入口及已验路径内关闭，旧版冻结维护算法仍有缺口；离线测试与本机部署不代表真实渠道或真人界面验收通过。

本文件对应 V0.3.7 开发预览；每次变更都递增 `package.json`、锁文件中的版本，更新 README 与 CHANGELOG，保留上一程序及对应数据。真实目标仓库为 https://github.com/liruiqi250-hub/personal-workboard 。[v0.3.1](https://github.com/liruiqi250-hub/personal-workboard/releases/tag/v0.3.1) 已作为 Pre-release 发布，非正式 latest；V0.3.2 已按 Pre-release 发布、非正式 latest，并披露 UPD-RECOVERY-01 更新恢复缺口；其tag和原资产保留。V0.3.3 和 V0.3.6 此前已作为 Pre-release 公开、非正式 latest；各自实际资产与校验值见各自发行页，整体业务仍未验收。发布由维护者统一协调，开发阶段准备干净 stage、版本 ZIP 和明确文件清单，避免并发 push 或创建 Release。

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

V0.3.2 起默认使用 `sourceMode=project-default`，内置本项目 owner/repo 与 Ed25519 公钥，员工不需要配置签名材料。`public/update-trust.json` 与 `dist/update-trust.json` 必须字节一致，keyId 为公钥 SPKI DER 的 SHA-256。当前指纹为 `SHA256:65b116f1c4d1c91be3a108ed51051b29683d69654fed638065f8e9a30d7edebd`。原有明确自定义仓库或非空公钥保留为 `custom`；无效自定义配置显示错误，不能静默变成项目默认来源。

`stable` 查询正式 latest，并拒绝 draft/prerelease。`preview` 要求明确固定 tag，且实际 Release 必须为 Pre-release；普通主服务只验签下载，安装需显式隔离测试模式。任何通道都不允许同版或降级安装。没有正式 Release 时不把预览或“最新标签”当成正式更新。

程序先验证固定协议的 Ed25519 签名，再绑定 owner/repo/channel/version/tag/assetName/platform/URL/SHA-256/bytes/keyId/sequence/createdAt，实际 GitHub Release 和资产也必须一致。ZIP 限 400 MiB，受控 GitHub HTTPS 重定向且有大小/超时上限。持久账本按来源、通道和公钥记录序号与一次性安装票据；安装准备占用票据、重读文件、备份、再次核对后消费。已消费或中断的票据不能自动重放。仅备份阶段明确失败时，需使用者显式重新下载核验后申请新票据，失败记录保留。

### V0.3.7 事务维护与首次迁移（沿用V0.3.3机制）

手动维护从可信发行/交接记录取得完整 Windows ZIP 和真实 SHA-256，命令行的 ExpectedVersion 与包内版本在停服前核对。它不替代程序入口的签名验证、预览隔离和持久一次性票据。首次从 V0.3.2 迁移必须使用独立的新可信V0.3.7完整工具目录，旧客户端调用旧 update.ps1 并不能获得新恢复机制。

在新工具目录运行；以下变量为已核对的旧目录/端口、新包与可信SHA，完整采集步骤见 [INSTALL_FOR_CODEX.md](INSTALL_FOR_CODEX.md#v037-首次迁移与旧失败记录恢复)：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintenance.ps1 -Action Update -ProgramDir $oldProgram -DataDir $oldData -Port $oldPort -PackagePath $newZip -ExpectedSha256 $newSha256 -ExpectedVersion 0.3.7
```

V0.3.3 的 update.ps1/rollback.ps1 为新 maintenance.ps1 的包装入口。外壳把可信 Node 和两个维护模块复制到程序条目之外的 runner，并核对副本哈希，避免替换仍在执行的 runtime/脚本。先核 ZIP/hash/清单和版本，再核对实例并安全停服。任何破坏性替换前，旧程序必须匹配完整原清单，完整旧程序与数据快照复制并逐文件验证；源码 checkout 或没有有效原 release-manifest 的目录会拒绝，需要受控部署完整 Windows 包并核对原数据后再切换。

事务使用写前意图和完整快照，不依赖“目录Move成功后才追加moved”的旧成功列表。程序按文件保留到独立证据区，再从保留的目标发行暂存复制、验证并替换；旧快照和目标发行暂存不消费。当前未知代码、额外程序文件、链接、缺失原件或绑定冲突会拒绝并保留现场。部分操作完成或进程在动作与记账之间中断时，重试依据是完整快照和已知哈希，而不是猜测某个after标志。

### 回退与回退再失败

使用回执中的 schema2 previousDir，保持同一 ProgramDir/DataDir/Port：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintenance.ps1 -Action Rollback -ProgramDir $oldProgram -DataDir $oldData -Port $oldPort -PreviousDir $transactionPrevious
```

首次回退先完整保存当前程序及数据并密封哈希，后续重试复用该首次快照，不能用半恢复状态覆盖它。恢复旧程序及绑定数据库/凭据时，每项检查意图、当前位置和哈希；已是目标旧哈希可跳过，未知冲突拒绝。回退前新任务保存在可读取的首次 before-rollback 数据副本；当前界面会回到旧数据库状态，报告原件不删除。因明确文件占用而中断时，释放该占用后用同一事务重试，不递归清空现场或根据旧PID强杀未知进程。

业务核对必须先将完整密封快照复制到独立临时目录，再对副本连接 SQLite。只读 SQLite 连接仍可能创建 `-wal`、`-shm`，直接打开原快照会改变文件集合并使后续 seal 核验拒绝。原快照只做逐文件哈希核对；不要改清单或忽略未知辅助文件来强行继续。

### 兼容旧 needs-rollback

保留旧现场，从新可信工具目录运行 RecoverLegacy，提供旧 previousDir、当时失败目标的原部署 ZIP 和可信 SHA。外壳先核 ZIP SHA 并要求等于旧 metadata.packageSha256，再调用旧记录组合模块。其完整旧 manifest 必须与 fromVersion 相符；每个旧文件在 saved/live 中找到正确原件后，才组合成新、完整、可验证的旧快照。旧 moved/installed 只验证结构，不能证明目录完整。已知新文件由核验过的目标发行包证明；缺失、未知修改、同版manifest字节冲突或绑定错误均拒绝。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintenance.ps1 -Action RecoverLegacy -ProgramDir $oldProgram -DataDir $oldData -Port $oldPort -PreviousDir $legacyPrevious -PackagePath $failedZip -ExpectedSha256 $failedSha256
```

原现场、旧metadata和旧快照不被导入步骤改写；新导入目录非空时拒绝覆盖。导入成功后如果回退再次失败，按回执中新 schema2 previousDir 使用 Rollback重试，保留首次回退前状态。V0.3.3历史验收中，总控使用该最终冻结ZIP覆盖真实目录内占用、动作/记账间中断、回退失败重试、旧3.2外部首次迁移及旧分裂现场恢复，UPD-RECOVERY-01在新维护入口和已验路径内关闭；旧客户端自动升级、正式stable及真实业务仍待验。

### 模式、数据与验证边界

维护保持已核对活服务的预览模式，显式预览安装测试仍要求非默认数据目录与非18327端口；普通启动剥离继承测试标志。MaintenanceTest仅用于显式TEMP隔离故障演练，不能通过继承环境在生产开启。NoStart只完成离线阶段，还要实际启动检查health/版本/模式与主要功能。回执completed或health正常均不能替代任务/设置/报告的完整核对。

日志、凭据正文、数据库及这些包含本机路径的事务记录不能进入公开包。完整数据快照中的报告副本与软件设置到数据目录之外的报告原件分别保管；后者仍在原位置，不由程序回退删除。正式发布、真实渠道、跨日发送和真人界面验收仍分别登记。

## 维护者签名与密钥轮换

签名工具只绑定 `liruiqi250-hub/personal-workboard`，不会上传或发布。维护者在自己的 Windows 用户下显式操作；员工部署和普通启动不调用 `init`。真实私钥只存在项目外的当前用户 DPAPI 封套，默认目录为 `%LOCALAPPDATA%\PersonalWorkboardPublisher\liruiqi250-hub\personal-workboard`。封套不能纳入代码、ZIP、日志、诊断或发给员工；不可借用其他项目的发布密钥。

在程序根目录运行：

```powershell
node .\scripts\sign-update.cjs init
node .\scripts\sign-update.cjs public
```

`init` 首次创建密钥，重复执行核对已有封套，不轮换或覆盖；`public` 只输出公钥、keyId 和指纹。工具不提供明文私钥导入/导出。可用 `--key-dir` 明确选择项目外本机盘符绝对目录；目录或祖先为链接、位于项目内或为设备/UNC 等别名时拒绝。

先完成部署包冻结、适合本次变更的独立启动与维护核验，再签实际 ZIP。已发布 V0.3.6 的 preview sequence=4；执行前必须再次核对同公钥、同通道的实际最高序号，使用严格更大的新序号。下面是本版的显式签名命令，输出不会自动发布：

```powershell
$zip = (Resolve-Path '.\release\personal-workboard-0.3.7-windows-x64.zip').Path
$signingOutput = Join-Path (Get-Location).Path 'release-metadata\v0.3.7-preview'
$previewSequence = [int](Read-Host '已核对的新预览序号，须高于同公钥已发布最高值')
node .\scripts\sign-update.cjs sign --zip $zip --version 0.3.7 --tag v0.3.7 --channel preview --sequence $previewSequence --output-dir $signingOutput
```

工具核对 ZIP 包内项目名称、版本、部署类型与平台，再计算实际大小/hash并签名，输出 `update-manifest.json`。签名后不能改 ZIP；相同输出文件只有完全相同时才允许复用，不覆盖不同内容。每个 owner/repo/channel/keyId 范围内维护严格递增的正整数 sequence，不能重签旧序号冒充新发布；正式与预览通道分别记账。上传前逐项复核清单与 ZIP 的版本、tag、通道、资产名、字节数和 hash，上传由维护者统一协调。

现有 V0.3.1 Pre-release 已追加独立 `update-manifest.json`：734 字节，SHA-256 `64777b758294f0d8ea29fccc3731a38f4174225d0d086463e7acf53036626b9f`，preview 通道 sequence=1。原 Windows ZIP 保持 45,476,907 字节，SHA-256 `e3ffcfd818260a1f384ae5ea73ad70f703ed2a9e417a0a77c9581ad7416960eb`。追加清单不修改原包、不把它改成正式 latest，也不使旧客户端自动具备新公钥。验签下载、实际安装、重启和回退各自需真实证据。

已发布 V0.3.2 的 preview sequence=2，Windows ZIP为45,521,036字节，SHA-256为455ea75b8f19113348cca122d9fc56205695a90446ebec93bd61bbcbd1634f59；734字节update-manifest.json的SHA-256为2dd6c7255c4c4ff38b0ddd674de2814d02e3272ea05543f499fdf75846eeff21。该包和tag保留；其旧算法缺口不会因新版本文档而消失。

轮换时先发布由旧可信密钥签名、包内带新公钥和指纹的过渡版本，确认过渡安排后再用新密钥签发后续版本；当前程序只信任所选公钥，不实现网络下载后自动信任另一把 key。没有收到可信过渡版本的用户，通过核对发行者、文件和校验值的可信安装流程恢复。自定义来源由使用者明确更新，不能自动覆盖。DPAPI 绑定当前 Windows 用户，换账户/换机不能假定旧封套可用；不要临时生成新 key 后继续声称与原指纹相同。

## 试装转发文案

转发前从 GitHub 实际发行记录核对 V0.3.7 的公开状态、文件和 SHA-256。V0.3.2 已披露 UPD-RECOVERY-01，不向已有数据实例转发旧原地升级指令。以下为预览试装文案模板，不表示整体验收：

> 先在GitHub发行列表确认v0.3.7确已作为Pre-release公开；不存在该发行时保持未取得材料状态。确认后让Codex从 https://github.com/liruiqi250-hub/personal-workboard 的v0.3.7标签读取README、AGENTS和安装指南，下载Windows部署ZIP并核对SHA-256 （从对应发行资产校验文件核对）。全新本机试装和已有数据实例升级分别核对；旧3.2首次迁移使用独立可信新工具的maintenance外部入口，旧失败现场按RecoverLegacy核对。本人完成账号授权，定时/跨日/其它业务另行验收。



发布还需使用者明确授权和可用的仓库权限。文案示例不代表已经发布、安装或向同事发送。

## V0.3.7 本次发行范围

Windows ZIP 冻结后保持原件，公开源码与部署程序文件须逐 hash 核对；README、AGENTS、安装／发版指南和 CHANGELOG 五份公开说明应同步实际发行事实和限定验收范围。V0.3.6 原资产及其中冻结时点的候选措辞保留为历史，本版明确其已公开状态。手动维护的目标版本应明确为0.3.7；从旧3.2首次迁移仍须独立可信完整新工具，不能使用旧脚本。签名清单的实际通道、严格递增序号、字节数和SHA以本次update-manifest.json为准，不重用旧示例的序号。

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

## V0.3.6 已发布基线校验值

[V0.3.6 发行页](https://github.com/liruiqi250-hub/personal-workboard/releases/tag/v0.3.6) 已公开为 Pre-release、非正式 latest。Windows ZIP 为 45,582,227 字节，SHA-256 `3911daf76a1a9a38cfaaa7b0ae3a3be1c7c292c16cb3dfad421e40f3497f461a`；干净源码 ZIP 为 413,141 字节，SHA-256 `a22622937211f819198d22d5dc6d9ea01502e659b51ae96eabc698d2cb695e76`。这些是 V0.3.6 的历史校验值，不能用于校验 V0.3.7。旧标签、原资产与对应回退资料不覆盖。


## V0.3.7 新增使用入口

- **北京时间时钟**：顶部显示完整年月日、星期和时分秒，每秒更新，按 Asia/Shanghai 显示；它使用电脑当前时间，不替代操作系统校时。
- **天气与位置**：天气默认关闭，联网条款同意默认未勾选。打开顶部天气设置，本人阅读条款并同意后，可启用天气；首次默认采用一次浏览器精确定位方式，权限仍由本人按浏览器正常流程选择。拒绝、失败或超时均可改选城市／区县。只保存最后选择的位置，不持续定位、不保存轨迹。
- **立即整理**：在任务页启动本轮整理，仅使用已启用来源及其已保存的范围、凭据和授权配置，复用原有同步与去重流程，不扩大到未选账号、群或文件夹。逐来源展示等待、正在整理、成功、跳过或失败及实际数量；可请求取消，已入库记录保留。整轮结束不等于每个来源都成功，要逐项核对。此入口不生成日报，也不发送微信。
- **默认看板**：首页进入全部状态的看板，包含已完成列；今天要做仍保留日期范围，全部任务页可核对更完整的任务集合。
- **邮箱与钉钉**：从“我的设置 → 消息来源配置”进入同一份来源表单；不在设置页另存一套账号。一条邮箱来源只读取一个邮件文件夹，保存范围与实际读取一致，SSL/TLS 固定开启。钉钉表单提供本机工具检测、官方工具准备和程序路径填入入口，准备工具不等于企业已授权。

天气的城市／区县名称使用随程序提供的 GeoNames 中国地名索引在本机搜索，共 5,722 条，来源日期为 2026-10-27；索引包含筛选后的省市区县等候选地名，不代表最新行政边界或全国全覆盖，重名时请核对省市。搜索文字不发送给第三方。开启天气后，仅把选定经纬度作为位置参数发送至固定 HTTPS 的 MET Norway 接口，坐标最多保留四位小数；请求带程序标识，并按接口缓存规则复用预报。天气显示为数值预报，不是气象站现场实测；失败或使用旧缓存会显示对应状态和时间。

[MET Norway](https://www.met.no/) 预报和 [GeoNames](https://www.geonames.org/) 地名数据均按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 归因。GeoNames 原始 CN.zip 来源、下载日期、筛选说明和索引 SHA-256 保存在随包的 `public/china-places-meta.json`，数据在 `public/china-places.json`。

## V0.3.7 扩展范围的打包与验收

本版公开范围还包括北京时间时钟、天气与本机地名索引、来源立即整理、首页全部状态默认及邮箱／钉钉唯一配置入口。打包需包含 `public/china-places.json` 与 `public/china-places-meta.json`，核对索引数量、SHA-256、GeoNames 官方 CN.zip 来源和 CC BY 4.0 归因；不能把个人保存的位置或天气设置写进公开文件。天气数据的 MET Norway 归因在界面保留，按需下载的 DWS 原生程序与其 Apache-2.0 LICENSE／NOTICE 留在用户独立工具目录，不把企业登录态或账号配置纳入包。

客户端跨后台版本提示的旧验收、V0.3.6 的历史 279 项测试，或本版早期某个局部测试数量，均不代表新增天气、整理、入口和钉钉工具的完整范围已通过。冻结前分别核对：时钟每秒北京时间显示；默认天气关闭与授权门；拒绝定位后的手选路径；失败／缓存预报和归因；立即整理的逐来源实际状态、取消和去重；默认已完成列；配置入口唯一表单与未保存保护。实际浏览器检查使用隔离合成资料，不能代替本人接受定位权限或企业授权。

真实北京公开中心天气样例和 DWS 无账号准备的技术回执已记录，二者分别不代表本人位置、实时气象站观测、企业账号接入或群消息读取。新的本机测试、部署和浏览器结果完成后，按最终冻结包在发行页报告精确范围；测试计划、代码存在或接口 accepted 都不能代替通过回执。

## 阿里企业邮默认配置

新建邮箱来源默认预填 `imap.qiye.aliyun.com`、端口 `993`、SSL/TLS 和单一文件夹 `INBOX`；已保存配置保留，其他邮箱可手动修改服务器。本人填写完整邮箱地址与三方客户端安全密码，管理员需已允许第三方客户端和 IMAP。密码不回填、不进入浏览器持久存储。参见[阿里邮箱官方服务器说明](https://help.aliyun.com/zh/document_detail/36576.html)与[三方客户端安全密码](https://help.aliyun.com/zh/document_detail/444269.html)。默认参数不代表账号已经接入，不代为登录或读取邮件。
