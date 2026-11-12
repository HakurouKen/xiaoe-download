import { describe, expect, it } from 'vitest';

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { AuthenticationError, loadLoginSession, loginRejected } from './auth';
import { cookieHeader } from './cookies';
import { StoreClient } from './store';
import { MediaHttp } from './http';

import type { LoginSnapshot } from './cookies';

const storeUrl = 'https://shop.example.test/p/record';
function snapshot(origin = new URL(storeUrl).origin, value = 'fresh'): LoginSnapshot {
  return {
    version: 1,
    origin,
    userAgent: 'test-agent',
    capturedAt: Date.now(),
    cookies: [
      {
        name: 'sid',
        value,
        domain: new URL(origin).hostname,
        path: '/',
        secure: new URL(origin).protocol === 'https:',
        expires: -1,
      },
    ],
  };
}
async function fixture(run: (cacheFile: string) => Promise<void>) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaoe-auth-'));
  try {
    await run(path.join(directory, 'cookies.json'));
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

describe('Cookie 匹配', () => {
  it('遵循域、路径、HTTPS 和过期时间，拒绝相似域名', () => {
    const cookies = [
      ...snapshot().cookies,
      {
        name: 'domain',
        value: 'yes',
        domain: '.example.test',
        path: '/api',
        secure: true,
        expires: 200,
      },
      {
        name: 'expired',
        value: 'no',
        domain: '.example.test',
        path: '/',
        secure: false,
        expires: 1,
      },
    ];
    expect(cookieHeader(cookies, 'https://shop.example.test/api/a', 100000)).toBe(
      'domain=yes; sid=fresh',
    );
    expect(cookieHeader(cookies, 'https://cdn.example.test/api/a', 100000)).toBe('domain=yes');
    expect(cookieHeader(cookies, 'https://shop.example.test/api-other', 100000)).toBe('sid=fresh');
    expect(cookieHeader(cookies, 'https://evil-example.test/api/a', 100000)).toBe('');
    expect(cookieHeader(cookies, 'http://shop.example.test/api/a', 100000)).toBe('');
    expect(cookieHeader(cookies, 'https://cdn.example.test/api/a', 200000)).toBe('');
  });
});

describe('本地登录态', () => {
  it('首次获取后落盘，后续运行只使用缓存并限制权限', async () =>
    fixture(async (cacheFile) => {
      let reads = 0;
      const options = {
        endpoint: 'ws://unused',
        storeUrl,
        cacheFile,
        readLogin: async () => {
          reads += 1;
          return snapshot();
        },
      };
      const first = await loadLoginSession(options);
      expect(await first.cookieHeader(storeUrl)).toBe('sid=fresh');
      const second = await loadLoginSession({
        ...options,
        readLogin: async () => {
          throw new Error('缓存命中时不应连接 Chrome');
        },
      });
      expect(await second.cookieHeader(storeUrl)).toBe('sid=fresh');
      expect(reads).toBe(1);
      expect((await fsp.stat(cacheFile)).mode & 0o777).toBe(0o600);
    }));
  it('损坏、跨店铺、过期和强制刷新均重新获取', async () =>
    fixture(async (cacheFile) => {
      let reads = 0;
      const options = {
        endpoint: 'ws://unused',
        storeUrl,
        cacheFile,
        readLogin: async () => {
          reads += 1;
          return snapshot();
        },
      };
      for (const value of [
        '{bad',
        JSON.stringify(snapshot('https://other.test')),
        JSON.stringify({
          ...snapshot(),
          cookies: snapshot().cookies.map((cookie) => ({ ...cookie, expires: 1 })),
        }),
      ]) {
        await fsp.writeFile(cacheFile, value);
        await loadLoginSession(options);
      }
      await loadLoginSession({ ...options, forceRefresh: true });
      expect(reads).toBe(4);
    }));
  it('并发认证失败共享一次刷新，刷新后仍失败不会继续连接', async () =>
    fixture(async (cacheFile) => {
      await fsp.writeFile(cacheFile, JSON.stringify(snapshot(undefined, 'stale')));
      let reads = 0;
      const session = await loadLoginSession({
        endpoint: 'ws://unused',
        storeUrl,
        cacheFile,
        readLogin: async () => {
          reads += 1;
          await new Promise((resolve) => setTimeout(resolve, 15));
          return snapshot();
        },
      });
      const operation = async () => {
        if ((await session.cookieHeader(storeUrl)) === 'sid=stale')
          throw new AuthenticationError('登录失效');
        return 'ok';
      };
      expect(await Promise.all(Array.from({ length: 12 }, () => session.run(operation)))).toEqual(
        Array(12).fill('ok'),
      );
      expect(reads).toBe(1);
      await expect(
        session.run(async () => {
          throw new AuthenticationError('仍失效');
        }),
      ).rejects.toThrow('仍失效');
      expect(reads).toBe(1);
      expect(await session.run(async () => '后续成功')).toBe('后续成功');
    }));
  it('普通网络或课程权限错误不刷新登录态', async () =>
    fixture(async (cacheFile) => {
      await fsp.writeFile(cacheFile, JSON.stringify(snapshot()));
      const session = await loadLoginSession({
        endpoint: 'ws://unused',
        storeUrl,
        cacheFile,
        readLogin: async () => {
          throw new Error('不应连接');
        },
      });
      await expect(
        session.run(async () => {
          throw new Error('课程已过期');
        }),
      ).rejects.toThrow('课程已过期');
      expect(loginRejected({ code: 1, msg: '课程已过期' })).toBe(false);
      expect(loginRejected({ code: 1, msg: '请先登录' })).toBe(true);
      expect(loginRejected({ code: 1, msg: 'session expired' })).toBe(true);
    }));
});

it('真实 fetch 的业务登录错误和媒体 401 刷新一次，重试保留 POST 请求体', async () =>
  fixture(async (cacheFile) => {
    let reads = 0;
    const received: { cookie: string; body: string }[] = [];
    const server = http.createServer((request, response) => {
      void (async () => {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const cookie = request.headers.cookie ?? '';
        received.push({ cookie, body });
        if (request.url === '/media') {
          if (cookie !== 'sid=fresh') {
            response.writeHead(401);
            response.end();
          } else response.end('media');
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify(
              cookie === 'sid=fresh'
                ? { code: 0, data: { ok: true } }
                : { code: 9, msg: '请先登录' },
            ),
          );
        }
      })();
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('测试服务器未启动');
      const origin = `http://127.0.0.1:${address.port}`;
      await fsp.writeFile(cacheFile, JSON.stringify(snapshot(origin, 'stale')));
      const options = {
        endpoint: 'ws://unused',
        storeUrl: origin,
        cacheFile,
        readLogin: async () => {
          reads += 1;
          return snapshot(origin);
        },
      };
      const session = await loadLoginSession(options);
      const client = new StoreClient(origin, session);
      expect(await client.api('/api', { id: 'a' })).toEqual({ ok: true });
      expect(received.slice(0, 2)).toEqual([
        { cookie: 'sid=stale', body: 'bizData%5Bid%5D=a' },
        { cookie: 'sid=fresh', body: 'bizData%5Bid%5D=a' },
      ]);
      expect(reads).toBe(1);
      await fsp.writeFile(cacheFile, JSON.stringify(snapshot(origin, 'stale')));
      const mediaSession = await loadLoginSession(options);
      const media = new MediaHttp({
        retries: 0,
        authenticate: mediaSession.run,
        headersForUrl: async (url) => ({ cookie: await mediaSession.cookieHeader(url) }),
      });
      expect(
        await media.download(`${origin}/media`, path.join(path.dirname(cacheFile), 'media')),
      ).toBe(5);
      expect(reads).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }));
