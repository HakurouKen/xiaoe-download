#!/usr/bin/env node
import cp from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import util from 'node:util';
import url from 'node:url';

import {
  canonicalDirectory,
  commandAvailable,
  prepareStateDirectory,
  skillCookieCache,
  stateDirectory,
} from './skill-environment.mjs';

async function runDownloader(args) {
  const filename = url.fileURLToPath(new URL('../references/downloader/cli.mjs', import.meta.url));
  try {
    await fsp.access(filename);
  } catch {
    throw new Error('缺少下载器产物，请安装完整 Release 包；源码环境先运行 pnpm build');
  }
  await new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [filename, ...args], { stdio: 'inherit' });
    const forward = (signal) => child.kill(signal);
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      cleanup();
      process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
      resolve();
    });
  });
}

async function main() {
  const { values, positionals } = util.parseArgs({
    allowPositionals: true,
    options: {
      doctor: { type: 'boolean' },
      prepare: { type: 'boolean' },
      url: { type: 'string' },
      output: { type: 'string' },
      cdp: { type: 'string' },
      'cookie-cache': { type: 'string' },
      'refresh-cookie': { type: 'boolean' },
      concurrency: { type: 'string' },
      kinds: { type: 'string' },
      ffmpeg: { type: 'string' },
      ffprobe: { type: 'string' },
      'catalog-only': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Skill 入口：node <skill目录>/scripts/skill.mjs --doctor [--cdp 地址]\n准备目录：--prepare --output <绝对路径>\n下载：<all|list|course|media> [目标] --url <购买记录URL> --output <绝对路径> [CLI选项]\n外部环境：Node.js 24；媒体需要 ffmpeg、ffprobe；首次认证需要已登录 Chrome CDP。\nSkill 强制指定包外绝对输出路径，自动管理用户缓存，不接受 --cookie-cache。\n下面是底层 cli.mjs 的选项，默认 downloads 和自定义缓存仅适用于直接调用 cli.mjs：',
    );
    await runDownloader(['--help']);
    return;
  }
  const nodeReady = Number(process.versions.node.split('.')[0]) === 24;
  if (!nodeReady) throw new Error('需要 Node.js 24，请在获得用户许可后安装并重试');
  if (values.doctor) {
    const ffmpeg = await commandAvailable(values.ffmpeg ?? 'ffmpeg', ['-version']);
    const ffprobe = await commandAvailable(values.ffprobe ?? 'ffprobe', ['-version']);
    let cdp = '未检查；缓存有效时无需 Chrome，首次或刷新登录态需用户开启调试并允许连接';
    const endpoint = values.cdp;
    if (endpoint && /^https?:/.test(endpoint)) {
      try {
        const response = await fetch(new URL('/json/version', endpoint), {
          signal: AbortSignal.timeout(5000),
        });
        cdp = response.ok
          ? 'HTTP 调试服务可达；尚未验证店铺登录态'
          : `HTTP ${response.status}；请检查 Chrome 调试地址`;
      } catch {
        cdp = 'HTTP 调试服务不可达；请用户开启调试并确认地址';
      }
    }
    console.log(
      JSON.stringify(
        {
          node: process.versions.node,
          ffmpeg,
          ffprobe,
          stateDirectory: stateDirectory(),
          cdp,
          prepared: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!values.output || !path.isAbsolute(values.output))
    throw new Error('请先确认并指定 --output 绝对路径');
  const skillRoot = await canonicalDirectory(path.resolve(import.meta.dirname, '..'));
  const output = await canonicalDirectory(path.resolve(values.output));
  const downloaderRoot = await canonicalDirectory(path.join(skillRoot, 'references', 'downloader'));
  for (const directory of [output, await canonicalDirectory(stateDirectory())]) {
    for (const protectedRoot of [skillRoot, downloaderRoot]) {
      const relative = path.relative(protectedRoot, directory);
      if (
        !relative ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      )
        throw new Error('下载和用户状态目录必须位于 Skill 安装目录之外');
    }
  }
  if (values['cookie-cache'])
    throw new Error(
      'Skill 使用包外用户状态目录，不接受自定义 --cookie-cache；如需手动管理请直接调用 cli.mjs',
    );
  if (values.prepare) {
    const directory = await prepareStateDirectory();
    await fsp.mkdir(output, { recursive: true });
    console.log(JSON.stringify({ stateDirectory: directory, output, prepared: true }, null, 2));
    return;
  }
  const command = positionals[0];
  if (!command || !['all', 'list', 'course', 'media'].includes(command))
    throw new Error('请明确指定 all、list、course 或 media');
  const url = values.url ?? (['all', 'list'].includes(command) ? positionals[1] : undefined);
  if (!url || !['http:', 'https:'].includes(new URL(url).protocol))
    throw new Error('请明确指定目标店铺购买记录 URL');
  const mediaNeeded =
    command !== 'list' &&
    !values['catalog-only'] &&
    (!values.kinds ||
      values.kinds.split(',').some((kind) => ['video', 'audio', 'replay'].includes(kind.trim())));
  if (
    mediaNeeded &&
    (!(await commandAvailable(values.ffmpeg ?? 'ffmpeg', ['-version'])) ||
      !(await commandAvailable(values.ffprobe ?? 'ffprobe', ['-version'])))
  )
    throw new Error('缺少 ffmpeg 或 ffprobe；请在获得用户许可后安装，或指定可执行文件绝对路径');
  await prepareStateDirectory();
  await runDownloader([...process.argv.slice(2), '--cookie-cache', skillCookieCache(url)]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
