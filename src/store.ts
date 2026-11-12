import * as cheerio from 'cheerio';

import { AuthenticationError, loginRejected } from './auth';
import { parsePurchases } from './catalog';
import { asRecord, stringField } from './model';

import type { LoginSession } from './auth';
import type { Course } from './model';

/** fetch 店铺客户端：使用本地登录态，认证失效时重新获取一次并重试。 */
export class StoreClient {
  readonly origin: string;
  private readonly session: LoginSession;
  private readonly referer: string;

  /** 创建店铺客户端。
   * @param storeUrl 购买记录或课程地址。
   * @param session 脱离浏览器的登录会话。
   */
  constructor(storeUrl: string, session: LoginSession) {
    this.origin = new URL(storeUrl).origin;
    this.referer = storeUrl;
    this.session = session;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    if (new URL(url).origin !== this.origin) throw new Error('店铺 API 不允许向其他源发送登录态');
    const cookie = await this.session.cookieHeader(url);
    const response = await fetch(url, {
      ...init,
      headers: {
        'user-agent': this.session.userAgent,
        referer: this.referer,
        origin: this.origin,
        ...(cookie ? { cookie } : {}),
        ...Object.fromEntries(new Headers(init.headers)),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '';
      await response.body?.cancel();
      if (/login|signin|passport|登录/i.test(location))
        throw new AuthenticationError('店铺请求跳转到登录页');
      throw new Error('店铺请求发生未知跳转');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status))
        throw new AuthenticationError(`店铺认证 HTTP ${response.status}`);
      throw new Error(`店铺 API HTTP ${response.status}`);
    }
    return response;
  }

  private async json(url: string, init: RequestInit = {}): Promise<unknown> {
    return this.session.run(async () => {
      const response = await this.request(url, init);
      if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
        const $ = cheerio.load(await response.text());
        if (/登[录陆]|login/i.test($('title').text()) || $('form[action*="login"]').length > 0)
          throw new AuthenticationError('店铺 API 返回登录页');
        throw new Error('店铺 API 返回 HTML，接口格式可能变化');
      }
      const value: unknown = await response.json();
      if (loginRejected(value)) throw new AuthenticationError('店铺接口报告登录态失效');
      return value;
    });
  }

  /** 使用 fetch 和 cheerio 读取页面标题；登录页触发一次认证刷新。
   * @param url 同源页面地址。
   * @returns 页面标题。
   * @throws 刷新后仍未登录、未知跳转或 HTML 无效时抛错。
   */
  async pageTitle(url: string): Promise<string> {
    return this.session.run(async () => {
      const response = await this.request(url);
      const $ = cheerio.load(await response.text());
      const title = $('title').text().trim();
      if (/^(?:登录|登陆|login|用户登录)$/i.test(title) || $('form[action*="login"]').length > 0)
        throw new AuthenticationError('目标页面未登录');
      if (!title) throw new Error('目标页面 HTML 格式变化');
      return title;
    });
  }

  /** 按页面真实的 lastId 偏移读取所有懒加载分页，空页才确认结束。
   * @returns 去重后的全部已购课程。
   * @throws 未登录、响应变化、重复分页或分页上限时抛错。
   */
  async purchasedCourses(): Promise<Course[]> {
    const courses = new Map<string, Course>();
    let offset = 0;
    for (let page = 0; page < 2000; page += 1) {
      const value = await this.json(`${this.origin}/payRecords?lastId=${offset}`);
      const batch = parsePurchases(value, this.origin);
      if (batch.length === 0) {
        if (courses.size === 0) throw new Error('购买列表为空，请确认当前登录账号已购买课程');
        return [...courses.values()];
      }
      let added = 0;
      for (const course of batch) {
        if (!courses.has(course.id)) added += 1;
        courses.set(course.id, course);
      }
      if (added === 0) throw new Error('购买记录分页重复，无法证明列表完整');
      offset += batch.length;
    }
    throw new Error('购买记录超过分页上限');
  }

  /** 原始 GET JSON API，供直播接口和后续类型复用。
   * @param endpoint 同源相对 API 地址。
   * @param query 查询字段。
   * @returns 通过业务状态检查的 JSON；有 data 字段时返回 data。
   * @throws HTTP、登录或业务错误时抛错。
   */
  async get(endpoint: string, query: Record<string, string | number> = {}): Promise<unknown> {
    const url = new URL(endpoint, this.origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const value = await this.json(url.href);
    const record = asRecord(value);
    if (record && record.code !== undefined && record.code !== 0)
      throw new Error(`店铺接口失败：${stringField(record, 'msg')}`);
    return record && 'data' in record ? record.data : value;
  }

  /** 原始 fetch 调用小鹅通 JSON API，支持 bizData 表单与播放 JSON 请求。
   * @param endpoint 同源 API 路径。
   * @param data 业务字段。
   * @param json 是否使用 JSON 请求体，默认 bizData 表单。
   * @returns 经业务状态验证的 data 字段。
   * @throws HTTP、登录、业务状态或响应格式错误时抛错。
   */
  async api(endpoint: string, data: Record<string, unknown>, json = false): Promise<unknown> {
    const form = new URLSearchParams();
    if (!json)
      for (const [key, value] of Object.entries(data)) form.set(`bizData[${key}]`, String(value));
    const value = await this.json(new URL(endpoint, this.origin).href, {
      method: 'POST',
      headers: {
        'content-type': json
          ? 'application/json'
          : 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: json ? JSON.stringify(data) : form.toString(),
    });
    const record = asRecord(value);
    if (!record || record.code !== 0)
      throw new Error(`店铺接口失败：${record ? stringField(record, 'msg') : '非 JSON 对象'}`);
    return record.data;
  }
}
