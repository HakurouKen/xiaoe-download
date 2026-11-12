/** 缓存所需的最小 Cookie 字段；保留域、路径和到期限制。 */
export interface LoginCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  expires: number;
}

/** 单个店铺的登录态快照，不持有浏览器连接。 */
export interface LoginSnapshot {
  version: 1;
  origin: string;
  userAgent: string;
  capturedAt: number;
  cookies: LoginCookie[];
}

/** 构造与 URL 匹配的 Cookie 头，过期 Cookie 不发送。
 * @param cookies 当前店铺的 Cookie 快照。
 * @param url 请求目标。
 * @param now 当前 Unix 毫秒时间，测试可指定。
 * @returns 符合域、路径、HTTPS 和有效期限制的 Cookie 头。
 */
export function cookieHeader(cookies: LoginCookie[], url: string, now = Date.now()): string {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) return '';
  return cookies
    .filter((cookie) => {
      const domain = cookie.domain.toLowerCase();
      const matchesDomain = domain.startsWith('.')
        ? target.hostname === domain.slice(1) || target.hostname.endsWith(domain)
        : target.hostname === domain;
      const matchesPath =
        target.pathname === cookie.path ||
        (target.pathname.startsWith(cookie.path) &&
          (cookie.path.endsWith('/') || target.pathname[cookie.path.length] === '/'));
      return (
        matchesDomain &&
        matchesPath &&
        (!cookie.secure || target.protocol === 'https:') &&
        (cookie.expires === -1 || cookie.expires * 1000 > now)
      );
    })
    .sort((a, b) => b.path.length - a.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}
