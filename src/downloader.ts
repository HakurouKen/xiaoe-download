import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { finishArtifactFiles, recoverArtifactFiles } from './artifact-files';
import { downloadArticle, downloadDocuments } from './artifacts';
import { allocateContentNames, writeJson } from './files';
import { downloadHls, mergeHls, runMediaTool } from './hls';
import { asRecord, errorMessage } from './model';

import type { MediaHttp } from './http';
import type { ArticleSource, Content, Course, DocumentSource, MediaSource } from './model';

/** 经过验证的最终文件，size 用于重跑时检测丢失和截断。 */
export interface DownloadedFile {
  name: string;
  size: number;
}

/** 单资源结果；占位与真实媒体下载状态分开记录。 */
export interface ContentResult {
  content: Content;
  status: 'done' | 'placeholder' | 'failed';
  files: DownloadedFile[];
  error?: string;
  /** 已由清单确认替换的旧占位；仅清理仍为空的文件，可在中断后继续清理。 */
  obsoleteFiles?: DownloadedFile[];
}

/** 可复用的下载参数，无浏览器或 CLI 依赖。 */
export interface DownloadOptions {
  http: MediaHttp;
  ffmpeg: string;
  ffprobe: string;
  concurrency: number;
  resolve: (content: Content) => Promise<MediaSource[]>;
  resolveArticle?: (content: Content) => Promise<ArticleSource>;
  resolveDocuments?: (content: Content) => Promise<DocumentSource[]>;
  /** 只扫描目录时仍创建占位，不获取正文或文档。 */
  catalogOnly?: boolean;
  log?: (message: string) => void;
  /** 指定本次下载的资源，名称仍根据完整目录分配。 */
  selectedIds?: Set<string>;
}

/** 用 ffprobe 验证最终输出确实包含所需音视频流。
 * @param filename 已完整下载的临时媒体。
 * @param audioOnly 是否要求音频而非视频。
 * @param ffprobe ffprobe 可执行文件。
 * @returns 媒体验证完成。
 * @throws 文件损坏、空媒体或流类型不匹配时抛错。
 */
export async function verifyMedia(
  filename: string,
  audioOnly: boolean,
  ffprobe: string,
): Promise<void> {
  const value: unknown = JSON.parse(
    await runMediaTool(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,duration:format=duration',
      '-of',
      'json',
      filename,
    ]),
  );
  const record = asRecord(value);
  const streams = Array.isArray(record?.streams) ? record.streams.map(asRecord) : [];
  if (!streams.some((stream) => stream?.codec_type === (audioOnly ? 'audio' : 'video')))
    throw new Error('媒体没有所需音视频流');
  const format = asRecord(record?.format);
  const duration = Number(format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('媒体没有有效时长');
}

/** 下载单个标准媒体源，临时文件通过校验后才发布，禁止覆盖已有文件。
 * @param source 已解析的短期媒体地址。
 * @param directory 课程输出目录。
 * @param baseName 已经分配好的标题文件名。
 * @param options HTTP 与本地媒体工具配置。
 * @returns 最终文件相对名称和大小。
 * @throws 请求失败、合并或验证失败、已有同名文件时抛错。
 */
export async function downloadMedia(
  source: MediaSource,
  directory: string,
  baseName: string,
  options: DownloadOptions,
): Promise<DownloadedFile> {
  const extension = source.hls
    ? source.audioOnly
      ? '.m4a'
      : '.mp4'
    : path.extname(new URL(source.url).pathname).toLowerCase();
  if (
    !['.mp4', '.m4a', '.mp3', '.aac', '.wav', '.flac', '.ogg', '.webm', '.mov', '.mkv'].includes(
      extension,
    )
  )
    throw new Error('直接媒体的文件格式未知');
  await fsp.mkdir(directory, { recursive: true });
  const temporary = await fsp.mkdtemp(path.join(directory, '.xiaoe-part-'));
  try {
    const staged = path.join(temporary, `output${extension}`);
    if (source.hls) {
      const playlist = await downloadHls(source.url, temporary, options.http, options.concurrency);
      await mergeHls(playlist, staged, options.ffmpeg, source.audioOnly);
    } else {
      await options.http.download(source.url, staged);
    }
    await verifyMedia(staged, source.audioOnly, options.ffprobe);
    const name = `${baseName}${extension}`;
    const destination = path.join(directory, name);
    // COPYFILE_EXCL 防止用户文件或不同资源在名称冲突时被覆盖。
    await fsp.copyFile(staged, destination, fs.constants.COPYFILE_EXCL);
    return { name, size: (await fsp.stat(destination)).size };
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

/** 下载单个课程内容，图文和文档输出真实文件；仅目录模式创建占位。
 * @param content 资源描述。
 * @param directory 课程目录。
 * @param baseName 标题基础名。
 * @param options 可复用的媒体解析与下载配置。
 * @returns 完成或失败结果，单个失败不会终止整个课程。
 */
export async function downloadContent(
  content: Content,
  directory: string,
  baseName: string,
  options: DownloadOptions,
): Promise<ContentResult> {
  const files: DownloadedFile[] = [];
  try {
    await fsp.mkdir(directory, { recursive: true });
    if ((content.kind === 'text' || content.kind === 'document') && options.catalogOnly) {
      const name = `${baseName}.${content.kind}.placeholder`;
      await fsp.writeFile(path.join(directory, name), '', { flag: 'wx' });
      files.push({ name, size: 0 });
      return { content, status: 'placeholder', files };
    }
    if (content.kind === 'text' || content.kind === 'document') {
      const recovered = await recoverArtifactFiles(directory, content.id);
      if (recovered) return { content, status: 'done', files: recovered };
      if (!content.available) throw new Error('内容尚未解锁或无访问权限');
      if (content.kind === 'text') {
        if (!options.resolveArticle) throw new Error('未配置图文解析器');
        return {
          content,
          status: 'done',
          files: await downloadArticle(
            await options.resolveArticle(content),
            content,
            directory,
            baseName,
            options.http,
          ),
        };
      }
      if (!options.resolveDocuments) throw new Error('未配置文档解析器');
      return {
        content,
        status: 'done',
        files: await downloadDocuments(
          await options.resolveDocuments(content),
          content,
          directory,
          baseName,
          options.http,
        ),
      };
    }
    if (content.kind === 'unknown') throw new Error('此资源类型尚未实现');
    const sources = await options.resolve(content);
    if (sources.length === 0) throw new Error('媒体解析没有返回地址');
    for (const [index, source] of sources.entries()) {
      files.push(
        await downloadMedia(
          source,
          directory,
          sources.length > 1 ? `${baseName}（回放${index + 1}）` : baseName,
          options,
        ),
      );
    }
    return { content, status: 'done', files };
  } catch (error) {
    // 多段回放作为同一资源发布；失败时只清理本次成功创建的片段。
    for (const file of files) await fsp.rm(path.join(directory, file.name), { force: true });
    return { content, status: 'failed', files: [], error: errorMessage(error) };
  }
}

async function reusable(directory: string, result: ContentResult): Promise<boolean> {
  if (result.status === 'failed' || result.files.length === 0) return false;
  for (const file of result.files) {
    if (path.basename(file.name) !== file.name) return false;
    try {
      if ((await fsp.stat(path.join(directory, file.name))).size !== file.size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function placeholderFiles(result: ContentResult | undefined, content: Content): DownloadedFile[] {
  if (!result || !['text', 'document'].includes(content.kind)) return [];
  return result.files.filter(
    (file) =>
      file.size === 0 &&
      file.name.endsWith(`.${content.kind}.placeholder`) &&
      path.basename(file.name) === file.name,
  );
}

async function cleanObsoleteFiles(directory: string, result: ContentResult): Promise<void> {
  for (const file of result.obsoleteFiles ?? []) {
    const filename = path.join(directory, file.name);
    try {
      const stat = await fsp.lstat(filename);
      // 已被用户写入内容的占位保留，不把它当作可删除的空文件。
      if (stat.isFile() && stat.size === 0) await fsp.unlink(filename);
    } catch (error) {
      if (asRecord(error)?.code !== 'ENOENT') throw error;
    }
  }
}

/** 逐个下载课程内容，保存清单并在重跑时跳过经校验的完整文件。
 * @param course 课程描述。
 * @param contents 已完整发现的课程目录。
 * @param directory 课程输出文件夹。
 * @param options 媒体下载参数。
 * @returns 全部资源的结果；失败资源仍在清单中。
 * @throws 清单损坏、目录归属冲突或清单写入失败时抛错。
 */
export async function downloadCourse(
  course: Course,
  contents: Content[],
  directory: string,
  options: DownloadOptions,
): Promise<ContentResult[]> {
  const manifestPath = path.join(directory, '.xiaoe-manifest.json');
  const previous = new Map<string, ContentResult>();
  try {
    const value: unknown = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    const record = asRecord(value);
    const owner = asRecord(record?.course);
    if (owner?.id !== course.id || !Array.isArray(record?.results))
      throw new Error('课程清单归属或结构不正确');
    for (const item of record.results) {
      const entry = asRecord(item);
      const content = asRecord(entry?.content);
      if (!entry || !content || typeof content.id !== 'string' || !Array.isArray(entry.files))
        throw new Error('清单结果无效');
      if (!['done', 'placeholder', 'failed'].includes(String(entry.status)))
        throw new Error('清单状态无效');
      if (
        !entry.files.every((file: unknown) => {
          const record = asRecord(file);
          return (
            record &&
            typeof record.name === 'string' &&
            typeof record.size === 'number' &&
            record.size >= 0
          );
        })
      )
        throw new Error('清单文件记录无效');
      if (
        entry.obsoleteFiles !== undefined &&
        (!Array.isArray(entry.obsoleteFiles) ||
          !entry.obsoleteFiles.every((value: unknown) => {
            const file = asRecord(value);
            return (
              typeof file?.name === 'string' &&
              path.basename(file.name) === file.name &&
              /\.(?:text|document)\.placeholder$/.test(file.name) &&
              file.size === 0
            );
          }))
      )
        throw new Error('清单旧占位记录无效');
      // 外部 JSON 已验证关键恢复字段，其他描述字段不参与文件操作。
      previous.set(content.id, item as ContentResult);
    }
  } catch (error) {
    const value = asRecord(error);
    if (value?.code !== 'ENOENT') throw error;
  }
  const names = allocateContentNames(contents);
  const results: ContentResult[] = [];
  for (const content of contents) {
    if (options.selectedIds && !options.selectedIds.has(content.id)) continue;
    const old = previous.get(content.id);
    const placeholders = placeholderFiles(old, content);
    const reusableResult: ContentResult | undefined =
      old &&
      options.catalogOnly &&
      placeholders.length > 0 &&
      placeholders.length === old.files.length
        ? { content, status: 'placeholder', files: placeholders }
        : old;
    if (
      reusableResult &&
      !(reusableResult.status === 'placeholder' && !options.catalogOnly) &&
      (await reusable(directory, reusableResult))
    ) {
      results.push({ ...reusableResult, content });
      options.log?.(`跳过已完成：${content.title}`);
    } else {
      // 清单拥有但尺寸改变的文件保留为备份，再重新下载；未知文件仍禁止覆盖。
      if (old)
        for (const file of old.files) {
          if (placeholders.includes(file)) continue;
          if (path.basename(file.name) !== file.name) throw new Error('清单包含不安全的文件路径');
          const filename = path.join(directory, file.name);
          try {
            await fsp.rename(filename, `${filename}.incomplete-${Date.now()}`);
          } catch (error) {
            if (asRecord(error)?.code !== 'ENOENT') throw error;
          }
        }
      options.log?.(`下载：${content.title}（${content.kind}）`);
      const result = await downloadContent(
        content,
        directory,
        names.get(content.id) ?? content.id,
        options,
      );
      if (placeholders.length) {
        if (result.status === 'done')
          result.obsoleteFiles = [...(old?.obsoleteFiles ?? []), ...placeholders];
        else if (result.status === 'failed') result.files = placeholders;
      } else if (old?.obsoleteFiles) result.obsoleteFiles = old.obsoleteFiles;
      results.push(result);
      if (result.status === 'failed') options.log?.(`失败：${content.title}：${result.error}`);
    }
    for (const result of results) previous.set(result.content.id, result);
    await writeJson(manifestPath, {
      version: 1,
      course,
      results: [...previous.values()],
      updatedAt: new Date().toISOString(),
    });
    const saved = results.at(-1);
    if (saved?.status === 'done' && ['text', 'document'].includes(content.kind)) {
      await cleanObsoleteFiles(directory, saved);
      await finishArtifactFiles(directory, content.id, saved.files);
    }
  }
  return results;
}
