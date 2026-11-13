import { defineConfig } from 'vitest/config';

/** Skill 与发布附件专用验收，不参与核心测试。 */
export default defineConfig({
  test: {
    include: [
      'skills/xiaoe-download/tests/**/*.test.mjs',
      'skills/xiaoe-download/tests/**/*.e2e.mjs',
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60000,
  },
});
