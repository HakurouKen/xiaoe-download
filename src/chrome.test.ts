import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readChromeLogin } from './chrome';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  pages: vi.fn(),
  userAgent: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
  detach: vi.fn(),
  createSession: vi.fn(),
}));
vi.mock('puppeteer-core', () => ({ default: { connect: mocks.connect } }));
const url = 'https://shop.test/p/record';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.connect.mockResolvedValue({
    pages: mocks.pages,
    userAgent: mocks.userAgent,
    disconnect: mocks.disconnect,
  });
  mocks.pages.mockResolvedValue([{ url: () => url, createCDPSession: mocks.createSession }]);
  mocks.createSession.mockResolvedValue({ send: mocks.send, detach: mocks.detach });
  mocks.userAgent.mockResolvedValue('test-agent');
  mocks.detach.mockResolvedValue(undefined);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue({
    cookies: [
      { name: 'sid', value: 'test', domain: 'shop.test', path: '/', secure: true, expires: -1 },
    ],
  });
});
describe('Puppeteer 登录态快照', () => {
  it('只读取店铺 URL 的 Cookie，返回前断开且保留 Chrome', async () => {
    const result = await readChromeLogin('ws://localhost:9222/devtools/browser', url);
    expect(result.cookies).toHaveLength(1);
    expect(mocks.send).toHaveBeenCalledWith('Network.getCookies', { urls: [url] });
    expect(mocks.detach).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ defaultViewport: null, networkEnabled: false }),
    );
  });
  it('读取失败仍然断开连接', async () => {
    mocks.send.mockRejectedValue(new Error('读取失败'));
    await expect(readChromeLogin('ws://localhost:9222/devtools/browser', url)).rejects.toThrow(
      '读取失败',
    );
    expect(mocks.detach).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });
  it('没有匹配的标签页时断开，不打开新页面', async () => {
    mocks.pages.mockResolvedValue([]);
    await expect(readChromeLogin('ws://localhost:9222/devtools/browser', url)).rejects.toThrow(
      '完成登录',
    );
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
