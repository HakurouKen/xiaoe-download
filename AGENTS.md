# 项目约束

- 核心下载器维护在 `src/`，统一编译到 `dist/`，生成自包含 CLI 及对应第三方许可证；核心源码不导入 Skill 专用模块。
- Skill 是附加交付项。仅供 Skill 使用的运行逻辑维护在 `skills/xiaoe-download/scripts/`，采用手写并提交 Git 的 `.mjs`，仅使用 Node.js 内置模块，不引入外部 npm 依赖。此限制不要求核心下载器移除第三方依赖。
- Skill 在源码树中通过软链接引用 `dist/`；发布时展开为包内真实文件，交付包不依赖原项目路径或软链接。
- Skill 专用测试与资源归属 `skills/`，由发布流程单独验收；核心常规检查及集成测试不依赖 Skill 构建、打包或测试。
- 根 `scripts/` 仅维护 `release.ts`，只生成 ZIP 和 checksum；测试、Git tag 校验及创建、GitHub Release 上传及正式发布由 `.github/workflows/release.yml` 编排。
- 修改 Skill 的结构、构建或分发流程前，阅读 `skills/README.md`；保持其设计说明与实现一致。
