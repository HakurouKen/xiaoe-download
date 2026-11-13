import { expect, it, vi } from 'vitest';

import { doctor } from '../scripts/doctor.mjs';
import { stateDirectory } from '../scripts/skill-environment.mjs';

it('默认检查返回报告且不因调试环境变量联网', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  vi.stubEnv('XIAOE_CDP_URL', 'http://127.0.0.1:9222');
  try {
    expect(
      await doctor({ ffmpeg: 'xiaoe-missing-ffmpeg', ffprobe: 'xiaoe-missing-ffprobe' }),
    ).toMatchObject({
      node: process.versions.node,
      ffmpeg: false,
      ffprobe: false,
      stateDirectory: stateDirectory(),
      prepared: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it('仅检查显式 HTTP 地址，报告可达、HTTP 失败及网络失败', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const options = {
    ffmpeg: 'xiaoe-missing-ffmpeg',
    ffprobe: 'xiaoe-missing-ffprobe',
    cdp: 'http://127.0.0.1:9222/path',
  };
  try {
    fetch.mockResolvedValueOnce({ ok: true });
    expect((await doctor(options)).cdp).toContain('尚未验证店铺登录态');
    expect(fetch.mock.calls[0][0].href).toBe('http://127.0.0.1:9222/json/version');
    fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    expect((await doctor(options)).cdp).toContain('HTTP 503');
    fetch.mockRejectedValueOnce(new Error('offline'));
    expect((await doctor(options)).cdp).toContain('不可达');
    fetch.mockClear();
    await doctor({ ...options, cdp: 'ws://127.0.0.1:9222/devtools/browser' });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
