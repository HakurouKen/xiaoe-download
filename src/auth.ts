import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { readChromeLogin } from './chrome';
import { cookieHeader } from './cookies';
import { asRecord } from './model';

import type { LoginCookie, LoginSnapshot } from './cookies';

/** 服务端明确拒绝登录态时使用，区别于课程权限和普通请求错误。 */
export class AuthenticationError extends Error {}

/** HTTP 客户端所需登录态，支持一次认证失败重试，无浏览器生命周期依赖。 */
export interface LoginSession {
  readonly userAgent: string;
  cookieHeader: (url: string) => Promise<string>;
  run: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** 登录态缓存和 Chrome 获取配置。 */
export interface LoginOptions {
  endpoint: string;
  storeUrl: string;
  cacheFile?: string;
  forceRefresh?: boolean;
  readLogin?: () => Promise<LoginSnapshot>;
  log?: (message: string) => void;
}

function parseSnapshot(value: unknown, origin: string): LoginSnapshot | undefined {
  const record = asRecord(value);
  if (
    !record ||
    record.version !== 1 ||
    record.origin !== origin ||
    typeof record.userAgent !== 'string' ||
    !record.userAgent ||
    typeof record.capturedAt !== 'number' ||
    !Number.isFinite(record.capturedAt) ||
    !Array.isArray(record.cookies)
  )
    return undefined;
  const cookies: LoginCookie[] = [];
  const hostname = new URL(origin).hostname;
  for (const item of record.cookies) {
    const cookie = asRecord(item);
    if (
      !cookie ||
      typeof cookie.name !== 'string' ||
      !cookie.name ||
      /[\s=;\r\n]/.test(cookie.name) ||
      typeof cookie.value !== 'string' ||
      /[;\r\n]/.test(cookie.value) ||
      typeof cookie.domain !== 'string' ||
      !cookie.domain ||
      typeof cookie.path !== 'string' ||
      !cookie.path.startsWith('/') ||
      typeof cookie.secure !== 'boolean' ||
      typeof cookie.expires !== 'number' ||
      !Number.isFinite(cookie.expires) ||
      (cookie.expires < 0 && cookie.expires !== -1)
    )
      return undefined;
    const domain = cookie.domain.toLowerCase();
    if (
      !(domain.startsWith('.')
        ? hostname === domain.slice(1) || hostname.endsWith(domain)
        : hostname === domain)
    )
      return undefined;
    cookies.push({
      name: cookie.name,
      value: cookie.value,
      domain,
      path: cookie.path,
      secure: cookie.secure,
      expires: cookie.expires,
    });
  }
  return {
    version: 1,
    origin,
    userAgent: record.userAgent,
    capturedAt: record.capturedAt,
    cookies,
  };
}

/** 生成按店铺隔离的默认缓存路径，不含原始域名或凭据。
 * @param storeUrl 店铺 URL。
 * @returns 当前项目 .cache/cookies 下的 JSON 路径。
 */
export function defaultCookieCache(storeUrl: string): string {
  const key = crypto
    .createHash('sha256')
    .update(new URL(storeUrl).origin)
    .digest('hex')
    .slice(0, 24);
  return path.resolve('.cache', 'cookies', `${key}.json`);
}

/** 优先加载本地 Cookie；缺失、损坏、过期或强制刷新时通过 Puppeteer 获取。
 * @param options 店铺、浏览器地址、缓存路径及可选获取适配器。
 * @returns 脱离浏览器的登录会话；认证失败时只刷新一次，并发失败共享刷新。
 * @throws Chrome 获取失败、缓存无法安全保存或刷新后仍未登录时抛错。
 */
export async function loadLoginSession(options: LoginOptions): Promise<LoginSession> {
  const origin = new URL(options.storeUrl).origin;
  const cacheFile = path.resolve(options.cacheFile ?? defaultCookieCache(options.storeUrl));
  const readLogin =
    options.readLogin ?? (() => readChromeLogin(options.endpoint, options.storeUrl));
  async function acquire(): Promise<LoginSnapshot> {
    options.log?.('从现有 Chrome 获取登录态…');
    const snapshot = parseSnapshot(await readLogin(), origin);
    if (!snapshot || !cookieHeader(snapshot.cookies, options.storeUrl))
      throw new Error('Chrome 未返回当前店铺的有效登录态');
    const directory = path.dirname(cacheFile);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.cookie-${crypto.randomUUID()}.tmp`);
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600, flag: 'wx' });
      await fsp.rename(temporary, cacheFile);
    } finally {
      await fsp.rm(temporary, { force: true });
    }
    options.log?.('登录态已缓存，Chrome 调试连接已断开。');
    return snapshot;
  }
  let snapshot: LoginSnapshot | undefined;
  if (!options.forceRefresh) {
    try {
      const value: unknown = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
      snapshot = parseSnapshot(value, origin);
      if (snapshot && !cookieHeader(snapshot.cookies, options.storeUrl)) snapshot = undefined;
      if (snapshot) {
        await fsp.chmod(cacheFile, 0o600);
        options.log?.('使用本地 Cookie 缓存。');
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && asRecord(error)?.code !== 'ENOENT')
        throw new Error('无法读取 Cookie 缓存，请检查文件权限或指定其他 --cookie-cache 路径');
    }
  }
  let current = snapshot ?? (await acquire());
  let revision = 0;
  let refreshed = false;
  let refreshing: Promise<void> | undefined;
  return {
    get userAgent() {
      return current.userAgent;
    },
    cookieHeader: async (url) => cookieHeader(current.cookies, url),
    run: async <T>(operation: () => Promise<T>): Promise<T> => {
      const observedRevision = revision;
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof AuthenticationError)) throw error;
        if (revision === observedRevision) {
          if (!refreshing) {
            if (refreshed) throw error;
            refreshed = true;
            options.log?.('登录态被拒绝，重新获取一次后重试…');
            refreshing = (async () => {
              current = await acquire();
              revision += 1;
            })();
          }
          const pending = refreshing;
          try {
            await pending;
          } finally {
            if (refreshing === pending) refreshing = undefined;
          }
        }
        return await operation();
      }
    },
  };
}

/** 判断业务响应是否明确表示登录失效，不将课程过期或权限不足当作登录错误。
 * @param value 外部 JSON 响应。
 * @returns 是否应触发登录态刷新。
 */
export function loginRejected(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (record.code === 401 || record.code === 403) return true;
  const message = [record.msg, record.message, record.err_msg]
    .filter((item) => typeof item === 'string')
    .join(' ');
  return /未.{0,2}登[录陆]|请.{0,8}登[录陆]|登[录陆].{0,8}(?:失效|过期)|(?:login|session).{0,16}(?:expired|invalid|required)|not.?logged.?in|unauthenticated/i.test(
    message,
  );
}
