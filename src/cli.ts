#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import util from 'node:util';

import { loadLoginSession } from './auth';
import { discoverCourseContents } from './catalog';
import { resolveArticleSource, resolveDocumentSources } from './content-source';
import { downloadCourse } from './downloader';
import { allocateNames, writeJson } from './files';
import { MediaHttp } from './http';
import { resolveMediaSources } from './media-source';
import { errorMessage } from './model';
import { StoreClient } from './store';

import type { Content, Course } from './model';

const defaultUrl = 'https://appugoxosta5125.h5.xet.pomoho.com/p/t/v1/ecommerce/pay_record/record';
const help = `小鹅通已购课程下载器（Node.js 24）

用法：
  xiaoe-download all [购买记录 URL] [选项]
  xiaoe-download list [购买记录 URL] [选项]
  xiaoe-download course <课程 ID 或 URL> [选项]
  xiaoe-download media <资源 ID 或 URL> [选项]

选项：
  --url <URL>         购买记录地址（默认使用本项目目标店铺）
  --cdp <地址>        已登录 Chrome 调试地址，默认 ws://127.0.0.1:9222/devtools/browser
  --output <目录>     输出目录，默认 downloads
  --cookie-cache <路径> Cookie 缓存文件，默认 .cache/cookies/<店铺摘要>.json
  --refresh-cookie   忽略缓存，从当前 Chrome 重新获取登录态
  --concurrency <n>   HLS 分片并发，默认 6（1～32）
  --kinds <类型>      仅下载指定类型，逗号分隔：video,audio,replay,text,document
  --ffmpeg <路径>     ffmpeg 可执行文件，默认 ffmpeg
  --ffprobe <路径>    ffprobe 可执行文件，默认 ffprobe
  --catalog-only     完整扫描并创建图文 / 文档占位，不下载媒体
  --help             显示帮助

连接已有 Chrome：在 chrome://inspect/#remote-debugging 开启调试，并允许本工具连接。
缓存有效时无需连接 Chrome；获取登录态后立即断开，不关闭 Chrome。
`;

async function main(): Promise<void> {
  const { values, positionals } = util.parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      cdp: { type: 'string' },
      output: { type: 'string' },
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
    console.log(help);
    return;
  }
  const command = positionals[0] ?? 'all';
  if (!['all', 'list', 'course', 'media'].includes(command))
    throw new Error('未知命令，运行 --help 查看用法');
  if (positionals.length > 2) throw new Error('位置参数过多');
  const target = positionals[1];
  if (['course', 'media'].includes(command) && !target)
    throw new Error(`${command} 需要课程 / 资源 ID 或 URL`);
  const url = values.url ?? (['all', 'list'].includes(command) && target ? target : defaultUrl);
  if (!['http:', 'https:'].includes(new URL(url).protocol))
    throw new Error('店铺地址必须是 HTTP(S)');
  const concurrency = Number(values.concurrency ?? 6);
  const kinds = values.kinds?.split(',').map((kind) => kind.trim());
  if (
    kinds &&
    kinds.some((kind) => !['video', 'audio', 'replay', 'text', 'document'].includes(kind))
  )
    throw new Error('kinds 仅允许 video,audio,replay,text,document，使用逗号分隔');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error('concurrency 必须为 1～32 的整数');
  const output = path.resolve(values.output ?? 'downloads');
  await fsp.mkdir(output, { recursive: true });
  const lockPath = path.join(output, '.xiaoe.lock');
  const lock = await fsp.open(lockPath, 'wx').catch(() => {
    throw new Error('输出目录已有下载任务锁。确认旧任务已停止后删除 .xiaoe.lock 再运行');
  });
  await lock.writeFile(String(process.pid));
  try {
    const session = await loadLoginSession({
      endpoint: values.cdp ?? process.env.XIAOE_CDP_URL ?? 'ws://127.0.0.1:9222/devtools/browser',
      storeUrl: url,
      cacheFile: values['cookie-cache'],
      forceRefresh: values['refresh-cookie'],
      log: console.log,
    });
    const client = new StoreClient(url, session);
    await client.pageTitle(url);
    const courses = await client.purchasedCourses();
    console.log(`发现 ${courses.length} 门已购课程，购买分页已完整读取。`);
    const names = allocateNames(courses);
    let chosenCourses = courses;
    let mediaId = '';
    let requestedCourse = '';
    if (target && ['course', 'media'].includes(command)) {
      if (/^https?:/.test(target)) {
        const parsed = new URL(target);
        if (parsed.origin !== client.origin) throw new Error('单课程 / 媒体 URL 必须属于当前店铺');
        const id = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
        if (command === 'course') requestedCourse = id;
        else {
          mediaId = id;
          requestedCourse =
            parsed.searchParams.get('course_id') ??
            parsed.searchParams.get('product_id') ??
            parsed.searchParams.get('pro_id') ??
            '';
        }
      } else if (command === 'course') requestedCourse = target;
      else mediaId = target;
    }
    if (requestedCourse) {
      chosenCourses = courses.filter((course) => course.id === requestedCourse);
      if (chosenCourses.length === 0) throw new Error('此课程不在当前已购列表中');
    }
    const catalog: { course: Course; contents?: Content[]; error?: string }[] = [];
    const summary = { courses: 0, downloaded: 0, placeholders: 0, failed: 0, courseErrors: 0 };
    let mediaFound = false;
    for (const course of chosenCourses) {
      console.log(`课程：${course.title}`);
      let contents: Content[];
      try {
        contents = await discoverCourseContents(course, (endpoint, data) =>
          client.api(endpoint, data),
        );
      } catch (error) {
        const message = errorMessage(error);
        catalog.push({ course, error: message });
        summary.courseErrors += 1;
        console.error(`目录失败：${message}`);
        continue;
      }
      catalog.push({ course, contents });
      await writeJson(path.join(output, 'catalog.json'), {
        courses: catalog,
        updatedAt: new Date().toISOString(),
      });
      if (command === 'list') {
        console.log(`  ${contents.length} 个内容`);
        continue;
      }
      let selected = contents;
      if (command === 'media') {
        selected = contents.filter((content) => content.id === mediaId);
        if (selected.length === 0) continue;
        mediaFound = true;
      }
      if (values['catalog-only'])
        selected = selected.filter((content) => ['text', 'document'].includes(content.kind));
      if (kinds) selected = selected.filter((content) => kinds.includes(content.kind));
      const directory = path.join(output, names.get(course.id) ?? course.id);
      await fsp.mkdir(directory, { recursive: true });
      const http = new MediaHttp({
        authenticate: session.run,
        headersForUrl: async (mediaUrl) => {
          const cookie = await session.cookieHeader(mediaUrl);
          return {
            'user-agent': session.userAgent,
            referer: course.url,
            ...(cookie ? { cookie } : {}),
          };
        },
      });
      const results = await downloadCourse(course, contents, directory, {
        selectedIds: new Set(selected.map((content) => content.id)),
        catalogOnly: values['catalog-only'],
        http,
        ffmpeg: values.ffmpeg ?? 'ffmpeg',
        ffprobe: values.ffprobe ?? 'ffprobe',
        concurrency,
        resolve: (content) => resolveMediaSources(client, content, course.appId),
        resolveArticle: (content) => resolveArticleSource(client, content, http),
        resolveDocuments: (content) => resolveDocumentSources(client, content),
        log: console.log,
      });
      summary.courses += 1;
      for (const result of results) {
        if (result.status === 'done') summary.downloaded += 1;
        else if (result.status === 'placeholder') summary.placeholders += 1;
        else summary.failed += 1;
      }
      await writeJson(path.join(output, 'summary.json'), summary);
      if (command === 'media') break;
    }
    await writeJson(path.join(output, 'catalog.json'), {
      courses: catalog,
      updatedAt: new Date().toISOString(),
    });
    await writeJson(path.join(output, 'summary.json'), summary);
    if (command === 'media' && !mediaFound) throw new Error('所有可访问课程中均未找到该资源');
    console.log(
      `完成：${summary.downloaded} 个内容，${summary.placeholders} 个占位，${summary.failed} 个内容失败，${summary.courseErrors} 门课程目录失败。`,
    );
    if (summary.failed + summary.courseErrors > 0) process.exitCode = 1;
  } finally {
    await lock.close();
    await fsp.rm(lockPath, { force: true });
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
