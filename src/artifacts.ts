import fsp from 'node:fs/promises';
import path from 'node:path';

import * as cheerio from 'cheerio';

import { publishArtifactFiles } from './artifact-files';

import type { DownloadedFile } from './downloader';
import type { MediaHttp } from './http';
import type { ArticleSource, Content, DocumentSource } from './model';

async function fileEdges(filename: string): Promise<{ head: Buffer; tail: Buffer; size: number }> {
  const file = await fsp.open(filename, 'r');
  try {
    const { size } = await file.stat();
    const head = Buffer.alloc(Math.min(size, 4096));
    const tail = Buffer.alloc(Math.min(size, 65557));
    await file.read(head, 0, head.length, 0);
    await file.read(tail, 0, tail.length, size - tail.length);
    return { head, tail, size };
  } finally {
    await file.close();
  }
}

async function imageExtension(filename: string): Promise<string> {
  const { head, tail, size } = await fileEdges(filename);
  if (
    head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) &&
    tail.subarray(-2).equals(Buffer.from([0xff, 0xd9]))
  )
    return '.jpg';
  if (
    head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    tail.subarray(-8, -4).toString() === 'IEND'
  )
    return '.png';
  if (/^GIF8[79]a/.test(head.toString('ascii', 0, 6)) && tail[tail.length - 1] === 0x3b)
    return '.gif';
  if (
    head.toString('ascii', 0, 4) === 'RIFF' &&
    head.toString('ascii', 8, 12) === 'WEBP' &&
    head.readUInt32LE(4) + 8 === size
  )
    return '.webp';
  if (head.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(head.toString('ascii', 8, 40)))
    return '.avif';
  if (head.toString('ascii', 0, 2) === 'BM' && head.length >= 14 && head.readUInt32LE(2) === size)
    return '.bmp';
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(head.toString('utf8'))) {
    const xml = await fsp.readFile(filename, 'utf8');
    const $ = cheerio.load(xml, { xmlMode: true });
    if (
      $('svg').length !== 1 ||
      !/<\/svg>\s*$/i.test(xml) ||
      $('script, foreignObject').length ||
      /(?:href\s*=\s*['"](?:https?:|\/\/)|url\(\s*['"]?(?:https?:|\/\/))/i.test(xml)
    )
      throw new Error('SVG 图片包含未保存的外部素材或无效内容');
    return '.svg';
  }
  throw new Error('内嵌图片格式无效、损坏或返回错误页');
}

/** 校验文档原格式和文件头尾；长度由流式 HTTP 与可选接口大小共同校验。
 * @param filename 本地暂存文档。
 * @param extension 原文件扩展名。
 * @param expectedSize 接口提供的可选原文件字节数。
 * @returns 文档校验完成。
 * @throws 类型不符、截断、错误页或尚未支持的格式时抛错。
 */
export async function verifyDocument(
  filename: string,
  extension: string,
  expectedSize?: number,
): Promise<void> {
  const { head, tail, size } = await fileEdges(filename);
  if (
    !size ||
    (expectedSize !== undefined &&
      (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize !== size))
  )
    throw new Error('文档为空或原文件大小不完整');
  const prefix = head.toString('utf8');
  if (
    /^\s*(?:<!doctype\s+html|<html\b|<\?xml[^>]*>\s*<Error\b|<Error\b|\{\s*"(?:code|msg|error)")/i.test(
      prefix,
    )
  )
    throw new Error('文档地址返回错误页');
  const ext = extension.toLowerCase();
  if (ext === '.pdf') {
    if (!prefix.startsWith('%PDF-') || !tail.subarray(-2048).includes(Buffer.from('%%EOF')))
      throw new Error('PDF 文件头或结束标记无效');
  } else if (['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.epub', '.zip'].includes(ext)) {
    if (
      !head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) ||
      !tail.includes(Buffer.from([0x50, 0x4b, 5, 6]))
    )
      throw new Error('文档 ZIP 容器不完整');
  } else if (['.doc', '.xls', '.ppt'].includes(ext)) {
    if (
      !head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) ||
      size < 512 ||
      size % 512 !== 0
    )
      throw new Error('Office 文档格式不完整');
  } else if (ext === '.rtf') {
    if (!prefix.startsWith('{\\rtf') || !tail.toString('utf8').trimEnd().endsWith('}'))
      throw new Error('RTF 文档不完整');
  } else if (['.txt', '.csv', '.md'].includes(ext)) {
    // 文本文件验证编码和二进制误响应，不把任意字节文件当作正文。
    const bytes = await fsp.readFile(filename);
    if (bytes.includes(0)) throw new Error('文本文件包含二进制内容');
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } else throw new Error(`尚未支持文档格式：${ext || '无扩展名'}`);
}

async function stageDocument(
  source: DocumentSource,
  staging: string,
  baseName: string,
  http: MediaHttp,
): Promise<DownloadedFile> {
  const extension = path.extname(source.filename).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) throw new Error('文档原文件扩展名无效');
  const name = `${baseName}${extension}`;
  const filename = path.join(staging, name);
  const size = await http.download(source.url, filename);
  await verifyDocument(filename, extension, source.size);
  return { name, size };
}

/** 下载文档原文件及全部附件，所有文件校验完成后作为同一资源发布。
 * @param sources 已授权的原文件描述。
 * @param content 文档资源。
 * @param directory 课程目录。
 * @param baseName 已分配的编号标题。
 * @param http 流式下载客户端。
 * @returns 原文件和附件的名称与大小。
 * @throws 空来源、下载、格式校验或发布失败时抛错。
 */
export async function downloadDocuments(
  sources: DocumentSource[],
  content: Content,
  directory: string,
  baseName: string,
  http: MediaHttp,
): Promise<DownloadedFile[]> {
  return publishArtifactFiles(directory, content.id, async (staging) => {
    const files: DownloadedFile[] = [];
    for (const [index, source] of sources.entries())
      files.push(
        await stageDocument(
          source,
          staging,
          sources.length === 1 ? baseName : `${baseName}（附件${index + 1}）`,
          http,
        ),
      );
    return files;
  });
}

function bestSrcset(value: string): string {
  return (
    value
      .split(',')
      .map((candidate) => {
        const [url = '', size = '1x'] = candidate.trim().split(/\s+/);
        return { url, rank: Number.parseFloat(size) || 1 };
      })
      .sort((a, b) => b.rank - a.rank)[0]?.url ?? ''
  );
}

/** 保存离线图文 HTML、原图及正文中的文档附件，重写所有本地素材链接。
 * @param source 已授权全文 HTML 及素材基准 URL。
 * @param content 图文资源及显示标题。
 * @param directory 课程目录。
 * @param baseName 已分配的编号标题。
 * @param http 图片和附件下载客户端。
 * @returns HTML、图片和附件的名称与大小。
 * @throws 正文为空、嵌入媒体无法离线保存、素材下载或验证失败时抛错。
 */
export async function downloadArticle(
  source: ArticleSource,
  content: Content,
  directory: string,
  baseName: string,
  http: MediaHttp,
): Promise<DownloadedFile[]> {
  return publishArtifactFiles(directory, content.id, async (staging) => {
    const $ = cheerio.load(source.html);
    if ($('iframe, video, audio, embed, object').length)
      throw new Error('图文包含嵌入音视频或外部预览，尚不能完整离线保存');
    $('script, style, link, base, meta, form').remove();
    $('*').each((_, element) => {
      if (!('attribs' in element)) return;
      for (const name of Object.keys(element.attribs))
        if (/^on/i.test(name)) $(element).removeAttr(name);
    });
    const files: DownloadedFile[] = [];
    const images = new Map<string, string>();
    const localize = async (raw: string): Promise<string> => {
      const data = raw.match(
        /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,([a-z0-9+/]+={0,2})$/i,
      );
      const url = data ? undefined : new URL(raw, source.baseUrl);
      if (url && !['http:', 'https:'].includes(url.protocol)) throw new Error('图片素材地址无效');
      const key = url?.href ?? raw;
      const known = images.get(key);
      if (known) return known;
      const part = path.join(staging, `image-${images.size + 1}.part`);
      let size: number;
      if (data?.[1]) {
        const bytes = Buffer.from(data[1], 'base64');
        await fsp.writeFile(part, bytes, { mode: 0o600 });
        size = bytes.length;
      } else {
        if (!url) throw new Error('图片素材地址无效');
        size = await http.download(url.href, part);
      }
      const extension = await imageExtension(part);
      const name = `${baseName}（图片${String(images.size + 1).padStart(2, '0')}）${extension}`;
      await fsp.rename(part, path.join(staging, name));
      files.push({ name, size });
      const local = encodeURIComponent(name);
      images.set(key, local);
      return local;
    };
    for (const element of $('img').toArray()) {
      const image = $(element);
      const raw =
        image.attr('data-src') ||
        image.attr('data-original') ||
        image.attr('data-lazy-src') ||
        bestSrcset(image.attr('srcset') ?? '') ||
        bestSrcset(image.closest('picture').find('source').first().attr('srcset') ?? '') ||
        image.attr('src');
      if (!raw) throw new Error('图文图片缺少原图地址');
      image
        .attr('src', await localize(raw))
        .removeAttr('srcset')
        .removeAttr('data-src')
        .removeAttr('data-original')
        .removeAttr('data-lazy-src')
        .removeAttr('data-cos')
        .removeAttr('loading');
      image.closest('picture').find('source').remove();
    }
    for (const element of $('[style]').toArray()) {
      let style = $(element).attr('style') ?? '';
      for (const match of style.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
        if (match[2]) style = style.replace(match[0], `url("${await localize(match[2])}")`);
      }
      if (/expression\s*\(|@import|behavior\s*:/i.test(style)) $(element).removeAttr('style');
      else $(element).attr('style', style);
    }
    let attachments = 0;
    for (const element of $('a[href]').toArray()) {
      const link = $(element);
      const href = link.attr('href') ?? '';
      if (href.startsWith('#')) continue;
      const url = new URL(href, source.baseUrl);
      if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
        link.removeAttr('href');
        continue;
      }
      if (link.attr('data-file') !== undefined) {
        const filename =
          link.attr('download') ||
          link.attr('data-file-name') ||
          decodeURIComponent(path.basename(url.pathname));
        const file = await stageDocument(
          { url: url.href, filename },
          staging,
          `${baseName}（附件${++attachments}）`,
          http,
        );
        files.push(file);
        link
          .attr('href', encodeURIComponent(file.name))
          .removeAttr('data-href')
          .removeAttr('data-cos');
      } else link.attr('href', url.href).attr('rel', 'noopener noreferrer');
    }
    if (!$('body').text().trim() && !$('img').length) throw new Error('图文正文没有可保存的内容');
    const page = cheerio.load(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title></title><style>body{margin:0 auto;max-width:960px;padding:24px;font:18px/1.8 system-ui,sans-serif;color:#222}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}h1{font-size:1.6em}</style></head><body><main><h1></h1><article></article></main></body></html>`,
    );
    page('title, h1').text(content.title);
    page('article').html($('body').html() ?? '');
    const name = `${baseName}.html`;
    const html = page.html();
    await fsp.writeFile(path.join(staging, name), html, { mode: 0o600 });
    return [{ name, size: Buffer.byteLength(html) }, ...files];
  });
}
