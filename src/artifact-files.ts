import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { writeJson } from './files';
import { asRecord } from './model';

import type { DownloadedFile } from './downloader';

interface Receipt {
  version: 1;
  contentId: string;
  staging: string;
  files: DownloadedFile[];
}

function receiptPath(directory: string, contentId: string): string {
  const id = crypto.createHash('sha256').update(contentId).digest('hex').slice(0, 24);
  return path.join(directory, `.xiaoe-artifact-${id}.json`);
}

async function readReceipt(directory: string, contentId: string): Promise<Receipt | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await fsp.readFile(receiptPath(directory, contentId), 'utf8'));
  } catch (error) {
    if (asRecord(error)?.code === 'ENOENT') return undefined;
    throw error;
  }
  const record = asRecord(value);
  if (
    record?.version !== 1 ||
    record.contentId !== contentId ||
    typeof record.staging !== 'string' ||
    path.basename(record.staging) !== record.staging ||
    !record.staging.startsWith('.xiaoe-part-') ||
    !Array.isArray(record.files) ||
    record.files.length === 0
  )
    throw new Error('图文文档恢复记录无效');
  const files: DownloadedFile[] = [];
  for (const value of record.files) {
    const file = asRecord(value);
    if (
      typeof file?.name !== 'string' ||
      !file.name ||
      file.name.startsWith('.') ||
      path.basename(file.name) !== file.name ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      files.some((item) => item.name === file.name)
    )
      throw new Error('图文文档恢复文件无效');
    files.push({ name: file.name, size: file.size });
  }
  return { version: 1, contentId, staging: record.staging, files };
}

async function rollback(directory: string, receipt: Receipt): Promise<void> {
  for (const file of receipt.files) {
    const destination = path.join(directory, file.name);
    try {
      const staged = await fsp.lstat(path.join(directory, receipt.staging, file.name));
      const published = await fsp.lstat(destination);
      // 只回收与暂存文件为同一 inode 的本次发布文件，未知用户文件不会删除。
      if (
        staged.isFile() &&
        published.isFile() &&
        staged.ino === published.ino &&
        staged.dev === published.dev
      ) {
        if (published.size === file.size) await fsp.unlink(destination);
        else await fsp.rename(destination, `${destination}.incomplete-${Date.now()}`);
      }
    } catch (error) {
      if (asRecord(error)?.code !== 'ENOENT') throw error;
    }
  }
  await fsp.rm(path.join(directory, receipt.staging), { recursive: true, force: true });
  await fsp.rm(receiptPath(directory, receipt.contentId), { force: true });
}

/** 恢复中断的图文文档发布：完整文件可直接写入清单，部分发布只回收本次文件。
 * @param directory 课程目录。
 * @param contentId 稳定资源 ID。
 * @returns 已完整发布的文件；没有记录或部分发布已回滚时返回 undefined。
 * @throws 恢复记录损坏或文件操作失败时抛错。
 */
export async function recoverArtifactFiles(
  directory: string,
  contentId: string,
): Promise<DownloadedFile[] | undefined> {
  const receipt = await readReceipt(directory, contentId);
  if (!receipt) return undefined;
  let complete = true;
  for (const file of receipt.files) {
    try {
      const staged = await fsp.lstat(path.join(directory, receipt.staging, file.name));
      const published = await fsp.lstat(path.join(directory, file.name));
      if (
        !staged.isFile() ||
        !published.isFile() ||
        staged.ino !== published.ino ||
        staged.dev !== published.dev ||
        published.size !== file.size
      )
        complete = false;
    } catch (error) {
      if (asRecord(error)?.code !== 'ENOENT') throw error;
      complete = false;
    }
  }
  if (complete) return receipt.files;
  await rollback(directory, receipt);
  return undefined;
}

/** 暂存所有图文或文档文件，再以禁止覆盖的硬链接发布；清单写入前保留恢复记录。
 * @param directory 课程目录。
 * @param contentId 稳定资源 ID。
 * @param prepare 在私有暂存目录内生成并验证全部文件，返回相对文件记录。
 * @returns 完整发布的文件列表。
 * @throws 下载、验证、名称冲突或发布失败时抛错，并回滚本次发布。
 */
export async function publishArtifactFiles(
  directory: string,
  contentId: string,
  prepare: (staging: string) => Promise<DownloadedFile[]>,
): Promise<DownloadedFile[]> {
  await fsp.mkdir(directory, { recursive: true });
  const staging = await fsp.mkdtemp(path.join(directory, '.xiaoe-part-'));
  let receipt: Receipt | undefined;
  try {
    const files = await prepare(staging);
    if (files.length === 0) throw new Error('资源没有输出文件');
    const names = new Set<string>();
    for (const file of files) {
      if (
        !file.name ||
        file.name.startsWith('.') ||
        path.basename(file.name) !== file.name ||
        names.has(file.name) ||
        !Number.isSafeInteger(file.size) ||
        file.size <= 0
      )
        throw new Error('资源输出文件名或大小无效');
      names.add(file.name);
      const stat = await fsp.lstat(path.join(staging, file.name));
      if (!stat.isFile() || stat.size !== file.size) throw new Error('资源暂存文件不完整');
    }
    receipt = { version: 1, contentId, staging: path.basename(staging), files };
    await writeJson(receiptPath(directory, contentId), receipt);
    for (const file of files)
      await fsp.link(path.join(staging, file.name), path.join(directory, file.name));
    return files;
  } catch (error) {
    if (receipt) await rollback(directory, receipt);
    else await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** 课程清单已持久保存后清理暂存文件和发布恢复记录。
 * @param directory 课程目录。
 * @param contentId 稳定资源 ID。
 * @param files 清单已经保存的最终文件。
 * @returns 清理完成；没有恢复记录时无需操作。
 * @throws 恢复记录与清单不一致或清理失败时抛错。
 */
export async function finishArtifactFiles(
  directory: string,
  contentId: string,
  files: DownloadedFile[],
): Promise<void> {
  const receipt = await readReceipt(directory, contentId);
  if (!receipt) return;
  if (
    receipt.files.length !== files.length ||
    !receipt.files.every((file) =>
      files.some((item) => item.name === file.name && item.size === file.size),
    )
  )
    throw new Error('图文文档恢复记录与清单不一致');
  // 先删恢复记录再删暂存：中断最多遗留私有暂存，不会导致回滚已提交的文件。
  await fsp.rm(receiptPath(directory, contentId));
  await fsp.rm(path.join(directory, receipt.staging), { recursive: true, force: true });
}
