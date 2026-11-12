import { defineConfig } from 'vitest/config';

/** 本地 HTTP / ffmpeg 集成验证，串行执行并限定超时。 */
export default defineConfig({
  test: { include: ['src/**/*.e2e.ts'], fileParallelism: false, maxWorkers: 1, testTimeout: 60000 },
});
