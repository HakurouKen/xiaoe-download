import { defineConfig } from 'vitest/config';

/** 离线测试配置，不连接真实站点。 */
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
