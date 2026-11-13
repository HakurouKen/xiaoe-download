import fsp from 'node:fs/promises';
import path from 'node:path';

import { defineConfig, type RolldownChunk } from 'tsdown';

async function licenseFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await licenseFiles(filename)));
    else if (/^(?:licen[sc]e|notice|copying)(?:[.-]|$)/i.test(entry.name)) result.push(filename);
  }
  return result.sort();
}

async function collectLicenses(chunks: RolldownChunk[]): Promise<void> {
  const roots = new Set<string>();
  const sourceNotices = new Set<string>();
  for (const chunk of chunks) {
    if (chunk.type !== 'chunk') continue;
    for (const id of Object.keys(chunk.modules)) {
      if (!id.includes('node_modules')) continue;
      const source = await fsp.readFile(id, 'utf8');
      for (const match of source.matchAll(/\/\*[\s\S]*?\*\//g)) {
        if (/@license|SPDX-License-Identifier/.test(match[0])) sourceNotices.add(match[0]);
      }
      let directory = path.dirname(id);
      while (directory !== path.dirname(directory)) {
        try {
          const metadata: unknown = JSON.parse(
            await fsp.readFile(path.join(directory, 'package.json'), 'utf8'),
          );
          if (
            metadata &&
            typeof metadata === 'object' &&
            'name' in metadata &&
            'version' in metadata
          ) {
            roots.add(await fsp.realpath(directory));
            break;
          }
        } catch {
          // 内部目录可能只有声明 module 类型的 package.json，继续寻找包根。
        }
        directory = path.dirname(directory);
      }
    }
  }
  const notices: string[] = [];
  for (const directory of [...roots].sort()) {
    const value: unknown = JSON.parse(
      await fsp.readFile(path.join(directory, 'package.json'), 'utf8'),
    );
    if (!value || typeof value !== 'object' || !('name' in value) || !('version' in value))
      throw new Error('依赖元信息无效');
    const licenses = await licenseFiles(directory);
    notices.push(`=== ${String(value.name)}@${String(value.version)} ===`);
    if (licenses.length === 0) {
      if (value.name === 'boolbase' && 'license' in value && value.license === 'ISC') {
        notices.push(
          '来源：https://github.com/fb55/boolbase/blob/master/LICENSE',
          await fsp.readFile('build/licenses/boolbase.txt', 'utf8'),
        );
        continue;
      }
      // Puppeteer 发布包仅声明 Apache-2.0；携带 SPDX 标准文本及包作者信息。
      if (!('license' in value) || value.license !== 'Apache-2.0')
        throw new Error(`缺少第三方许可证：${String(value.name)}`);
      notices.push(
        `License: Apache-2.0\nAuthor: ${'author' in value ? JSON.stringify(value.author) : '见源文件版权声明'}\n标准文本来源：https://github.com/spdx/license-list-data/blob/main/text/Apache-2.0.txt`,
        await fsp.readFile('build/licenses/Apache-2.0.txt', 'utf8'),
      );
    }
    for (const filename of licenses) {
      notices.push(
        `--- ${path.relative(directory, filename).split(path.sep).join('/')} ---`,
        await fsp.readFile(filename, 'utf8'),
      );
    }
  }
  if (roots.size === 0) throw new Error('构建未发现依赖，无法生成许可证声明');
  notices.push(
    '=== 内联源文件版权及许可声明（含第三方嵌入代码） ===',
    ...[...sourceNotices].sort(),
  );
  await fsp.writeFile('dist/third-party-licenses.txt', `${notices.join('\n\n')}\n`);
}

/** 核心 CLI 的唯一自包含构建，许可声明与同次构建绑定。 */
export default defineConfig({
  entry: ['src/cli.ts'],
  outDir: 'dist',
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
        return 'throw new Error("下载器不支持自动下载或解压 Chrome，请连接现有已登录 Chrome"); export const ProxyAgent = undefined; export default undefined;';
      },
    },
  ],
  hooks: { 'build:done': async ({ chunks }) => collectLicenses(chunks) },
  shims: true,
  sourcemap: true,
});
