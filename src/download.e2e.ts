import { expect, it } from 'vitest';

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { downloadCourse } from './downloader';
import { MediaHttp } from './http';
import { runMediaTool } from './hls';
import type { Content, Course } from './model';

it('真实 ffmpeg 下载音频和 AES-128 HLS，验证占位、重跑及部分下载保留清单', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaoe-e2e-'));
  const assets = path.join(root, 'assets');
  await fsp.mkdir(assets);
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    void (async () => {
      const name = path.basename(new URL(request.url ?? '/', 'http://localhost').pathname);
      try {
        const data = await fsp.readFile(path.join(assets, name));
        response.writeHead(200, {
          'content-length': data.length,
          ...(name === 'key.bin' ? { 'content-type': 'text/html; charset=UTF-8' } : {}),
        });
        response.end(data);
      } catch {
        response.writeHead(404);
        response.end();
      }
    })();
  });
  try {
    await fsp.writeFile(path.join(assets, 'document.pdf'), '%PDF-1.7\n%%EOF\n');
    await runMediaTool('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-y',
      path.join(assets, 'audio.mp3'),
    ]);
    await fsp.writeFile(path.join(assets, 'key.bin'), crypto.randomBytes(16));
    await fsp.writeFile(
      path.join(assets, 'key-info'),
      `key.bin\n${path.join(assets, 'key.bin')}\n`,
    );
    await runMediaTool('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x64:r=10:d=1',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-hls_time',
      '0.5',
      '-hls_key_info_file',
      path.join(assets, 'key-info'),
      '-hls_segment_filename',
      path.join(assets, 'segment%d.ts'),
      '-y',
      path.join(assets, 'main.m3u8'),
    ]);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务器未启动');
    const origin = `http://127.0.0.1:${address.port}`;
    const course: Course = {
      id: 'course',
      title: '测试课程',
      url: origin,
      appId: 'app',
      resourceType: 50,
    };
    const contents: Content[] = ['audio', 'video', 'replay', 'text', 'document'].map(
      (kind, index) => ({
        id: String(index),
        title: `第${index}节`,
        kind:
          kind === 'audio'
            ? 'audio'
            : kind === 'video'
              ? 'video'
              : kind === 'replay'
                ? 'replay'
                : kind === 'text'
                  ? 'text'
                  : 'document',
        url: origin,
        courseId: 'course',
        subCourseId: '',
        chapter: [],
        available: true,
      }),
    );
    const directory = path.join(root, 'output');
    const options = {
      http: new MediaHttp({ headersForUrl: async () => ({}), retries: 0 }),
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
      concurrency: 2,
      resolveArticle: async () => ({ html: '<p>完整正文</p>', baseUrl: origin }),
      resolveDocuments: async () => [{ url: `${origin}/document.pdf`, filename: '原文档.pdf' }],
      resolve: async (content: Content) => [
        {
          url: `${origin}/${content.kind === 'audio' ? 'audio.mp3' : 'main.m3u8'}`,
          hls: content.kind !== 'audio',
          audioOnly: content.kind === 'audio',
        },
      ],
    };
    const selected = await downloadCourse(course, contents, directory, {
      ...options,
      selectedIds: new Set(['2']),
    });
    expect(selected[0]?.files[0]?.name).toBe('03-第2节.mp4');
    const placeholders = await downloadCourse(course, contents, directory, {
      ...options,
      catalogOnly: true,
      selectedIds: new Set(['3', '4']),
    });
    expect(placeholders.map((result) => result.files[0]?.name)).toEqual([
      '04-第3节.text.placeholder',
      '05-第4节.document.placeholder',
    ]);
    const results = await downloadCourse(course, contents, directory, options);
    expect(results.filter((result) => result.status === 'failed')).toEqual([]);
    expect(results.map((result) => result.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(results.map((result) => result.files[0]?.name)).toEqual([
      '01-第0节.mp3',
      '02-第1节.mp4',
      '03-第2节.mp4',
      '04-第3节.html',
      '05-第4节.pdf',
    ]);
    const previousRequests = requests;
    await downloadCourse(course, contents, directory, options);
    expect(requests).toBe(previousRequests);
    await downloadCourse(course, contents, directory, { ...options, selectedIds: new Set(['0']) });
    const manifest: unknown = JSON.parse(
      await fsp.readFile(path.join(directory, '.xiaoe-manifest.json'), 'utf8'),
    );
    expect(manifest).toHaveProperty('results.length', 5);
    await fsp.writeFile(path.join(directory, '01-第0节.mp3'), 'truncated');
    const repaired = await downloadCourse(course, contents, directory, {
      ...options,
      selectedIds: new Set(['0']),
    });
    expect(repaired[0]?.status).toBe('done');
    expect(repaired[0]?.files[0]?.name).toBe('01-第0节.mp3');
    expect((await fsp.readdir(directory)).some((name) => name.includes('.incomplete-'))).toBe(true);
    expect((await fsp.readdir(directory)).some((name) => name.startsWith('.xiaoe-part-'))).toBe(
      false,
    );
    const failureDirectory = path.join(root, 'failed-output');
    const failureResults = await downloadCourse(course, contents, failureDirectory, {
      ...options,
      catalogOnly: true,
      selectedIds: new Set(['0', '3']),
      resolve: async () => {
        throw new Error('测试下载失败');
      },
    });
    expect(failureResults.map((result) => result.status)).toEqual(['failed', 'placeholder']);
    expect(failureResults[1]?.files[0]?.name).toBe('04-第3节.text.placeholder');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(root, { recursive: true, force: true });
  }
});
