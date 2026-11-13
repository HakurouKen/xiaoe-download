import { expect, it } from 'vitest';

import cp from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

import { stateDirectory } from '../scripts/skill-environment.mjs';
import { checksum } from '../../../scripts/release';

const execFile = util.promisify(cp.execFile);

it('校验并解压最终 Skill ZIP 后在包外独立检查、准备和扫描，不访问原项目依赖', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaoe skill '));
  const home = path.join(root, 'home');
  const output = path.join(root, 'output files');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'local'),
    XDG_STATE_HOME: path.join(home, 'state'),
    NODE_PATH: '',
    XIAOE_CDP_URL: '',
  };
  let upgraded = false;
  let debugRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/json/version') {
      debugRequests += 1;
      response.setHeader('content-type', 'application/json');
      response.end('{}');
      return;
    }
    if (request.url === '/record') {
      response.end('<title>测试店铺</title>');
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/payRecords')) {
      response.end(
        JSON.stringify(
          request.url.includes('lastId=0')
            ? [
                {
                  resource_id: 'a_test',
                  purchase_name: '测试音频',
                  app_id: 'test',
                  resource_type: 1,
                  content_url: '/audio/a_test',
                },
              ]
            : [],
        ),
      );
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  server.on('upgrade', (_request, socket) => {
    upgraded = true;
    socket.end(
      'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
  });
  try {
    const release = process.env.SKILL_RELEASE_DIR ?? 'dist/release';
    const archives = (await fsp.readdir(release)).filter((name) => name.endsWith('.zip'));
    expect(archives).toHaveLength(1);
    const filename = archives[0];
    if (!filename) throw new Error('缺少待验收 ZIP');
    const archive = await fsp.readFile(path.join(release, filename));
    expect(await fsp.readFile(path.join(release, `${filename}.sha256`), 'utf8')).toBe(
      checksum(archive, filename),
    );
    const extracted = path.join(root, 'extracted skill');
    if (process.platform === 'win32') {
      // 使用系统解压器验证用户安装路径，不要求 Windows 创建源码软链接。
      await execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -LiteralPath $env.XIAOE_TEST_ZIP -DestinationPath $env.XIAOE_TEST_EXTRACT',
        ],
        {
          env: {
            ...process.env,
            XIAOE_TEST_ZIP: path.resolve(release, filename),
            XIAOE_TEST_EXTRACT: extracted,
          },
        },
      );
    } else await execFile('unzip', ['-q', path.resolve(release, filename), '-d', extracted]);
    const skill = path.join(extracted, 'xiaoe-download');
    expect((await fsp.lstat(path.join(skill, 'references/downloader'))).isSymbolicLink()).toBe(
      false,
    );
    const downloaderFiles = await fsp.readdir(path.join(skill, 'references/downloader'));
    expect(downloaderFiles).toContain('third-party-licenses.txt');
    expect(downloaderFiles.some((name) => name.endsWith('.map'))).toBe(false);
    const run = (args, overrides = {}) =>
      execFile(process.execPath, [path.join(skill, 'scripts', 'skill.mjs'), ...args], {
        cwd: root,
        env: { ...env, ...overrides },
        timeout: 30000,
      });
    expect((await run(['--help'])).stdout).toContain('环境');
    const doctor = JSON.parse(
      (await run(['--doctor', '--ffmpeg', 'missing-ffmpeg', '--ffprobe', 'missing-ffprobe']))
        .stdout,
    );
    expect(doctor).toMatchObject({ ffmpeg: false, ffprobe: false, prepared: false });
    await expect(fsp.access(home)).rejects.toThrow();
    await expect(run(['list', '--output', output])).rejects.toMatchObject({
      stderr: expect.stringContaining('店铺'),
    });
    await expect(run(['--prepare', '--output', 'relative'])).rejects.toMatchObject({
      stderr: expect.stringContaining('绝对路径'),
    });
    await expect(
      run(['--prepare', '--output', path.join(skill, 'downloads')]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('之外') });
    await expect(
      run(['--prepare', '--output', path.join(skill, 'references/downloader/downloads')]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('之外') });
    await run(['--prepare', '--output', output]);
    const state = stateDirectory(process.platform, home, env);
    if (process.platform !== 'win32') expect((await fsp.stat(state)).mode & 0o777).toBe(0o700);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务器未启动');
    const origin = `http://127.0.0.1:${address.port}`;
    await run(['--doctor'], { XIAOE_CDP_URL: origin });
    expect(debugRequests).toBe(0);
    await run(['--doctor', '--cdp', origin]);
    expect(debugRequests).toBe(1);
    const key = crypto.createHash('sha256').update(origin).digest('hex').slice(0, 24);
    await fsp.mkdir(path.join(state, 'cookies'), { recursive: true });
    await fsp.writeFile(
      path.join(state, 'cookies', `${key}.json`),
      JSON.stringify({
        version: 1,
        origin,
        capturedAt: Date.now(),
        userAgent: 'test-agent',
        cookies: [
          {
            name: 'sid',
            value: 'synthetic-test-cookie',
            domain: '127.0.0.1',
            path: '/',
            secure: false,
            expires: -1,
          },
        ],
      }),
    );
    const scanned = await run([
      'list',
      '--url',
      `${origin}/record`,
      '--output',
      output,
      '--ffmpeg',
      'missing-ffmpeg',
    ]);
    expect(scanned.stdout).toContain('发现 1 门');
    expect(
      JSON.parse(await fsp.readFile(path.join(output, 'catalog.json'), 'utf8')).courses,
    ).toHaveLength(1);
    await expect(fsp.access(path.join(output, '.xiaoe.lock'))).rejects.toThrow();
    expect(await fsp.readdir(skill)).not.toContain('node_modules');
    expect((await fsp.readdir(skill)).sort()).toEqual(['SKILL.md', 'references', 'scripts']);
    await expect(
      run([
        'list',
        '--url',
        `${origin}/record`,
        '--output',
        output,
        '--refresh-cookie',
        '--cdp',
        `ws://127.0.0.1:${address.port}/devtools/browser`,
      ]),
    ).rejects.toMatchObject({ code: 1 });
    // 模拟拒绝握手仍能验证复制后的 Node WebSocket 传输实际被加载并发起连接。
    expect(upgraded).toBe(true);
    await expect(fsp.access(path.join(output, '.xiaoe.lock'))).rejects.toThrow();
    await expect(
      run(['all', '--url', `${origin}/record`, '--output', output, '--ffmpeg', 'missing-ffmpeg']),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('缺少 ffmpeg') });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it('辅助入口通过子进程调用 CLI，传递参数及原始退出码，缺失产物时明确报错', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill child process '));
  const skill = path.join(root, 'installed skill');
  try {
    await fsp.cp('skills/xiaoe-download/scripts', path.join(skill, 'scripts'), { recursive: true });
    const cli = path.join(skill, 'references/downloader/cli.mjs');
    await fsp.mkdir(path.dirname(cli), { recursive: true });
    await fsp.writeFile(
      cli,
      'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;',
    );
    const run = () =>
      execFile(process.execPath, [path.join(skill, 'scripts/skill.mjs'), '--help'], { cwd: root });
    await expect(run()).rejects.toMatchObject({
      code: 7,
      stdout: expect.stringContaining('["--help"]'),
    });
    await fsp.unlink(cli);
    await expect(run()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('缺少下载器产物'),
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
