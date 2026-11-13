import fsp from 'node:fs/promises';
import path from 'node:path';

import { build } from 'tsdown';

import config from '../tsdown.skill.config';

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

async function main(): Promise<void> {
  await fsp.rm('dist/skill', { recursive: true, force: true });
  const result = await build({ ...config, config: false });
  const roots = new Set<string>();
  const sourceNotices = new Set<string>();
  for (const bundle of result.bundles) {
    for (const chunk of bundle.chunks) {
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
          await fsp.readFile('scripts/license-templates/boolbase.txt', 'utf8'),
        );
        continue;
      }
      // Puppeteer 发布包仅声明 Apache-2.0；携带 SPDX 标准文本及包作者信息。
      if (!('license' in value) || value.license !== 'Apache-2.0')
        throw new Error(`缺少第三方许可证：${String(value.name)}`);
      notices.push(
        `License: Apache-2.0\nAuthor: ${'author' in value ? JSON.stringify(value.author) : '见源文件版权声明'}\n标准文本来源：https://github.com/spdx/license-list-data/blob/main/text/Apache-2.0.txt`,
        await fsp.readFile('scripts/license-templates/Apache-2.0.txt', 'utf8'),
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
  await fsp.cp('skills/xiaoe-download', 'dist/skill/xiaoe-download', {
    recursive: true,
    filter: (source) => !['scripts', 'third-party-licenses.txt'].includes(path.basename(source)),
  });
  await fsp.mkdir('dist/skill/xiaoe-download/references', { recursive: true });
  await fsp.writeFile(
    'dist/skill/xiaoe-download/references/third-party-licenses.txt',
    `${notices.join('\n\n')}\n`,
  );
  console.log(`Skill 已生成，保留 ${roots.size} 个依赖的许可证。`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
