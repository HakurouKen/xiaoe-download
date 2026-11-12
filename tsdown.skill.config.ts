import { defineConfig } from 'tsdown';

/** 分发目录只保留 Node 内置模块为外部依赖，不包含源码映射或凭据。 */
export default defineConfig({
  entry: ['src/cli.ts', 'src/skill.ts'],
  outDir: 'skills/xiaoe-download/scripts',
  platform: 'node',
  format: 'esm',
  deps: { alwaysBundle: [/.*/], onlyImport: [/^node:/] },
  plugins: [
    {
      name: 'disable-browser-installation',
      resolveId(source, importer) {
        // 仅替换浏览器安装器的可选依赖；已登录 Chrome 的 CDP 连接不使用它们。
        if (importer?.includes('@puppeteer') && ['proxy-agent', 'yauzl'].includes(source))
          return `\0unsupported-browser-install:${source}`;
      },
      load(id) {
        if (!id.startsWith('\0unsupported-browser-install:')) return;
        return 'throw new Error("Skill 不支持自动下载或解压 Chrome，请连接现有已登录 Chrome"); export const ProxyAgent = undefined; export default undefined;';
      },
    },
  ],
  shims: true,
  sourcemap: false,
});
