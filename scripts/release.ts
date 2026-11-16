import cp from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import util from 'node:util';

const execFile = util.promisify(cp.execFile);

/** 展开唯一的下载器引用，使用系统 zip 生成分发附件；不执行构建或联网。
 * @param project 项目根目录。
 * @param filename 已校验的版本化 ZIP 文件名。
 * @returns 生成的 ZIP 绝对路径。
 * @throws 产物缺失、交付边界无效、链接目标错误或系统 zip 不可用时抛错。
 */
export async function packSkill(project: string, filename: string): Promise<string> {
  if (!/^xiaoe-download-skill-v\d+\.\d+\.\d+\.zip$/.test(filename))
    throw new Error('分发附件名无效');
  const source = path.resolve(project, 'skills/xiaoe-download');
  const dist = path.resolve(project, 'dist');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaoe release '));
  const entries: string[] = [];
  try {
    const link = path.join(source, 'references/downloader');
    if (
      !(await fsp.lstat(link)).isSymbolicLink() ||
      (await fsp.realpath(link)) !== (await fsp.realpath(dist))
    )
      throw new Error('references/downloader 必须为指向项目 dist 的软链接');
    const copy = async (from: string, relative: string): Promise<void> => {
      const stat = await fsp.lstat(from);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error(`交付资源不允许额外符号链接或特殊文件：${from}`);
      if (stat.isDirectory()) {
        for (const name of (await fsp.readdir(from)).sort()) {
          await copy(path.join(from, name), `${relative}/${name}`);
        }
        return;
      }
      const entry = `xiaoe-download/${relative}`;
      const target = path.join(root, entry);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(from, target);
      await fsp.chmod(target, 0o644);
      const time = new Date(1980, 0, 1);
      await fsp.utimes(target, time, time);
      entries.push(entry);
    };
    await copy(path.join(source, 'SKILL.md'), 'SKILL.md');
    await copy(path.join(source, 'scripts'), 'scripts');
    for (const name of (await fsp.readdir(path.join(source, 'references'))).sort()) {
      if (name === 'downloader') continue;
      await copy(path.join(source, 'references', name), `references/${name}`);
    }
    await copy(dist, 'references/downloader');
    for (const required of [
      'SKILL.md',
      'scripts/doctor.mjs',
      'scripts/prepare.mjs',
      'scripts/download.mjs',
      'scripts/skill-environment.mjs',
      'references/downloader/cli.mjs',
      'references/downloader/third-party-licenses.txt',
    ]) {
      if (
        !entries.includes(`xiaoe-download/${required}`) ||
        !(await fsp.stat(path.join(root, 'xiaoe-download', required))).size
      )
        throw new Error(`分发包缺少必要文件：${required}`);
    }
    const archive = path.join(root, filename);
    await execFile('zip', ['-X', '-q', archive, ...entries.sort()], { cwd: root });
    const data = await fsp.readFile(archive);
    const output = path.resolve(project, 'release');
    await fsp.rm(output, { recursive: true, force: true });
    await fsp.mkdir(output);
    await fsp.copyFile(archive, path.join(output, filename));
    await fsp.writeFile(path.join(output, `${filename}.sha256`), checksum(data, filename));
    return path.join(output, filename);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/** 根据项目版本确定附件名。
 * @param version 项目版本。
 * @returns 版本化 ZIP 文件名。
 * @throws 版本格式无效时抛错。
 */
export function archiveName(version: string): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error('Skill 发布需要稳定的三段版本号');
  return `xiaoe-download-skill-v${version}.zip`;
}

/** 生成与下载工具兼容的 SHA-256 校验行。
 * @param archive ZIP 内容。
 * @param filename ZIP 文件名。
 * @returns 包含散列和文件名的校验行。
 */
export function checksum(archive: Uint8Array, filename: string): string {
  return `${crypto.createHash('sha256').update(archive).digest('hex')}  ${filename}\n`;
}

async function main(): Promise<void> {
  const metadata: unknown = JSON.parse(await fsp.readFile('package.json', 'utf8'));
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !('version' in metadata) ||
    typeof metadata.version !== 'string'
  )
    throw new Error('项目版本无效');
  util.parseArgs({ options: {} });
  const filename = archiveName(metadata.version);
  await packSkill(process.cwd(), filename);
  console.log(`Skill 分发包已生成：release/${filename}`);
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
