import fs from 'node:fs';
import fsp from 'node:fs/promises';
import streams from 'node:stream/promises';

import { AuthenticationError } from './auth';

/** 每次请求按目标 URL 动态计算 Cookie，重定向不会带上其他源的凭据。 */
export interface MediaHttpOptions {
  headersForUrl?: (url: string) => Promise<Record<string, string>>;
  timeoutMs?: number;
  retries?: number;
  /** 可选的登录态刷新和一次请求重试器。 */
  authenticate?: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** 可重试的流式媒体 HTTP 客户端，不缓存完整音视频到内存。 */
export class MediaHttp {
  private readonly options: MediaHttpOptions;

  /** 创建媒体下载 HTTP 客户端。
   * @param options Cookie 提供器、重试次数与单请求超时。
   */
  constructor(options: MediaHttpOptions = {}) {
    this.options = options;
  }

  private async request(url: string, binaryKey = false, html = false): Promise<Response> {
    const operation = () => this.requestOnce(url, binaryKey, html);
    return this.options.authenticate ? this.options.authenticate(operation) : operation();
  }

  private async requestOnce(url: string, binaryKey: boolean, html: boolean): Promise<Response> {
    for (let redirect = 0; redirect < 10; redirect += 1) {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('媒体 URL 仅允许 HTTP(S)');
      const response = await fetch(url, {
        headers: await this.options.headersForUrl?.(url),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('媒体重定向缺少 Location');
        const next = new URL(location, url);
        if (parsed.protocol === 'https:' && next.protocol !== 'https:')
          throw new Error('媒体重定向降级到 HTTP');
        url = next.href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status))
          throw new AuthenticationError(`媒体认证 HTTP ${response.status}`);
        throw new Error(`媒体 HTTP ${response.status}`);
      }
      if (response.status === 206) {
        await response.body?.cancel();
        throw new Error('服务器返回部分内容，拒绝将其当成完整文件');
      }
      if (
        !binaryKey &&
        (/(?:application|text)\/json/i.test(response.headers.get('content-type') ?? '') ||
          (!html && /text\/html/i.test(response.headers.get('content-type') ?? '')))
      ) {
        await response.body?.cancel();
        throw new Error('媒体地址返回 HTML / JSON，可能是错误页');
      }
      return response;
    }
    throw new Error('媒体重定向次数过多');
  }

  /** 请求较小的播放清单。
   * @param url HLS 清单地址。
   * @returns 完整清单文本。
   * @throws 请求失败、文本过大或超时时抛错。
   */
  async text(url: string): Promise<string> {
    return this.readText(url);
  }

  /** 读取图文接口提供的正文 HTML，仍拒绝 JSON 错误响应。
   * @param url 已授权的正文地址。
   * @returns 最多 8 MiB 的完整 HTML。
   * @throws HTTP 失败、错误响应、超时或内容过大时抛错。
   */
  async html(url: string): Promise<string> {
    return this.readText(url, true);
  }

  private async readText(url: string, html = false): Promise<string> {
    return this.retry(async () => {
      const response = await this.request(url, false, html);
      const max = 8 * 1024 * 1024;
      const reader = response.body?.getReader();
      if (!reader) throw new Error('清单响应为空');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > max) throw new Error('播放清单超过 8 MiB');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return Buffer.concat(chunks).toString('utf8');
    });
  }

  /** 流式下载到指定临时路径；失败自动清理本次不完整文件。
   * @param url 分片、密钥或媒体 URL。
   * @param destination 临时输出路径。
   * @param binaryKey 是否为标准 16 字节 AES 密钥，允许服务端误标的 Content-Type。
   * @returns 下载字节数。
   * @throws HTTP 错误、空响应、长度不符或流中断时抛错。
   */
  async download(url: string, destination: string, binaryKey = false): Promise<number> {
    return this.retry(async () => {
      try {
        const response = await this.request(url, binaryKey);
        if (!response.body) throw new Error('媒体响应为空');
        const reader = response.body.getReader();
        async function* chunks() {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              yield value;
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        }
        await streams.pipeline(chunks(), fs.createWriteStream(destination, { mode: 0o600 }));
        const size = (await fsp.stat(destination)).size;
        const expected = Number(response.headers.get('content-length') ?? 0);
        if (
          size === 0 ||
          (binaryKey && size !== 16) ||
          (expected > 0 && !response.headers.get('content-encoding') && size !== expected)
        )
          throw new Error('媒体下载为空或长度不完整');
        return size;
      } catch (error) {
        await fsp.rm(destination, { force: true });
        throw error;
      }
    });
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof AuthenticationError) throw error;
        if (attempt >= (this.options.retries ?? 2)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
      }
    }
  }
}
