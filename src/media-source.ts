import { asRecord, stringField } from './model';

import type { StoreClient } from './store';
import type { Content, MediaSource } from './model';

/** 从播放 API 提取每段媒体的最高可用清晰度，合并 ext.param 签名参数。
 * @param value getPlayUrl 或资源详情响应。
 * @param audioOnly 是否只选择音频轨道。
 * @returns 标准 HLS / 直接媒体地址；不解码私有 video_urls 字段。
 * @throws 播放 API 仅提供 DRM 格式时抛错。
 */
export function parseMediaSources(value: unknown, audioOnly: boolean): MediaSource[] {
  const found = new Map<string, MediaSource>();
  const visited = new Set<object>();
  const walk = (node: unknown) => {
    if (typeof node !== 'object' || node === null || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    const playlist = asRecord(record.play_list);
    if (playlist) {
      const candidates: { source: MediaSource; rank: number }[] = [];
      for (const [key, item] of Object.entries(playlist)) {
        const entry = asRecord(item);
        if (!entry || entry.is_support === false) continue;
        const encryption = stringField(entry, 'encrypt_type');
        if (encryption && !['normal', 'none', 'aes', 'aes-128'].includes(encryption.toLowerCase()))
          continue;
        const urlString = stringField(entry, 'play_url');
        if (!/^https?:\/\//.test(urlString)) continue;
        const audio = /mp3|m4a|aac|audio/i.test(key);
        if (audio !== audioOnly) continue;
        const url = new URL(urlString);
        const ext = asRecord(entry.ext);
        if (ext)
          for (const [name, value] of new URLSearchParams(stringField(ext, 'param')))
            url.searchParams.set(name, value);
        const height = Number(key.match(/(\d+)p/i)?.[1] ?? 0);
        candidates.push({
          source: { url: url.href, hls: /\.m3u8$/i.test(url.pathname), audioOnly: audio },
          rank: height * 10 + (key === record.default_play ? 1 : 0),
        });
      }
      candidates.sort((a, b) => b.rank - a.rank);
      const best = candidates[0];
      if (!best)
        throw new Error('播放接口没有可用的标准媒体地址（可能为 DRM、未生成回放或类型不符）');
      found.set(best.source.url, best.source);
      return;
    }
    for (const key of audioOnly
      ? ['audio_url', 'audio_hls']
      : ['video_url', 'video_hls', 'replay_url', 'replay_hls']) {
      const urlString = stringField(record, key);
      if (/^https?:\/\//.test(urlString)) {
        const url = new URL(urlString);
        found.set(url.href, { url: url.href, hls: /\.m3u8$/i.test(url.pathname), audioOnly });
      }
    }
    for (const child of Object.values(record)) walk(child);
  };
  walk(value);
  return [...found.values()];
}

/** 直接请求资源详情和播放 API，不执行页面脚本或模拟播放。
 * @param client 带当前 Chrome 登录态的 fetch 店铺客户端。
 * @param content 视频、音频或直播回放。
 * @param appId 当前店铺标识。
 * @returns 标准 HLS / 直接媒体源。
 * @throws 未授权、无回放、DRM 或响应变化时抛错。
 */
export async function resolveMediaSources(
  client: StoreClient,
  content: Content,
  appId: string,
): Promise<MediaSource[]> {
  if (!content.available) throw new Error('内容尚未解锁或无访问权限');
  if (content.kind === 'replay') {
    const base = asRecord(
      await client.get('/_alive/v3/base_info', {
        resource_id: content.id,
        product_id: content.courseId,
        type: 12,
        is_direct: 1,
        file_tag: 1,
      }),
    );
    const access = asRecord(base?.available_info);
    if (access?.available !== true || access.is_try === 1)
      throw new Error('直播回放未授权或只允许试看');
    if (
      asRecord(base?.alive_info)?.alive_state !== 3 ||
      asRecord(base?.alive_conf)?.is_lookback !== 1
    )
      throw new Error('直播尚未结束或未开放回放');
    const replay = asRecord(
      await client.get('/_alive/v3/get_lookback_url', {
        alive_id: content.id,
        product_id: content.courseId,
      }),
    );
    const url =
      stringField(replay ?? {}, 'aliveVideoUrl') || stringField(replay ?? {}, 'aliveVideoMp4Url');
    if (!/^https?:\/\//.test(url) || String(replay?.videoUrlValid) !== '1')
      throw new Error('直播未生成有效标准回放地址');
    return [{ url, hls: /\.m3u8$/i.test(new URL(url).pathname), audioOnly: false }];
  }
  const type = content.kind === 'audio' ? 'audio' : 'video';
  const endpoint =
    type === 'audio'
      ? '/xe.course.business.audio.info.get/2.0.0'
      : `/xe.course.business_go.${type}.detail_info.get/2.0.0`;
  const data = await client.api(endpoint, {
    resource_id: content.id,
    product_id: content.courseId,
    opr_sys: 'MacIntel',
    content_app_id: '',
  });
  const record = asRecord(data);
  if (!record) throw new Error('资源详情响应无效');
  if (record.is_available === 0 || (record.is_try === 1 && record.is_available !== 1))
    throw new Error('当前内容未授权或只允许试看');
  const playSigns = new Set<string>();
  let userId = stringField(record, 'user_id');
  let materialAppId = appId;
  const collect = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) collect(child);
      return;
    }
    const item = asRecord(node);
    if (!item) return;
    const sign = stringField(item, 'play_sign');
    if (sign) playSigns.add(sign);
    userId ||= stringField(item, 'user_id');
    materialAppId = stringField(item, 'material_app_id') || materialAppId;
    for (const value of Object.values(item)) if (typeof value === 'object') collect(value);
  };
  collect(data);
  if (playSigns.size > 0) {
    if (!userId) throw new Error('播放详情缺少会话用户标识');
    const play = await client.api(
      '/xe.material-center.play/getPlayUrl',
      {
        org_app_id: appId,
        app_id: materialAppId,
        user_id: userId,
        play_sign: [...playSigns],
        play_line: 'A',
        opr_sys: 'MacIntel',
      },
      true,
    );
    const sources = parseMediaSources(play, content.kind === 'audio');
    if (sources.length > 0) return sources;
  }
  const sources = parseMediaSources(data, content.kind === 'audio');
  if (sources.length === 0) throw new Error('资源详情没有标准媒体地址');
  return sources;
}
