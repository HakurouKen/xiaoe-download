import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { expect, it } from 'vitest';
import { MediaHttp } from './http';

it('重定向按新 URL 获取凭据，错误页和短密钥不发布临时文件', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaoe-http-'));
  const cookies: string[] = [];
  const server = http.createServer((request, response) => {
    cookies.push(request.headers.cookie ?? '');
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/file' });
      response.end();
    } else if (request.url === '/file') {
      response.end('complete');
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('error');
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务器未启动');
    const origin = `http://127.0.0.1:${address.port}`;
    const client = new MediaHttp({
      retries: 0,
      headersForUrl: async (url) => ({
        cookie: new URL(url).pathname === '/redirect' ? 'scope=redirect' : 'scope=file',
      }),
    });
    const destination = path.join(directory, 'part');
    expect(await client.download(`${origin}/redirect`, destination)).toBe(8);
    expect(cookies.slice(0, 2)).toEqual(['scope=redirect', 'scope=file']);
    await fsp.rm(destination);
    await expect(client.download(`${origin}/error`, destination)).rejects.toThrow('HTML');
    await expect(fsp.stat(destination)).rejects.toThrow();
    await expect(client.download(`${origin}/error`, destination, true)).rejects.toThrow(
      '长度不完整',
    );
    await expect(fsp.stat(destination)).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
