# Skill 分发设计

本目录维护标准 Skill 的源文件、分发设计、构建和验证记录。仓库中的 `xiaoe-download/` 是源码模板，不是可直接安装的完整包。

## 分发约定（2026-11-13）

以下约定用于区分源码、组装目录及最终分发包。

- GitHub Release 附件作为完整、可运行 Skill 的正式获取渠道。用户下载并解压后安装，不要求克隆项目或现场构建；GitHub 自动生成的源码归档不作为可运行 Skill 包。
- `skills/xiaoe-download/` 仅维护并提交 `SKILL.md` 及手写资源，不再承诺从 Git 仓库直接复制该目录即可运行，也不保证仅拉取该目录的安装方式开箱即用。
- 全部生成内容移出源码目录：`dist/skill/xiaoe-download/` 组装完整 Skill，`dist/release/` 存放分发压缩包及校验文件，两者均不提交 Git。
- JS 入口、共享 chunk 和自动收集的第三方许可证随同一次构建一起交付；许可证模板继续提交。保持自包含运行，不增加首次运行时下载 JS 的机制。
- 从当前版本删除已跟踪生成文件并清理旧输出，不重写 Git 历史；旧提交仍保留既有产物。
- Skill 与项目共用版本号：项目版本对应 `v<版本号>` tag，附件命名为 `xiaoe-download-skill-v<版本号>.zip`，发布内容必须来自该 tag 的提交。
- 推送版本 tag 后由 GitHub Actions 按锁文件安装依赖、检查及测试、构建、解压验收，并上传附件到草稿 Release；正式发布由人工确认，不自动对外发布。
- 首版仅提供 ZIP 及 SHA-256 校验文件。ZIP 内只有一个顶层 `xiaoe-download/` 目录，不按平台分别打包，不增加自动安装器或其他压缩格式。
- Linux 执行完整检查及媒体集成回归；同一个待发布 ZIP 在 macOS、Linux、Windows 解压到含空格路径，验证包外运行、用户状态隔离及模拟扫描。全部必需验收通过后才上传到草稿 Release，不连接真实店铺或读取个人 Cookie；不据此承诺三平台全部媒体能力。
- 本次不新增项目自身许可证，不宣称未授予的开源使用权；第三方许可证声明仅覆盖对应依赖，不代替项目自身授权。
- 正式发布后禁止覆盖同版本附件，修复通过新版本发布。失败重跑仅允许补齐或替换尚未正式发布的草稿附件，并重新通过全部验收；tag 与项目版本不匹配时失败，不自动移动 tag 或删除正式 Release。

## 已确认的边界

- 交付标准 Agent Skill，不提供各 Agent 专属适配或逐个兼容性承诺。执行环境需支持读取 Skill 资源和运行本地命令。
- 采用自包含分发：下载器构建产物及必要运行依赖随 Skill 分发，运行时不依赖原项目目录，不要求用户克隆项目或现场构建。
- Skill 负责理解请求、选择参数、检查环境、调用下载器和解释结果；现有程序继续负责认证、扫描、下载、校验和恢复。
- Node.js、ffmpeg、ffprobe 和 Chrome 不随包分发。缺失时检查环境，并在获得用户许可后协助安装。
- 个人 Cookie 和其他用户状态不随包分发。首次获取或刷新登录态仍依赖用户已登录的 Chrome。
- 按 macOS、Linux、Windows 三平台设计，验证情况如实记录；设计可移植不等于已经验证通过。
- 首版覆盖目录扫描、全量下载、单课程及单资源下载、类型筛选；要求明确目标店铺，不默认使用项目中的个人店铺。此次封装不扩大已验证的接口兼容范围。
- Cookie 缓存放在系统对应的用户私有状态目录；下载内容放在用户指定并确认的目录。两者均位于 Skill 安装目录之外，执行时使用明确的绝对路径，不依赖 Agent 当前工作目录。
- 用户明确要求全量下载时可以执行；目标或范围不明确时先澄清。目录扫描也会创建缓存、锁及目录结果文件，不作为无副作用预览描述。
- 交付单元为 Release ZIP 中的 `xiaoe-download/`，内含标准 `SKILL.md`、下载器构建产物和必要运行依赖。解压后安装，无需安装项目依赖或现场编译。仅按 Git URL 拉取源码目录的安装方式不保证开箱即用。
- 更新采用替换 Skill 目录的方式，不增加自动更新或各 Agent 专属安装器；保留必要的依赖许可证声明。
- 核心验收为脱离原项目仍能运行，同时验证含空格路径、环境缺失提示、用户状态隔离和现有下载回归。三平台分别记录实际测试结果，未测试的平台明确标注。
- 真实店铺下载另行取得用户许可，不默认执行全量下载；模拟测试用于验证下载和恢复逻辑。

## 构建与结构

维护者安装项目依赖后运行 `pnpm build:skill`，在 `dist/skill/xiaoe-download/` 组装完整 Skill：复制手写资源，生成 `scripts/*.mjs` 和 `references/third-party-licenses.txt`。运行 `pnpm package:skill` 会重新构建，再生成 `dist/release/xiaoe-download-skill-v<版本号>.zip` 及同名 `.zip.sha256`。生成目录均被 Git 忽略，旧源码路径也有防止误提交的忽略规则。

构建配置仅允许 Node 内置模块作为外部导入；第三方依赖全部内联，许可证按实际参与构建的模块收集。打包仅允许 `SKILL.md`、`scripts/*.mjs` 和 `references/` 下的 Markdown/文本资源，拒绝符号链接、隐藏文件、`node_modules`、路径逃逸及缺失的必要文件；不打包整个工作区。新增其他类型资源时需显式调整白名单。ZIP 使用固定顺序、时间和文件权限；不据此承诺跨机器构建的字节级可重复性。

每次 Skill 构建清理整个 `dist/skill/`，每次打包清理 `dist/release/`，避免旧 chunk 或旧版本残留。CLI 构建仅清理 `dist/` 根级 `.mjs` 和源码映射，不删除 Skill 子目录。修改源码后须重新生成分发包。

Puppeteer 包同时包含浏览器下载和安装能力，其可选代理及 ZIP 解压依赖不属于本项目的 Chrome 连接路径。分发构建将这些安装分支替换为明确的“不支持自动安装 Chrome”错误，避免引入不必要的原生模块；现有 WebSocket 连接通过独立副本的模拟握手测试验证。发布包缺失的 Apache-2.0 标准文本及 boolbase 许可证保存在 `scripts/license-templates/`，构建同时收集源文件内嵌许可声明。

`src/skill.ts` 是 Skill 的运行入口，`src/skill-environment.ts` 负责工具检查和跨平台用户状态目录。`--doctor` 检查但不写目录，`--prepare` 在用户确认后准备目录；下载命令自动复核必要工具。软件安装和浏览器登录由 `SKILL.md` 引导 Agent 在获得许可后协助完成，不由程序静默安装。

独立 CLI 也要求明确指定命令和店铺；其原有相对输出及自定义缓存选项仍保留。Skill 入口要求绝对输出目录并使用包外用户缓存，避免依赖 Agent 的工作目录。

## 验证

- `pnpm check`：格式、lint、类型、单元测试、CLI 构建及 Skill 构建打包。
- `pnpm test:e2e`：重新构建及打包后执行本地媒体/文档回归，以及对最终 ZIP 校验、解压到包外含空格临时路径后的检查、准备、模拟店铺扫描和 WebSocket 握手。
- `pnpm test:skill-package`：不重新构建，仅验收 `dist/release/` 中唯一的 ZIP 和对应校验文件；可用 `SKILL_RELEASE_DIR` 指定待验收附件目录。CI 三平台使用同一份构建附件。
- 平台状态目录选择由单元测试覆盖；实际平台运行情况在完成验证后记录。跨平台设计不等于三平台测试通过。

2026-11-12 验证：macOS / Node.js 24.17.0 下 `pnpm check` 通过（24 个单元测试），`pnpm test:e2e` 通过（3 个集成测试），Skill 元信息校验通过。独立副本检查、含空格路径、包外目录准备、默认 doctor 不因环境变量联网、模拟店铺扫描和模拟 WebSocket 握手均已验证。Linux、Windows 尚未实际运行，Windows ACL 行为仍需对应平台验收。独立行为验证还确认未获目录、范围及浏览器授权时应停止，不进入下载流程。

2026-11-13 分发改造验证：macOS / Node.js 24.17.0 下 `pnpm check` 通过（30 个单元测试），`pnpm test:e2e` 通过（3 个集成测试）。新增打包边界、确定性、版本匹配、草稿重试及正式版本拒绝覆盖测试；最终 ZIP 的校验、含空格路径解压和独立运行通过。系统 `unzip` 解压后 `--doctor` 通过，CLI 重建保留组装目录及 ZIP 内容已验证；Release 工作流通过 actionlint 静态检查。尚未推送 tag、执行远端工作流或创建 Release，Linux、Windows 的新包实际运行仍待 CI 验收，不能将矩阵配置视为已验证通过。

真实店铺下载不属于自动验证，不读取用户现有 Cookie，也不连接现有 Chrome。

## 发布与安装

维护者修改 `package.json` 的稳定三段版本号并提交，再推送对应 `v<版本号>` tag。`.github/workflows/release-skill.yml` 在该 tag 的提交上构建，按锁文件安装依赖，并执行 Linux 完整回归及同一 ZIP 的三平台冒烟测试。全部必需测试通过后，使用 `pnpm release:skill` 创建或更新草稿 Release，不自动正式发布。失败时可重跑该 tag 的工作流；正式 Release 已存在则拒绝覆盖，修复必须使用新版本。

`pnpm release:skill` 只用于维护者发布经过验收的附件，不执行构建或测试。必须设置 `RELEASE_TAG`、`GITHUB_REPOSITORY` 并具备 GitHub 认证；它核对版本、附件校验和、本地 tag 对应的 HEAD 及远端 tag 对象，拒绝 tag 漂移。通常应交由工作流调用，而不是上传本地任意产物。草稿仅含 ZIP 和 SHA-256 校验文件；人工确认附件、验收结果及说明后正式发布，不自动移动 tag 或删除 Release。正式发布前确认本次工作流已经结束，不在草稿重跑上传期间并发发布。

用户从 [GitHub Releases](https://github.com/HakurouKen/xiaoe-download/releases) 选择明确版本，下载 `xiaoe-download-skill-v<版本号>.zip` 及 `.zip.sha256`。不要下载自动生成的 Source code 归档作为安装包。先核对 SHA-256，再使用系统 ZIP 解压工具，将完整的 `xiaoe-download/` 放入所用 Agent 的 Skill 目录。无需安装 `gh`；若已安装，也可使用 `gh release download v<版本号> --repo HakurouKen/xiaoe-download --pattern 'xiaoe-download-skill-v<版本号>.zip*'`。

SHA-256 用于检测文件损坏及附件配对错误，不是独立的签名或来源认证。升级前停止旧任务，再替换整个 Skill 目录，不能只替换 JS 入口；包外用户状态及下载目录保留。Node.js 24、ffmpeg、ffprobe 和 Chrome 仍由用户环境提供。仓库目前未授予项目自身的开源许可证，第三方许可证声明不代替项目代码的修改或再分发授权。
