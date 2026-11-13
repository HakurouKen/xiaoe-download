# 小鹅通已购课程下载器

Node.js + TypeScript 实现。优先使用本地 Cookie 缓存；缓存不可用时通过 `puppeteer-core` 连接现有已登录 Chrome，获取当前店铺登录态后立即断开。购买记录、课程目录、播放接口及媒体均使用原生 `fetch`；HTML 使用 `cheerio` 解析。

购买页的内容由懒加载 API 提供，HTML 本身没有完整目录：程序按 `lastId` 分页到空页，再递归请求课程章节和子课程，按目录总数翻页。视频、音频、直播回放、图文和文档分别适配其实际接口。

## 安装与运行

要求 Node.js 24、pnpm 10，以及 PATH 中的 `ffmpeg`、`ffprobe`。

```sh
pnpm install
pnpm build
```

首次获取或刷新登录态时，在当前 Chrome 中打开 `chrome://inspect/#remote-debugging`，开启远程调试并打开已登录店铺页面，在提示时允许连接。获取后立即断开，不关闭或重启 Chrome。缓存有效时无需 Chrome 正在运行。

```sh
# 明确指定目标店铺购买记录 URL；下面的变量为示例，请替换
STORE_URL='https://你的店铺/p/t/v1/ecommerce/pay_record/record'

# 下载全部已购课程
pnpm start all --url "$STORE_URL"

# 忽略缓存，从 Chrome 重新获取登录态
pnpm start all --url "$STORE_URL" --refresh-cookie

# 自定义 Cookie 缓存路径
pnpm start all --url "$STORE_URL" --cookie-cache .cache/my-store.json

# 只扫描完整目录并创建图文、文档占位
pnpm start all --url "$STORE_URL" --catalog-only

# 下载单个课程 / 单个资源，接受 ID 或同店铺 URL
pnpm start course course_示例 --url "$STORE_URL"
pnpm start media a_示例 --url "$STORE_URL"

# 仅下载图文和文档，升级已有占位，跳过其他类型
pnpm start all --url "$STORE_URL" --kinds text,document

# 仅保存目录，不创建占位或下载内容
pnpm start list --url "$STORE_URL"

pnpm start --help
```

默认 CDP 地址为 `ws://127.0.0.1:9222/devtools/browser`。也可指定 `--cdp` 或环境变量 `XIAOE_CDP_URL`，支持有 `/json/version` 的 HTTP 调试地址。`--url` 指定其他购买记录页；`--output` 指定输出位置；`--kinds` 按逗号分隔的类型筛选下载目标，仍使用完整目录编号；`--concurrency` 设置 HLS 分片并发（默认 6）；`--ffmpeg`、`--ffprobe` 可指定程序路径。

## 登录态缓存

默认缓存为 `.cache/cookies/<店铺摘要>.json`，按店铺源隔离，保存 Cookie 的域、路径、HTTPS 限制、到期时间和 User-Agent。文件权限为 `0600`，默认缓存目录已加入 `.gitignore`，格式化和 lint 也会跳过它。Cookie 只发送到匹配的域和路径，过期值不发送，缓存不保存到课程清单。

缓存缺失、损坏、店铺不匹配或全部 Cookie 过期时重新获取。缓存中的会话 Cookie 没有浏览器提供的固定到期时间，因此以服务端响应判断失效。HTTP 401/403、明确的“请先登录”等业务错误和登录页触发自动刷新，再重试原请求。本次运行最多进行一次认证失败刷新，并发失败共享这次获取；刷新后仍失败则记录错误，避免反复连接。普通网络错误、课程过期和接口格式变化不会触发刷新。

媒体分片的认证失败使用同一个刷新机制，刷新时短暂连接 Chrome，获取完成后再次立即断开。下载期间不持有浏览器连接。

## 输出和恢复

每门课程一个标题文件夹，内容首次下载即按网页完整目录顺序添加编号，例如 `01-什么是自我认知与自我觉察.mp3`。每门课程从 `01-` 开始，序号至少两位；单资源下载和仅创建占位也使用完整目录中的原序号，失败或未下载的资源保留序号空位。多段直播回放共用内容序号，追加 `（回放1）` 等片段标记。

`filenamify` 将非法字符替换为空格；同名内容追加稳定 ID 摘要。图文保存为 `<序号>-<标题>.html`，原图保存为同标题的 `（图片01）` 等文件，HTML 内链接改为相对本地路径。支持普通、懒加载、响应式和背景图片，重复图片只下载一次；正文中的文档附件也下载到本地。两篇真实图文都由图片承载，原图属于完整正文。

文档保存为 `<序号>-<标题>.<原扩展名>`，下载原文件而非封面或预览。已验证当前店铺 22 个 PDF；校验下载长度及 PDF 头尾，也支持 Office、ZIP 容器、RTF 与 UTF-8 文本的格式校验。图文全文与文档下载均先确认权限，不将试看字段当作正文。签名富文本根据一方客户端解析正文线路和素材 ID；这条分支由模拟响应验证，当前店铺的两篇图文无需签名。包含嵌入音视频或外部预览的图文会明确失败，避免将不完整页面标记为离线完成。

`catalog.json` 保存扫描目录；`summary.json` 保存本次结果；各课程的 `.xiaoe-manifest.json` 保存资源状态和文件大小，不包含 Cookie 或播放签名。单资源下载保留其他清单记录。默认下载会将已有图文、文档占位升级为实体内容；`--catalog-only` 仍只创建占位。升级失败保留占位，仅在实体文件和清单保存成功后移除空占位。重跑跳过大小匹配的已完成文件；清单中损坏或截断的旧文件保留为 `.incomplete-时间戳` 后缀，再重新下载。恢复单位为完整资源，失败的 HLS 分片不会持久缓存。图文和文档成组暂存并校验后发布，隐藏的 `.xiaoe-artifact-*.json` 只记录文件名、大小和暂存目录；清单持久保存后清理。发布过程中断后，完整文件直接恢复，部分发布只回收该任务创建的文件，再重新下载。

媒体先下载到临时目录，HLS 分片及标准 AES-128 密钥本地化后交给 ffmpeg 无损合并，再由 ffprobe 检查流类型和时长。完成前不会发布最终媒体。未知同名文件不会覆盖；失败单独记录，其他课程继续处理，任何失败使程序退出码为 1。

同一输出目录只允许运行一个任务。异常中断后，如 `.xiaoe.lock` 仍存在，确认旧进程已经停止再删除该锁。不要删除正在运行任务的锁。

未授权或过期课程、空目录、未结束直播、未生成回放和不支持的 DRM 格式会明确报错。本次真实扫描发现 22 门已购课程，其中一门目录为空，一门已过期；这些不会算作下载成功。

## 复用与验证

`src/catalog.ts` 封装购买记录解析和完整内容发现；`src/media-source.ts` 封装播放地址解析；`src/content-source.ts` 封装全文、签名素材与原文档解析；`src/artifacts.ts` 封装离线图文和文档下载；`src/downloader.ts` 提供 `downloadMedia`、`downloadContent`、`downloadCourse`，独立于 CLI 和浏览器。

```sh
pnpm check
pnpm test:e2e
```

单元测试覆盖递归分页、文件名冲突、媒体及签名图文解析、全文权限、文档下载权限、Cookie 缓存、域和路径限制、认证刷新并发去重及浏览器断开。集成测试通过真实 ffmpeg 生成音频和 AES-128 HLS，验证媒体下载、编号、占位升级、原图及附件本地化、原文档下载、错误响应拒绝、跳过、损坏恢复、中断发布恢复和未知文件冲突保护。Oxlint 允许循环中的顺序 await，因为分页、重试和按资源保存清单依赖前一步结果；HLS 分片独立采用受限并发。

`scripts/probe-chrome.ts` 是开发用 Chrome MCP 连接检查脚本，生产下载不启动 MCP 服务。

## 标准 Skill 分发

从 [GitHub Releases](https://github.com/HakurouKen/xiaoe-download/releases) 下载明确版本的 `xiaoe-download-skill-v<版本号>.zip` 及 `.zip.sha256`，核对 SHA-256 后解压，将完整 `xiaoe-download/` 安装到所用 Agent 的 Skill 目录。包内随附自包含下载器，不需要用户克隆项目、运行 pnpm 或安装 npm 依赖；Node.js 24、媒体工具与 Chrome 仍由用户环境提供。升级时替换整个 Skill 目录，保留包外用户状态和下载目录。

仓库中的 `skills/xiaoe-download/` 只保存手写源文件，不能直接复制运行；GitHub 自动生成的 Source code ZIP 也不是安装包。维护者运行 `pnpm package:skill` 在 `dist/` 构建并生成分发附件；版本 tag 工作流验收后创建草稿 Release，由人工正式发布。安装、构建、发布流程及实际验证情况见 [skills/README.md](skills/README.md)。
