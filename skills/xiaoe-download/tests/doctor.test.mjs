import { expect, it, vi } from 'vitest';

import cp from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

import { doctor } from '../scripts/doctor.mjs';
import { stateDirectory } from '../scripts/skill-environment.mjs';

const execFile = util.promisify(cp.execFile);

it('通过大小写或符号链接别名启动 doctor CLI 时仍输出完整 JSON', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'doctor cli '));
  try {
    await fsp.cp('skills/xiaoe-download/scripts', root, { recursive: true });
    const entry = path.join(root, 'DOCTOR.mjs');
    try {
      await fsp.access(entry);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // 大小写敏感的文件系统用符号链接别名；Windows 无需创建符号链接。
      await fsp.symlink('doctor.mjs', entry);
    }
    const { stdout } = await execFile(process.execPath, [
      entry,
      '--ffmpeg',
      'xiaoe-missing-ffmpeg',
      '--ffprobe',
      'xiaoe-missing-ffprobe',
    ]);
    expect(JSON.parse(stdout)).toMatchObject({ ffmpeg: false, ffprobe: false, prepared: false });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

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
