---
name: xiaoe-download
description: 扫描或下载当前账户有权限访问的小鹅通已购课程，支持视频、音频、直播回放、图文及文档。
---

# 小鹅通已购课程下载

使用本 Skill 随附的下载器执行确定性操作。定位本文件所在目录，以其为 `<skill目录>`；命令中的路径必须替换为实际绝对路径，并按当前 Shell 正确引用。无需克隆原项目、pnpm 或安装项目依赖。

## 环境检查与准备

1. 检查 `node --version`。需要 Node.js 24；未安装或版本不符时，在征得用户同意后协助安装。先识别系统及已有包管理器，使用该环境可信的安装方式；不假设存在 Homebrew、apt 或 winget。安装失败时说明原因并停止依赖该工具的步骤。
2. 运行 `node "<skill目录>/scripts/skill.mjs" --doctor`。结果报告 ffmpeg、ffprobe 是否可用及用户状态目录，此操作不创建目录、不读取 Cookie、不连接店铺或浏览器调试服务，也不会因 `XIAOE_CDP_URL` 自动联网。媒体下载需要两者，目录扫描及仅图文/文档下载不需要。工具缺失时获得许可后协助安装，也可以用 `--ffmpeg`、`--ffprobe` 指定可执行文件路径，再检查。
3. 确认店铺购买记录 URL、下载范围和包外输出目录。支持已有 CLI 的四个命令及类型筛选；具体选项运行入口 `--help` 查询。目标或范围模糊时澄清；只有用户明确要求全量下载时执行 `all`。不使用作者的个人店铺作为默认目标。
4. 在用户确认目录后，执行 `node "<skill目录>/scripts/skill.mjs" --prepare --output "<绝对输出目录>"`，创建输出及用户状态目录。这是写操作，不是只读检查。Cookie 缓存按店铺隔离，位于用户状态目录，个人数据不写入 Skill 包。Windows 使用账户 ACL，Unix 限制目录权限；权限准备失败时停止。
5. 首次认证或刷新缓存需要现有已登录 Chrome。引导用户打开目标店铺、完成登录，在 `chrome://inspect/#remote-debugging` 开启调试并允许连接。开启调试及登录由用户授权操作，不自行重启或关闭 Chrome。可指定 `--cdp` 或 `XIAOE_CDP_URL`；HTTP 地址可通过 `--doctor --cdp <地址>` 检查服务可达性，这不证明已登录。默认 WebSocket 地址为 `ws://127.0.0.1:9222/devtools/browser`，连接失败时让用户确认真实地址。禁止把远程调试服务暴露给不可信网络。

## 执行

```sh
node "<skill目录>/scripts/skill.mjs" list --url "<购买记录URL>" --output "<绝对输出目录>"
node "<skill目录>/scripts/skill.mjs" course "<课程ID或同店铺URL>" --url "<购买记录URL>" --output "<绝对输出目录>" --kinds text,document
```

扫描也会连接店铺、缓存登录态并创建锁、`catalog.json` 和 `summary.json`，不是无副作用预览。直接执行用户已明确指定的目标即可，无需每次重复全量扫描。课程或资源 URL 必须与目标店铺同源。

缓存有效时无需 Chrome，认证获取完成后程序立即断开。Cookie、签名 URL 和调试服务信息按敏感信息处理；不打印、上传或随包复制 Cookie，不绕过权限或 DRM。此次封装保留现有接口范围，不保证所有店铺均兼容。

## 结果与恢复

检查退出码、日志和输出目录中的 `summary.json`；区分成功、占位和失败，退出码非零不代表所有内容都失败。不要把 `--catalog-only` 的占位当作下载完成。回复包含输出路径、成功及失败数量、可执行的下一步；对未结束直播、课程过期、权限拒绝、接口变化等明确说明，不自动扩大范围或绕过限制。

重跑可恢复完整资源，失败的 HLS 分片不持久缓存。发现 `.xiaoe.lock` 时确认旧任务已停止，获得用户同意后才清理；不删除运行中任务的锁。读取清单和查看文件即可判断结果，避免无依据宣称内容完整。

升级时替换整个 Skill 目录，保留包外用户状态及输出目录。随附下载器和第三方许可证位于 `references/downloader/`。按 macOS、Linux、Windows 设计；Linux 和 Windows 的实际运行尚未验证。仅标准 Skill 交付，不依赖 Agent 专有工具。
