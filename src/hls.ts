import cp from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { MediaHttp } from './http';

function attributes(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    if (match[1] && match[2] !== undefined) result[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return result;
}

/** 对标准 HLS 主清单选择最高带宽版本并保留其独立音轨。
 * @param text 主清单文本。
 * @returns 选中版本及对应音轨；媒体清单返回 undefined。
 * @throws 主清单缺少完整变体信息时抛错。
 */
export function selectHlsVariant(
  text: string,
): { stream: string; uri: string; audio?: string } | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const choices: { stream: string; uri: string; bandwidth: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.startsWith('#EXT-X-STREAM-INF:')) continue;
    const uri = lines[index + 1];
    if (!uri || uri.startsWith('#')) throw new Error('HLS 主清单的变体缺少 URI');
    choices.push({ stream: line, uri, bandwidth: Number(attributes(line).BANDWIDTH ?? 0) });
  }
  if (choices.length === 0) return undefined;
  choices.sort((a, b) => b.bandwidth - a.bandwidth);
  const selected = choices[0];
  if (!selected) throw new Error('HLS 主清单没有可用变体');
  const audioGroup = attributes(selected.stream).AUDIO;
  const audioTracks = lines.filter((line) => {
    if (!line.startsWith('#EXT-X-MEDIA:')) return false;
    const attrs = attributes(line);
    return attrs.TYPE === 'AUDIO' && attrs['GROUP-ID'] === audioGroup;
  });
  const audio = audioTracks.find((line) => attributes(line).DEFAULT === 'YES') ?? audioTracks[0];
  return { stream: selected.stream, uri: selected.uri, audio };
}

/** 下载标准 HLS 到本地清单，覆盖 AES-128 密钥、fMP4 初始化段及 byte-range 资源。
 * @param url 已签名 HLS 地址。
 * @param directory 本次下载的私有临时目录。
 * @param http 带源限定请求头的流式客户端。
 * @param concurrency 分片请求并发数。
 * @returns 本地入口清单绝对路径。
 * @throws DRM、动态直播、非法清单、密钥不完整或分片失败时抛错。
 */
export async function downloadHls(
  url: string,
  directory: string,
  http: MediaHttp,
  concurrency = 6,
): Promise<string> {
  const assets = new Map<string, { file: string; key: boolean }>();
  let playlistIndex = 0;
  async function localize(playlistUrl: string, ancestors: Set<string>): Promise<string> {
    if (ancestors.has(playlistUrl) || ancestors.size >= 8)
      throw new Error('HLS 清单循环引用或层级过深');
    const nextAncestors = new Set([...ancestors, playlistUrl]);
    const text = (await http.text(playlistUrl)).trim();
    if (!text.startsWith('#EXTM3U')) throw new Error('媒体地址不是有效的 HLS 清单');
    const filename = `playlist-${playlistIndex++}.m3u8`;
    const variant = selectHlsVariant(text);
    let output: string;
    if (variant) {
      if (/#EXT-X-SESSION-KEY/.test(text))
        throw new Error('暂不支持主清单 SESSION-KEY，请记录该媒体格式');
      const media = await localize(new URL(variant.uri, playlistUrl).href, nextAncestors);
      let audio = variant.audio;
      if (audio) {
        const audioUri = attributes(audio).URI;
        if (audioUri) {
          const localAudio = await localize(new URL(audioUri, playlistUrl).href, nextAncestors);
          audio = audio.replace(/URI="[^"]+"/, `URI="${localAudio}"`);
        }
      }
      output = ['#EXTM3U', '#EXT-X-VERSION:6', audio, variant.stream, media]
        .filter(Boolean)
        .join('\n');
    } else {
      if (!text.includes('#EXT-X-ENDLIST'))
        throw new Error('HLS 仍是动态直播清单，不当作完整回放下载');
      const lines = text.split(/\r?\n/);
      let segments = 0;
      output = lines
        .map((raw) => {
          const line = raw.trim();
          if (!line) return '';
          const key = line.startsWith('#EXT-X-KEY:');
          if (key) {
            const attrs = attributes(line);
            if (
              !['NONE', 'AES-128'].includes(attrs.METHOD ?? '') ||
              (attrs.KEYFORMAT && attrs.KEYFORMAT !== 'identity')
            )
              throw new Error('HLS 使用 DRM / 非标准密钥格式，无法下载');
            if (attrs.METHOD === 'AES-128' && !attrs.URI)
              throw new Error('AES-128 清单缺少密钥 URI');
          }
          const assetName = (uri: string) => {
            const absolute = new URL(uri, playlistUrl).href;
            if (!/^https?:/.test(absolute)) throw new Error('HLS 资源 URI 仅允许 HTTP(S)');
            let asset = assets.get(absolute);
            if (!asset) {
              const extension = path.extname(new URL(absolute).pathname).toLowerCase();
              const suffix = key
                ? '.key'
                : ['.ts', '.m4s', '.mp4', '.aac', '.mp3'].includes(extension)
                  ? extension
                  : '.ts';
              asset = { file: `asset-${assets.size}${suffix}`, key };
              assets.set(absolute, asset);
            } else if (key) asset.key = true;
            return asset.file;
          };
          if (!line.startsWith('#')) {
            segments += 1;
            return assetName(line);
          }
          return line.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${assetName(uri)}"`);
        })
        .join('\n');
      if (segments === 0) throw new Error('HLS 清单没有媒体分片');
    }
    await fsp.writeFile(path.join(directory, filename), `${output}\n`, { mode: 0o600 });
    return filename;
  }
  const entry = await localize(url, new Set());
  const queue = [...assets.entries()];
  let next = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (next < queue.length && !failure) {
      const item = queue[next++];
      if (!item) break;
      try {
        const [assetUrl, asset] = item;
        const size = await http.download(assetUrl, path.join(directory, asset.file), asset.key);
        if (asset.key && size !== 16) throw new Error('AES-128 密钥不是标准 16 字节密钥');
      } catch (error) {
        failure = error;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return path.join(directory, entry);
}

/** 运行本地媒体工具，限定执行时间，不使用 shell 拼接参数。
 * @param executable ffmpeg 或 ffprobe 的可执行文件。
 * @param args 独立参数数组。
 * @param timeoutMs 最大执行时间。
 * @returns 工具 stdout 文本。
 * @throws 子进程启动失败、超时或非零退出时抛错。
 */
export async function runMediaTool(
  executable: string,
  args: string[],
  timeoutMs = 120000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (data: Buffer) => {
      stdout = (stdout + data.toString()).slice(-16000);
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve(stdout);
      else reject(new Error(timedOut ? `${executable} 超时` : `${executable} 失败：${stderr}`));
    });
  });
}

/** 用 ffmpeg 无损合并本地 HLS；合并过程禁止访问网络。
 * @param playlist 本地 HLS 入口。
 * @param output 临时 MP4 / M4A 文件。
 * @param ffmpeg ffmpeg 路径。
 * @param audioOnly 是否只保留音轨。
 * @returns 合并完成。
 * @throws ffmpeg 失败或超时时抛错。
 */
export async function mergeHls(
  playlist: string,
  output: string,
  ffmpeg: string,
  audioOnly: boolean,
): Promise<void> {
  await runMediaTool(
    ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-xerror',
      '-protocol_whitelist',
      'file,crypto',
      '-allowed_extensions',
      'ALL',
      '-i',
      playlist,
      ...(audioOnly ? ['-vn', '-map', '0:a:0'] : ['-map', '0:v:0', '-map', '0:a?']),
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
      output,
    ],
    600000,
  );
}
