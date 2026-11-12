import { defineConfig } from 'tsdown';

/** CLI 构建配置。 */
export default defineConfig({
  entry: ['src/cli.ts'],
  platform: 'node',
  format: 'esm',
  sourcemap: true,
});
