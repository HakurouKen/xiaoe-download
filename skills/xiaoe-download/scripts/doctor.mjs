import { commandAvailable, stateDirectory } from './skill-environment.mjs';

/** 只读检查媒体工具和可选 HTTP 调试服务，不准备目录或读取登录态。
 * @param options 检查选项；cdp 仅采用显式传入的地址，不读取环境变量。
 * @returns 工具可用性、用户状态目录及调试服务检查报告。
 */
export async function doctor(options = {}) {
  const ffmpeg = await commandAvailable(options.ffmpeg ?? 'ffmpeg', ['-version']);
  const ffprobe = await commandAvailable(options.ffprobe ?? 'ffprobe', ['-version']);
  let cdp = '未检查；缓存有效时无需 Chrome，首次或刷新登录态需用户开启调试并允许连接';
  const endpoint = options.cdp;
  if (endpoint && /^https?:/.test(endpoint)) {
    try {
      const response = await fetch(new URL('/json/version', endpoint), {
        signal: AbortSignal.timeout(5000),
      });
      cdp = response.ok
        ? 'HTTP 调试服务可达；尚未验证店铺登录态'
        : `HTTP ${response.status}；请检查 Chrome 调试地址`;
    } catch {
      cdp = 'HTTP 调试服务不可达；请用户开启调试并确认地址';
    }
  }
  return {
    node: process.versions.node,
    ffmpeg,
    ffprobe,
    stateDirectory: stateDirectory(),
    cdp,
    prepared: false,
  };
}
