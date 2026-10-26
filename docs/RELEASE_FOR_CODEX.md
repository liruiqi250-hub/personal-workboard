# 维护、升级与公开发版 V1.1.0

当前为 V0.3.1 开发预览；离线测试与本机部署不代表真实渠道接入通过。

软件当前 V0.3.1；每次变更都递增 `package.json`、锁文件中的版本，更新 README 与 CHANGELOG，保留上一程序及对应数据。真实目标仓库为 https://github.com/liruiqi250-hub/personal-workboard 。本次维护者将 v0.3.1 按开发预览发布，实际远端状态以对应标签与发行资产为准；正式签名更新尚未就绪。发布由维护者统一协调，开发阶段准备干净 stage、版本 ZIP 和明确文件清单，避免并发 push 或创建 Release。

## 构建公开部署包

前端构建会按最终 chunk 收集实际包版本及 Vite/Rolldown 注入的运行时代码，生成完整第三方原件、汇总及许可 manifest 到 `public` 和 `dist`。缺少完整许可原件或遇到未知有输出的虚拟模块时停止，不用链接或手写许可摘要替代。固定官方精确版本的缺件原件在 `public/third-party-license-sources/`，原件 SHA 与来源记录随包保留；不可把其他版本许可替换进来。

发行验证器检查两份声明完整且字节一致，删除汇总、遗漏实际依赖条目或缺少原件即使重算外层发行清单也会拒绝。`Get-BoardProgramEntries` 中的 `public`、`dist` 是整体升级与回退项，包含这些声明；不能只搬 JS bundle。Node 与后端原件继续保留。项目整体 LICENSE 由维护者另行决定，本流程不代选。

先完成适合本次变更的测试、构建和独立目录启动。Windows 上使用 Node 24+：

```powershell
npm ci
npm test
npm run build
node .\scripts\package.cjs
```

默认生成含 `dist` 和生产 `node_modules` 的部署包。打包器在 `work/package` 下的独立副本按锁文件执行 `npm ci --omit=dev --ignore-scripts`，不删除开发目录依赖。可选 `--with-node-runtime` 将当前 Windows x64 Node 可执行文件及完整 LICENSE 加入包。许可证优先取 Node 安装目录的 `LICENSE` 或 `LICENSE.txt`；缺失时从 `raw.githubusercontent.com/nodejs/node` 对应当前 Node 版本的官方 tag 获取，限时 30 秒，并核对 Node 标题与 MIT 许可段。取得失败或内容不符则拒绝分发，不修改 Node 安装目录。`--source-only` 生成需在目标机安装依赖的源码包，不可用于直接自动升级。运行打包器不会发布 GitHub。

输出位于程序目录 `release/`：ZIP、`.zip.sha256`。ZIP 内有 `release-manifest.json`，登记每个公开文件的相对路径和 SHA-256；不包含机器路径。相同版本同类型的 ZIP 已存在时拒绝覆盖，要求先递增版本。`validate-package.cjs` 会核对清单、版本、链接和额外文件。

已通过公开白名单和清单验证的干净 stage 保留在 `work/package`，可供之后筹备公开源码提交。随包附带的 `.gitignore` 忽略内部监督、计划、验证、需求资料、工作目录、上一程序/更新暂存和 vendor 运行时；公开 Git 提交仍应从干净 stage 审查，不能对原始工作目录直接 `git add .`。本机已跟踪的内部文件不会因新增 ignore 自动解除跟踪，公开前仍要检查实际拟提交清单。

只允许公开根文件、`dist`、`server`、`scripts`、`src`、`public`、生产 `node_modules`、可选 `vendor/node`，以及本目录中的两份安装/发版指南。不得打包 `docs/oversight`、内部 specs/plans/verification、`work`、真实数据库、密钥、私有配置、`.env`、日志、service 元数据、聊天标识、个人绝对路径或原始账号资料。绝不直接压缩整个工作目录。白名单和文本扫描只是辅助，仍需检查最终 ZIP 文件列表与独立解压启动。

## 更新到另一版本

让使用者从可信发行记录取得新 ZIP 和真实 SHA-256。程序内的自动检查在 owner/repo/publicKey 未配置时保持待配置；命令行更新走 HTTPS 资产下载、ZIP SHA-256 和内部文件清单校验。

本地已下载包：

```powershell
.\scripts\update.ps1 -PackagePath (Resolve-Path '.\新版本部署包.zip').Path -ExpectedSha256 '填写发行记录中的64位SHA256'
```

也可传入使用者已核实的真实 `-Repository owner/repo -Tag v版本 -AssetName 资产.zip -ExpectedSha256 校验值`，脚本仅构造 `https://github.com/.../releases/download/...`。这些是参数说明，不是真实仓库。HTTP 下载和缺少校验值均不支持。

脚本先在 `.workboard-updates` 验证包，再核对本机实例并通过 `service.stop` 停服。独立数据目录的 `backups/before-update-*` 保存数据库、凭据及数据目录内的报告等文件；日志、打印临时文件和已有 backups 不重复复制。自定义到数据目录之外的报告原件仍由原位置保管，升级不覆盖它们。

上一程序存于 `.workboard-previous/时间-标识/program`，`update-metadata.json` 将旧/新版本、端口、独立数据目录、包校验值和对应快照绑定。此目录包含本机路径，只留本地，不能加入公共包。替换失败会保留已移动文件与进度，并输出指定回退命令；它不会谎报更新完成。正常更新后核对新版本健康与主要功能。

## 回退时匹配数据库

使用更新脚本输出的上一版本目录：

```powershell
.\scripts\rollback.ps1 -PreviousDir (Resolve-Path '.\.workboard-previous\实际目录名').Path
```

自定义部署要补上原来的 `-DataDir` 和 `-Port`。脚本拒绝目录/端口不符或快照缺失的回退；先停服，保留回退前程序及完整数据快照，再恢复上一程序和升级前匹配的数据库、凭据。升级后新增任务会留在“回退前”快照中，当前界面退回升级前状态；报告文件不删除。不要只放回一个旧 JS/EXE 后宣称回退成功，也不要递归清空用户数据。

独立演练时可使用所有脚本的 `-DataDir`、`-Port`、部署的 `-SkipInstall` 和升级/回退的 `-NoStart`。验收不得使用真实用户数据库。静态解析通过只能证明脚本语法可解析，仍需核验下载、校验失败保护、端口冲突、重复启动、安全停服、更新和回退的实际行为。

## 正式转发文案

待维护者填写并核验真实公开仓库及已发布版本后，才能发送链接。建议文案：

> 这是个人待办事项看板的正式仓库与已验发行版（填写真实链接、版本和 SHA-256）。请在自己的电脑上让 Codex 读取 README.md 与 AGENTS.md，核验部署 ZIP 后完成本机安装。数据库和报告存自己电脑；微信扫码、邮箱及其他账号授权由本人完成。安装后请核验健康接口、待办和报告，并说明尚未接入的来源。

发布还需使用者明确授权和可用的仓库权限。文案示例不代表已经发布、安装或向同事发送。
