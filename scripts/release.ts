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
      if (
        relative
          .split('/')
          .some((name) => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) || name === 'node_modules')
      )
        throw new Error(`非交付文件：${relative}`);
      const stat = await fsp.lstat(from);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error(`交付资源不允许额外符号链接或特殊文件：${from}`);
      if (stat.isDirectory()) {
        for (const name of (await fsp.readdir(from)).sort()) {
          await copy(path.join(from, name), `${relative}/${name}`);
        }
        return;
      }
      if (
        !/^(?:SKILL\.md|scripts\/[^/]+\.mjs|references\/downloader\/[^/]+\.mjs|references\/(?:[^/]+\/)*[^/]+\.(?:md|txt))$/.test(
          relative,
        )
      )
        throw new Error(`非交付文件：${relative}`);
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
    // 仅消费 dist 根级运行文件和同次构建的许可声明，不递归打包发布目录。
    for (const name of (await fsp.readdir(dist)).sort()) {
      if (name.endsWith('.mjs') || name === 'third-party-licenses.txt')
        await copy(path.join(dist, name), `references/downloader/${name}`);
    }
    for (const required of [
      'SKILL.md',
      'scripts/skill.mjs',
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
    const output = path.join(dist, 'release');
    await fsp.rm(output, { recursive: true, force: true });
    await fsp.mkdir(output);
    await fsp.copyFile(archive, path.join(output, filename));
    await fsp.writeFile(path.join(output, `${filename}.sha256`), checksum(data, filename));
    return path.join(output, filename);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

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

/** 生成与下载工具兼容的 SHA-256 校验行。
 * @param archive ZIP 内容。
 * @param filename ZIP 文件名。
 * @returns 包含散列和文件名的校验行。
 */
export function checksum(archive: Uint8Array, filename: string): string {
  return `${crypto.createHash('sha256').update(archive).digest('hex')}  ${filename}\n`;
}

/** 仅创建或更新草稿 Release，拒绝覆盖正式版本。
 * @param tag 已核验的发布 tag。
 * @param repo 目标 GitHub 仓库。
 * @param files 已验收的附件路径。
 * @param gh 执行 GitHub CLI 并返回标准输出的函数。
 * @returns 本次创建或更新的动作。
 * @throws 正式版本已存在、响应无效或 GitHub 操作失败时抛错。
 */
export async function uploadDraft(
  tag: string,
  repo: string,
  files: string[],
  gh: (args: string[]) => Promise<string>,
): Promise<'created' | 'updated'> {
  let release: unknown;
  try {
    release = JSON.parse(await gh(['api', `repos/${repo}/releases/tags/${tag}`]));
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('stderr' in error) ||
      typeof error.stderr !== 'string' ||
      !error.stderr.includes('(HTTP 404)')
    )
      throw error;
    await gh([
      'release',
      'create',
      tag,
      ...files,
      '--repo',
      repo,
      '--verify-tag',
      '--draft',
      '--generate-notes',
      '--title',
      tag,
    ]);
    return 'created';
  }
  if (!release || typeof release !== 'object' || !('draft' in release) || release.draft !== true)
    throw new Error('禁止覆盖正式 Release，请发布新版本');
  await gh(['release', 'upload', tag, ...files, '--repo', repo, '--clobber']);
  return 'updated';
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
  const { values } = util.parseArgs({ options: { upload: { type: 'boolean' } } });
  const tag = process.env.RELEASE_TAG;
  const filename = archiveName(metadata.version, tag);
  if (!values.upload) {
    await packSkill(process.cwd(), filename);
    console.log(`Skill 分发包已生成：dist/release/${filename}`);
    return;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!tag || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error('上传必须明确指定 RELEASE_TAG 和 GITHUB_REPOSITORY');
  const files = [
    path.join('dist/release', filename),
    path.join('dist/release', `${filename}.sha256`),
  ];
  const archive = await fsp.readFile(files[0] ?? '');
  if ((await fsp.readFile(files[1] ?? '', 'utf8')) !== checksum(archive, filename))
    throw new Error('分发包校验失败');
  const gh = async (args: string[]) => (await execFile('gh', args)).stdout.trim();
  // 防止验收后远端 tag 被移动，使 Release 指向与构建内容不同的提交。
  const localTag = (await execFile('git', ['rev-parse', `refs/tags/${tag}`])).stdout.trim();
  const head = (await execFile('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const taggedCommit = (await execFile('git', ['rev-parse', `${tag}^{commit}`])).stdout.trim();
  const remoteTag = await gh(['api', `repos/${repo}/git/ref/tags/${tag}`, '--jq', '.object.sha']);
  if (localTag !== remoteTag || head !== taggedCommit)
    throw new Error('发布 tag 与当前构建提交不一致');
  const action = await uploadDraft(tag, repo, files, gh);
  console.log(
    `已${action === 'created' ? '创建' : '更新'}草稿 Release：${tag}，请人工确认后发布。`,
  );
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
