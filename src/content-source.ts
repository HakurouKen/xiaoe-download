import * as cheerio from 'cheerio';

import { asRecord, stringField } from './model';

import type { MediaHttp } from './http';
import type { ArticleSource, Content, DocumentSource } from './model';
import type { StoreClient } from './store';

function httpUrl(value: string, base: string): string {
  if (!value.trim()) throw new Error('内容地址为空');
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('内容地址必须为 HTTP(S)');
  return url.href;
}

/** 获取已授权图文全文；仅使用正式正文，签名富文本按一方客户端的素材映射解析。
 * @param client 当前店铺客户端。
 * @param content 图文资源及所属课程。
 * @param http 按 URL 隔离登录态的正文下载客户端。
 * @returns 正文 HTML 和解析相对素材地址的基准 URL。
 * @throws 未订阅、只有试看、正文或签名素材缺失、接口变化时抛错。
 */
export async function resolveArticleSource(
  client: StoreClient,
  content: Content,
  http: MediaHttp,
): Promise<ArticleSource> {
  if (!content.available) throw new Error('图文尚未解锁或无访问权限');
  const hasParent = content.courseId && content.courseId !== content.id;
  const access = asRecord(
    hasParent
      ? await client.api('/xe.course.business.e_course.subscribe.get/1.0.0', {
          course_id: content.courseId,
        })
      : await client.api('/xe.course.business_go.subscribe.check.get/2.0.0', {
          resource_id: content.id,
          product_id: content.courseId,
        }),
  );
  if (String(access?.is_subscribe) !== '1') throw new Error('图文未订阅，拒绝将试看当作全文');
  const detail = asRecord(
    await client.api('/xe.course.business_go.get.detail/2.0.0', {
      resource_id: content.id,
      product_id: content.courseId,
    }),
  );
  if (!detail) throw new Error('图文详情响应无效');
  const signature = stringField(detail, 'signature');
  let baseUrl = content.url || client.origin;
  let html = stringField(detail, 'org_content');
  const contentUrl = stringField(detail, 'content_url');
  if (signature) {
    const signed = asRecord(
      await client.api(
        '/xe.richtext.info.get_by_signature.bath',
        { signatures: [signature] },
        true,
      ),
    );
    const entry = Array.isArray(signed?.sign_list)
      ? signed.sign_list.map(asRecord).find((item) => item?.signature === signature)
      : undefined;
    if (!entry || !Array.isArray(entry.url) || entry.url.length === 0)
      throw new Error('签名图文没有正文地址');
    let resolved = false;
    for (const candidate of entry.url) {
      if (typeof candidate !== 'string') throw new Error('签名图文地址结构无效');
      try {
        baseUrl = httpUrl(candidate, client.origin);
        html = await http.html(baseUrl);
        if (html.trim()) {
          resolved = true;
          break;
        }
      } catch {
        /* 一方客户端提供多线路，逐个尝试；全部失败再报告。 */
      }
    }
    if (!resolved) throw new Error('签名图文所有正文线路均不可用');
  } else if (contentUrl) {
    baseUrl = httpUrl(contentUrl, client.origin);
    html = await http.html(baseUrl);
  } else if (String(detail.auto_fetch) === '1') {
    throw new Error('图文使用签名正文但缺少有效签名或地址');
  }
  if (!html.trim()) throw new Error('图文正式正文为空，拒绝使用试看字段');
  const $ = cheerio.load(html);
  if (
    /^(?:登录|登陆|login|用户登录)$/i.test($('title').text().trim()) ||
    $('form[action*="login"]').length
  )
    throw new Error('图文正文返回登录页');
  const materials = new Map<string, string>();
  $('img[data-cos="1"], a[data-file][data-cos="1"]').each((_, element) => {
    const item = $(element);
    const id = item.attr(element.tagName === 'img' ? 'src' : 'href');
    if (id && !/^https?:/i.test(id)) materials.set(id, '');
  });
  if (materials.size > 0) {
    if (!signature) throw new Error('图文素材标识缺少签名，无法还原原文件');
    const response = asRecord(
      await client.api(
        '/xe.richtext.material.info.get_by_signature.bath',
        {
          signature,
          material_ids: [...materials.keys()],
        },
        true,
      ),
    );
    if (!Array.isArray(response?.material_list)) throw new Error('图文签名素材响应无效');
    for (const value of response.material_list) {
      const material = asRecord(value);
      if (!material) continue;
      const id = stringField(material, 'material_id');
      if (materials.has(id))
        materials.set(id, httpUrl(stringField(material, 'url'), client.origin));
    }
    if ([...materials.values()].some((url) => !url)) throw new Error('图文部分签名素材无法解析');
    $('img[data-cos="1"], a[data-file][data-cos="1"]').each((_, element) => {
      const item = $(element);
      const attribute = element.tagName === 'img' ? 'src' : 'href';
      const url = materials.get(item.attr(attribute) ?? '');
      if (url) item.attr(attribute, url).removeAttr('data-src').removeAttr('data-href');
    });
  }
  return { html: $('body').html() ?? '', baseUrl };
}

/** 获取允许下载的文档原文件，禁止用封面或预览文件代替。
 * @param client 当前店铺客户端。
 * @param content 文档资源及所属课程。
 * @returns 原文件下载描述，扩展名由原文件名决定。
 * @throws 未授权、禁用下载、原文件字段缺失或接口变化时抛错。
 */
export async function resolveDocumentSources(
  client: StoreClient,
  content: Content,
): Promise<DocumentSource[]> {
  if (!content.available) throw new Error('文档尚未解锁或无访问权限');
  const detail = asRecord(
    await client.api(
      '/xe.course.business.e_course.document_info.get/1.0.0',
      {
        bizData: { resource_id: content.id, product_id: content.courseId },
      },
      true,
    ),
  );
  if (
    !detail ||
    String(detail.is_subscribe) !== '1' ||
    String(detail.is_download) !== '1' ||
    String(detail.is_ban) !== '0'
  )
    throw new Error('文档未订阅、被禁用或未开放原文件下载');
  const filename = stringField(detail, 'file_name');
  const url = stringField(detail, 'file_url');
  if (!filename || !url) throw new Error('文档详情缺少原文件名或地址');
  return [{ filename, url: httpUrl(url, client.origin) }];
}
