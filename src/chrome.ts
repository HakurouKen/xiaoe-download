import puppeteer from 'puppeteer-core';

import { asRecord, stringField } from './model';

import type { LoginSnapshot } from './cookies';

/** 使用 Puppeteer 获取现有 Chrome 的店铺登录态，成功或失败都会立即断开。
 * @param endpoint HTTP 调试地址或浏览器 WebSocket 地址。
 * @param storeUrl 已登录店铺 URL，要求现有同源标签页。
 * @returns 与店铺 URL 匹配的 Cookie 和 User-Agent 快照。
 * @throws 浏览器不可达、未授权连接、缺少店铺页面或登录 Cookie 时抛错。
 */
export async function readChromeLogin(endpoint: string, storeUrl: string): Promise<LoginSnapshot> {
  let browserWSEndpoint = endpoint;
  if (/^https?:/.test(endpoint)) {
    const response = await fetch(new URL('/json/version', endpoint), {
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) {
      const url = new URL('/devtools/browser', endpoint);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      browserWSEndpoint = url.href;
    } else {
      if (!response.ok) throw new Error(`Chrome 调试服务 HTTP ${response.status}`);
      const value: unknown = await response.json();
      browserWSEndpoint = stringField(asRecord(value) ?? {}, 'webSocketDebuggerUrl');
      if (!browserWSEndpoint) throw new Error('Chrome 调试服务缺少 WebSocket 地址');
    }
  }
  const origin = new URL(storeUrl).origin;
  const browser = await puppeteer.connect({
    browserWSEndpoint,
    defaultViewport: null,
    protocolTimeout: 15000,
    networkEnabled: false,
    issuesEnabled: false,
    targetFilter: (target) => {
      if (target.type() === 'browser') return true;
      try {
        return new URL(target.url()).origin === origin;
      } catch {
        return false;
      }
    },
  });
  try {
    const page = (await browser.pages()).find((page) => {
      try {
        return new URL(page.url()).origin === origin;
      } catch {
        return false;
      }
    });
    if (!page) throw new Error('请在当前 Chrome 打开目标店铺并完成登录');
    const client = await page.createCDPSession();
    try {
      // 使用 Puppeteer 的协议类型和传输，只读取指定店铺 URL 的 Cookie。
      const { cookies } = await client.send('Network.getCookies', { urls: [storeUrl] });
      if (cookies.length === 0) throw new Error('目标店铺没有登录 Cookie，请先在 Chrome 登录');
      return {
        version: 1,
        origin,
        userAgent: await browser.userAgent(),
        capturedAt: Date.now(),
        cookies: cookies
          .filter((cookie) => !cookie.partitionKey)
          .map(({ name, value, domain, path, secure, expires }) => ({
            name,
            value,
            domain,
            path,
            secure,
            expires,
          })),
      };
    } finally {
      await client.detach().catch(() => {});
    }
  } finally {
    await browser.disconnect();
  }
}
