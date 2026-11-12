import { describe, expect, it } from 'vitest';

import * as cheerio from 'cheerio';

import { resolveArticleSource, resolveDocumentSources } from './content-source';
import { MediaHttp } from './http';
import { StoreClient } from './store';

import type { Content } from './model';

const article: Content = {
  id: 'article',
  title: '正文',
  kind: 'text',
  url: 'https://store.test/article',
  courseId: 'course',
  subCourseId: '',
  chapter: [],
  available: true,
};
function client(): StoreClient {
  return new StoreClient('https://store.test', {
    userAgent: 'test',
    cookieHeader: async () => '',
    run: async (operation) => operation(),
  });
}

describe('图文和文档源', () => {
  it('签名正文使用 JSON 根级参数、备用线路及素材 ID 映射，绝不使用试看正文', async () => {
    const store = client();
    const http = new MediaHttp();
    const calls: string[] = [];
    store.api = async (endpoint, data, json) => {
      calls.push(endpoint);
      if (endpoint.includes('subscribe.get')) return { is_subscribe: 1 };
      if (endpoint.includes('get.detail'))
        return {
          signature: 'signed',
          try_org_content: '试看',
          org_content: '素材标记',
          auto_fetch: 1,
        };
      if (endpoint === '/xe.richtext.info.get_by_signature.bath') {
        expect(data).toEqual({ signatures: ['signed'] });
        expect(json).toBe(true);
        return {
          sign_list: [
            { signature: 'signed', url: ['https://cdn.test/bad', 'https://cdn.test/body'] },
          ],
        };
      }
      expect(endpoint).toBe('/xe.richtext.material.info.get_by_signature.bath');
      expect(data).toEqual({ signature: 'signed', material_ids: ['image-id', 'file-id'] });
      expect(json).toBe(true);
      return {
        material_list: [
          { material_id: 'image-id', url: 'https://cdn.test/image.jpg' },
          { material_id: 'file-id', url: 'https://cdn.test/file.pdf' },
        ],
      };
    };
    http.html = async (url) => {
      if (url.endsWith('bad')) throw new Error('线路失败');
      return '<p>完整正文</p><img data-cos="1" src="image-id" data-src="image-id"><a data-file data-cos="1" href="file-id">附件</a>';
    };
    const source = await resolveArticleSource(store, article, http);
    const $ = cheerio.load(source.html);
    expect($('img').attr('src')).toBe('https://cdn.test/image.jpg');
    expect($('a').attr('href')).toBe('https://cdn.test/file.pdf');
    expect(source.baseUrl).toBe('https://cdn.test/body');
    expect(source.html).not.toContain('试看');
    expect(calls).toHaveLength(4);
  });
  it('缺少完整正文或未订阅时失败，不回退到 try_* 字段', async () => {
    const store = client();
    store.api = async (endpoint) =>
      endpoint.includes('subscribe.get')
        ? { is_subscribe: 1 }
        : { org_content: '', try_org_content: '<p>试看</p>' };
    await expect(resolveArticleSource(store, article, new MediaHttp())).rejects.toThrow(
      '正式正文为空',
    );
    store.api = async () => ({ is_subscribe: 0 });
    await expect(resolveArticleSource(store, article, new MediaHttp())).rejects.toThrow('未订阅');
  });
  it('签名素材缺失时失败，不能将素材 ID 当作可下载 URL', async () => {
    const store = client();
    store.api = async (endpoint) => {
      if (endpoint.includes('subscribe.get')) return { is_subscribe: 1 };
      if (endpoint.includes('get.detail')) return { signature: 'signed' };
      if (endpoint === '/xe.richtext.info.get_by_signature.bath')
        return { sign_list: [{ signature: 'signed', url: ['https://cdn.test/body'] }] };
      return { material_list: [] };
    };
    const http = new MediaHttp();
    http.html = async () => '<img data-cos="1" src="unresolved-id">';
    await expect(resolveArticleSource(store, article, http)).rejects.toThrow('部分签名素材');
  });
  it('文档仅使用允许下载的原文件，拒绝预览替代和禁用下载', async () => {
    const store = client();
    const document: Content = { ...article, kind: 'document' };
    store.api = async () => ({
      is_subscribe: 1,
      is_download: 1,
      is_ban: 0,
      file_name: '原件.pdf',
      file_url: 'https://cdn.test/original.pdf',
      preview_url: 'https://cdn.test/preview.pdf',
    });
    expect(await resolveDocumentSources(store, document)).toEqual([
      { filename: '原件.pdf', url: 'https://cdn.test/original.pdf' },
    ]);
    store.api = async () => ({
      is_subscribe: 1,
      is_download: 0,
      is_ban: 0,
      file_name: '原件.pdf',
      file_url: 'https://cdn.test/original.pdf',
    });
    await expect(resolveDocumentSources(store, document)).rejects.toThrow('未开放原文件下载');
    store.api = async () => ({
      is_subscribe: 1,
      is_download: 1,
      is_ban: 0,
      preview_url: 'https://cdn.test/preview.pdf',
    });
    await expect(resolveDocumentSources(store, document)).rejects.toThrow('缺少原文件');
  });
});
