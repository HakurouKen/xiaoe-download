# Skill 附加交付

Skill 只负责环境准备、目标确认、调用下载器和解释结果；核心认证、扫描、下载及恢复逻辑归属主项目。职责和零依赖约束见根 `AGENTS.md`。

## 结构与运行

```text
skills/xiaoe-download/
  SKILL.md
  scripts/skill.mjs
  scripts/skill-environment.mjs
  references/downloader -> ../../../dist
  tests/
```

- `scripts/` 是手写并提交 Git 的 `.mjs`，只导入 Node 内置模块及同目录模块，不参与 TypeScript 打包。入口以子进程执行 `references/downloader/cli.mjs`，传递参数、继承日志并传播退出状态，不修改父进程参数或动态导入核心 CLI。
- `references/downloader` 在源码树中引用唯一主构建的产物。维护者先运行 `pnpm build` 后可本地使用；直接复制源码目录、仅拉取 Skill 子目录或清理 `dist/` 都不能得到独立可运行包。Windows 源码检出不承诺软链接开箱即用。
- 主构建生成 CLI、全部共享 chunk 和一份第三方许可声明；Skill 不另行收集或复制许可声明。构建与依赖内联约定见 [build/README.md](../build/README.md)。
- Release 包中指定链接展开为真实文件，用户不需要项目源码、pnpm、npm 依赖或创建软链接。Node.js 24、ffmpeg、ffprobe 和 Chrome 不随包交付。
- `tests/` 不随包交付，使用项目的 Vitest 开发依赖。核心 `check`、单元测试、集成测试及 TypeScript 检查不执行或依赖这些测试；发布流程单独验收。

## 交付边界

交付标准 Agent Skill，不提供各 Agent 专属适配或逐个平台兼容承诺。首版覆盖明确店铺下的目录扫描、全量下载、单课程及单资源下载、类型筛选；不扩大已验证接口范围。媒体需要 ffmpeg 和 ffprobe，仅目录、图文及文档操作不要求媒体工具。缺失工具的安装及现有 Chrome 的登录、调试连接都需用户授权，不由程序静默完成。

Cookie 按店铺隔离，保存在系统对应的用户私有状态目录；输出使用用户确认的包外绝对路径。路径检查同时保护 Skill 目录和下载器引用的真实目录，防止本地软链接目标被当作输出。个人 Cookie、签名 URL、缓存及下载内容不随包交付。真实店铺下载另行取得许可，测试只用合成状态和本地模拟服务，不连接个人 Chrome。

全量下载需用户明确要求，范围不清时先澄清。扫描会创建缓存、锁和清单，不作为无副作用预览。升级前停止旧任务并替换整个 Skill 目录，保留包外用户状态和下载目录，不仅替换某个 JS 文件。不增加自动更新、安装器或首次运行时下载代码的机制。

## 打包与验收

主项目构建完成后运行 `pnpm release`。根目录唯一的 `scripts/release.ts` 默认仅打包，不重新构建、执行测试或联网；维护者打包环境支持 macOS、Linux，需要系统 `zip`，验收需要 `unzip`。Windows 用户安装最终 ZIP 不要求支持本地发布。

发布脚本只展开 `references/downloader` 指向本项目 `dist/` 的链接，其他符号链接及特殊文件拒绝交付。打包选择 `SKILL.md`、手写 `scripts/*.mjs`、引用中的全部根级 `.mjs` 和许可声明，以及 `references/` 中允许的 Markdown/文本资源；隐藏文件、路径逃逸及 `node_modules` 被拒绝。测试、源码映射及历史附件不会进入包。新增资源类型需显式调整交付边界。

打包使用临时组装目录并在结束后清理，不维护第二套常驻 Skill 构建目录。附件写入 `dist/release/`，旧附件在成功组装后清理。ZIP 使用固定的文件顺序、权限和时间，不承诺跨平台压缩或构建字节完全一致。再次主构建会清理整个 `dist/`，包括附件，需先构建再打包。

```sh
pnpm check
pnpm test:e2e
pnpm release
pnpm exec vitest run --config skills/xiaoe-download/tests/vitest.config.mjs
```

Skill 测试校验 SHA-256，用系统解压器解压最终 ZIP 到含空格的包外路径，验证环境检查、状态权限、模拟扫描、WebSocket 握手及错误退出状态；Windows 使用 PowerShell `Expand-Archive`，不依赖仓库软链接。打包和草稿状态测试也归属此目录。可用 `SKILL_RELEASE_DIR` 指定待验收附件目录。

## 发布与安装

Skill 与主项目共用稳定三段版本号。维护者提交版本变更后推送对应 `v<版本号>` tag；`.github/workflows/release-skill.yml` 按锁文件安装依赖并依次执行：核心 Linux 检查及媒体回归、打包、Skill 专用测试、同一 ZIP 的 macOS/Linux/Windows 系统解压冒烟。全部门禁通过后才创建或更新草稿 Release，人工正式发布。

`pnpm release --upload` 仅上传已经验收的 ZIP 和校验文件，不重新打包。要求 `RELEASE_TAG`、`GITHUB_REPOSITORY` 和 GitHub 认证，核对版本、校验和及本地/远端 tag 与构建提交的一致性。tag 漂移、未知 Release 状态或已正式发布时失败，不自动移动 tag 或删除 Release。草稿允许在完整验收后重跑覆盖附件；正式版本修复必须使用新版本。人工发布前确认当前工作流已结束，不与草稿上传并发操作。

用户从 [GitHub Releases](https://github.com/HakurouKen/xiaoe-download/releases) 下载明确版本的 `xiaoe-download-skill-v<版本号>.zip` 及 `.zip.sha256`，核对 SHA-256 后使用系统工具解压，将完整 `xiaoe-download/` 安装到 Agent 的 Skill 目录。自动生成的 Source code 归档不是安装包。用户无需安装 `gh`；已有 `gh` 时可按 tag 和附件名下载。

SHA-256 检测损坏及附件配对错误，不是独立签名或来源认证。第三方许可声明随下载器交付，不代表项目自身已经授予修改或再分发授权；本次不新增项目许可证。当前生成文件只在新版本停止跟踪，不重写旧 Git 历史。

## 实际验证

2026-11-13 / macOS / Node.js 24.17.0：核心 `pnpm check` 通过（22 个单元测试），核心媒体/文档集成回归通过（2 个测试），Skill 专用验收通过（11 个测试）。验证涵盖指定链接展开、ZIP 白名单及系统解压、包外含空格路径、状态隔离、模拟扫描及浏览器握手、子进程参数和退出码传递、缺失产物提示、草稿重试和正式版本拒绝覆盖。源码软链接从无关工作目录启动、版本/tag 拒绝门禁及系统 ZIP 完整性检查通过；工作流通过 actionlint 静态检查。

本次未推送 tag、创建 Release 或执行远端工作流。Linux、Windows 实际运行仍待 CI，不将矩阵配置视为已经验证通过；不读取个人 Cookie 或连接现有 Chrome。
