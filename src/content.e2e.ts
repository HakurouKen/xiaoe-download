import { expect, it } from 'vitest';

import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import * as cheerio from 'cheerio';

import { publishArtifactFiles } from './artifact-files';
import { resolveArticleSource, resolveDocumentSources } from './content-source';
import { downloadCourse } from './downloader';
import { MediaHttp } from './http';
import { StoreClient } from './store';

import type { Content, Course } from './model';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=',
  'base64',
);

it('真实 fetch 下载图文原图及 PDF，安全升级占位，失败保留原文件且重跑恢复编号', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaoe-content-'));
  let origin = '';
  let broken = true;
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const json = (data: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 0, data }));
      };
      if (request.url === '/xe.course.business.e_course.subscribe.get/1.0.0') {
        expect(new URLSearchParams(body).get('bizData[course_id]')).toBe('course');
        json({ is_subscribe: 1 });
      } else if (request.url === '/xe.course.business_go.get.detail/2.0.0') {
        expect(new URLSearchParams(body).get('bizData[resource_id]')).toBe('article');
        json({
          org_content: `<p>完整正文</p><script>alert(1)</script><img src="/thumbnail" data-src="${origin}/image?signature=secret" onerror="alert(1)"><img src="/image?signature=secret"><picture><source srcset="/thumbnail 1x, /image?signature=secret 2x"><img src="/thumbnail"></picture><div style="background-image:url('/image?signature=secret')">背景图</div><a data-file download="附件.pdf" href="/original.pdf">附件</a>`,
          try_org_content: '<p>试看</p>',
          signature: '',
          auto_fetch: 0,
        });
      } else if (request.url === '/xe.course.business.e_course.document_info.get/1.0.0') {
        expect(JSON.parse(body)).toEqual({
          bizData: { resource_id: 'document', product_id: 'course' },
        });
        json({
          is_download: 1,
          is_subscribe: 1,
          is_ban: 0,
          file_name: '原始名称.pdf',
          file_url: `${origin}/document-redirect`,
        });
      } else if (request.url === '/document-redirect') {
        response.writeHead(302, { location: '/original.pdf' });
        response.end();
      } else {
        const data = broken
          ? Buffer.from('<html>错误页</html>')
          : request.url?.startsWith('/image')
            ? png
            : pdf;
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': data.length,
        });
        response.end(data);
      }
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务器未启动');
    origin = `http://127.0.0.1:${address.port}`;
    const client = new StoreClient(origin, {
      userAgent: 'test',
      cookieHeader: async () => '',
      run: async (operation) => operation(),
    });
    const course: Course = {
      id: 'course',
      title: '课程',
      url: origin,
      appId: 'app',
      resourceType: 50,
    };
    const entries: Pick<Content, 'id' | 'title' | 'kind'>[] = [
      { id: 'gap', title: '未下载', kind: 'unknown' },
      { id: 'article', title: '图文:标题', kind: 'text' },
      { id: 'document', title: '文档', kind: 'document' },
    ];
    const contents: Content[] = entries.map((item) => ({
      ...item,
      courseId: 'course',
      url: origin,
      subCourseId: '',
      chapter: [],
      available: true,
    }));
    const mediaHttp = new MediaHttp({ retries: 0 });
    const options = {
      http: mediaHttp,
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
      concurrency: 2,
      selectedIds: new Set(['article', 'document']),
      resolve: async () => {
        throw new Error('图文文档不能调用媒体解析器');
      },
      resolveArticle: (content: Content) => resolveArticleSource(client, content, mediaHttp),
      resolveDocuments: (content: Content) => resolveDocumentSources(client, content),
    };
    const directory = path.join(root, 'course');
    const placeholders = await downloadCourse(course, contents, directory, {
      ...options,
      catalogOnly: true,
    });
    expect(placeholders.map((result) => result.files[0]?.name)).toEqual([
      '02-图文 标题.text.placeholder',
      '03-文档.document.placeholder',
    ]);
    expect(requests).toBe(0);
    const failed = await downloadCourse(course, contents, directory, options);
    expect(failed.map((result) => result.status)).toEqual(['failed', 'failed']);
    for (const result of placeholders)
      expect((await fsp.stat(path.join(directory, result.files[0]?.name ?? ''))).size).toBe(0);
    expect((await fsp.readdir(directory)).some((name) => name.startsWith('.xiaoe-part-'))).toBe(
      false,
    );
    const requestsAfterFailure = requests;
    const catalogAgain = await downloadCourse(course, contents, directory, {
      ...options,
      catalogOnly: true,
    });
    expect(catalogAgain.map((result) => result.status)).toEqual(['placeholder', 'placeholder']);
    expect(requests).toBe(requestsAfterFailure);
    broken = false;
    const results = await downloadCourse(course, contents, directory, options);
    expect(results.map((result) => result.status)).toEqual(['done', 'done']);
    expect(results[0]?.files.map((file) => file.name)).toEqual([
      '02-图文 标题.html',
      '02-图文 标题（图片01）.png',
      '02-图文 标题（附件1）.pdf',
    ]);
    expect(results[1]?.files[0]?.name).toBe('03-文档.pdf');
    expect(await fsp.readFile(path.join(directory, '03-文档.pdf'))).toEqual(pdf);
    const html = await fsp.readFile(path.join(directory, '02-图文 标题.html'), 'utf8');
    const $ = cheerio.load(html);
    expect($('article').text()).toContain('完整正文');
    expect($('script, [onerror], [data-src]').length).toBe(0);
    expect(html).not.toContain('signature=secret');
    expect(html).not.toContain('试看');
    for (const image of $('img').toArray())
      expect(
        await fsp.readFile(path.join(directory, decodeURIComponent($(image).attr('src') ?? ''))),
      ).toEqual(png);
    const names = await fsp.readdir(directory);
    expect(
      names.some(
        (name) =>
          name.endsWith('.placeholder') ||
          name.startsWith('.xiaoe-part-') ||
          name.startsWith('.xiaoe-artifact-'),
      ),
    ).toBe(false);
    const previousRequests = requests;
    await downloadCourse(course, contents, directory, options);
    expect(requests).toBe(previousRequests);
    await fsp.rm(path.join(directory, '02-图文 标题（图片01）.png'));
    const repaired = await downloadCourse(course, contents, directory, options);
    expect(repaired.map((result) => result.status)).toEqual(['done', 'done']);
    expect((await fsp.readdir(directory)).some((name) => name.includes('.incomplete-'))).toBe(true);

    const recoverDirectory = path.join(root, 'recover');
    const doc = contents[2];
    if (!doc) throw new Error('测试文档缺失');
    await publishArtifactFiles(recoverDirectory, doc.id, async (staging) => {
      await fsp.writeFile(path.join(staging, '03-文档.pdf'), pdf);
      return [{ name: '03-文档.pdf', size: pdf.length }];
    });
    const recovered = await downloadCourse(course, contents, recoverDirectory, {
      ...options,
      selectedIds: new Set(['document']),
      resolveDocuments: async () => {
        throw new Error('已完整发布的文件无需重新解析');
      },
    });
    expect(recovered[0]?.status).toBe('done');
    expect((await fsp.readdir(recoverDirectory)).sort()).toEqual([
      '.xiaoe-manifest.json',
      '03-文档.pdf',
    ]);

    const partialDirectory = path.join(root, 'partial');
    await publishArtifactFiles(partialDirectory, doc.id, async (staging) => {
      await fsp.writeFile(path.join(staging, 'first.pdf'), pdf);
      await fsp.writeFile(path.join(staging, 'second.pdf'), pdf);
      return ['first.pdf', 'second.pdf'].map((name) => ({ name, size: pdf.length }));
    });
    await fsp.unlink(path.join(partialDirectory, 'second.pdf'));
    const partial = await downloadCourse(course, contents, partialDirectory, {
      ...options,
      selectedIds: new Set(['document']),
    });
    expect(partial[0]?.status).toBe('done');
    expect((await fsp.readdir(partialDirectory)).sort()).toEqual([
      '.xiaoe-manifest.json',
      '03-文档.pdf',
    ]);

    const collisionDirectory = path.join(root, 'collision');
    await fsp.mkdir(collisionDirectory);
    await fsp.writeFile(path.join(collisionDirectory, 'second.pdf'), '用户文件');
    await expect(
      publishArtifactFiles(collisionDirectory, 'collision', async (staging) => {
        for (const name of ['first.pdf', 'second.pdf'])
          await fsp.writeFile(path.join(staging, name), pdf);
        return ['first.pdf', 'second.pdf'].map((name) => ({ name, size: pdf.length }));
      }),
    ).rejects.toThrow();
    expect(await fsp.readdir(collisionDirectory)).toEqual(['second.pdf']);
    expect(await fsp.readFile(path.join(collisionDirectory, 'second.pdf'), 'utf8')).toBe(
      '用户文件',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(root, { recursive: true, force: true });
  }
});
