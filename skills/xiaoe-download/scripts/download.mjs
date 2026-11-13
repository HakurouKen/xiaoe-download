#!/usr/bin/env node
import cp from 'node:child_process';
import fsp from 'node:fs/promises';
import util from 'node:util';
import url from 'node:url';

import {
  commandAvailable,
  prepareStateDirectory,
  skillCookieCache,
  checkedOutput,
  requireNode24,
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
      '下载：node <skill目录>/scripts/download.mjs <all|list|course|media> [目标] --url <购买记录URL> --output <绝对路径> [CLI选项]\n环境：Node.js 24；媒体需要 ffmpeg、ffprobe。强制包外绝对输出目录及用户缓存。',
    );
    await runDownloader(['--help']);
    return;
  }
  requireNode24();
  await checkedOutput(values.output);
  if (values['cookie-cache'])
    throw new Error(
      'Skill 使用包外用户状态目录，不接受自定义 --cookie-cache；如需手动管理请直接调用 cli.mjs',
    );
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
