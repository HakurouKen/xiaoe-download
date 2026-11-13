import fsp from 'node:fs/promises';
import path from 'node:path';

import { defineConfig } from 'tsdown';

/** CLI 构建配置。 */
export default defineConfig({
  entry: ['src/cli.ts'],
  outDir: 'dist',
  clean: false,
  hooks: {
    'build:prepare': async () => {
      // CLI 只清理根级运行产物，保留 Skill 组装目录及待发布附件。
      await fsp.mkdir('dist', { recursive: true });
      for (const entry of await fsp.readdir('dist', { withFileTypes: true })) {
        if (entry.isFile() && /\.mjs(?:\.map)?$/.test(entry.name))
          await fsp.unlink(path.join('dist', entry.name));
      }
    },
  },
  platform: 'node',
  format: 'esm',
  sourcemap: true,
});
