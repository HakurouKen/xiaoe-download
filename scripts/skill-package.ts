import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { unzipSync, zipSync } from 'fflate';

const requiredFiles = [
  'xiaoe-download/SKILL.md',
  'xiaoe-download/scripts/skill.mjs',
  'xiaoe-download/scripts/cli.mjs',
  'xiaoe-download/references/third-party-licenses.txt',
];

/** 根据项目版本确定附件名，并核对发布 tag。
 * @param version 项目版本。
 * @param tag 可选的发布 tag。
 * @returns 版本化 ZIP 文件名。
 * @throws 版本格式无效或 tag 与版本不匹配时抛错。
 */
export function archiveName(version: string, tag?: string): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error('Skill 发布需要稳定的三段版本号');
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`发布 tag 必须为 v${version}`);
  return `xiaoe-download-skill-v${version}.zip`;
}

function validateFiles(files: Record<string, Uint8Array>): void {
  for (const name of Object.keys(files)) {
    const segments = name.split('/');
    if (
      segments.some((segment) => !segment || segment === '.' || segment === '..') ||
      name.includes('\\') ||
      name.includes(':') ||
      !/^xiaoe-download\/(?:SKILL\.md|scripts\/[^/]+\.mjs|references\/(?:[^/]+\/)*[^/]+\.(?:md|txt))$/.test(
        name,
      ) ||
      segments.some((segment) => segment.startsWith('.') || segment === 'node_modules')
    )
      throw new Error(`分发包包含非交付文件：${name}`);
  }
  for (const name of requiredFiles) {
    if (!files[name]?.length) throw new Error(`分发包缺少必要文件：${name}`);
  }
}

/** 仅将完整组装目录中的交付文件打包，拒绝符号链接和个人状态。
 * @param directory 已构建的 xiaoe-download 目录。
 * @returns 文件顺序、权限及时间固定的 ZIP 内容。
 * @throws 目录不可读、包含非交付文件或缺少必要文件时抛错。
 */
export async function packSkill(directory: string): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  async function collect(relative: string): Promise<void> {
    const current = path.join(directory, relative);
    const stat = await fsp.lstat(current);
    if (stat.isDirectory()) {
      for (const entry of (await fsp.readdir(current)).sort())
        await collect(path.join(relative, entry));
    } else if (stat.isFile()) {
      files[`xiaoe-download/${relative.split(path.sep).join('/')}`] = await fsp.readFile(current);
    } else throw new Error(`分发目录不允许符号链接或特殊文件：${current}`);
  }
  await collect('');
  validateFiles(files);
  return zipSync(files, {
    level: 9,
    mtime: new Date(1980, 0, 1),
    os: 3,
    attrs: 0o100644 << 16,
  });
}

/** 验证 ZIP 的交付边界后解压至新目录，供最终分发包验收使用。
 * @param archive ZIP 内容。
 * @param destination 尚不存在的解压根目录。
 * @returns 解压后的 Skill 绝对路径。
 * @throws 包无效、包含非交付路径或目标目录已存在时抛错。
 */
export async function unpackSkill(archive: Uint8Array, destination: string): Promise<string> {
  const files = unzipSync(archive);
  validateFiles(files);
  await fsp.mkdir(destination);
  for (const [name, data] of Object.entries(files)) {
    const filename = path.join(destination, ...name.split('/'));
    await fsp.mkdir(path.dirname(filename), { recursive: true });
    await fsp.writeFile(filename, data);
  }
  return path.resolve(destination, 'xiaoe-download');
}

/** 生成与下载工具兼容的 SHA-256 校验行。
 * @param archive ZIP 内容。
 * @param filename ZIP 文件名。
 * @returns 包含散列和文件名的校验行。
 */
export function checksum(archive: Uint8Array, filename: string): string {
  return `${crypto.createHash('sha256').update(archive).digest('hex')}  ${filename}\n`;
}
