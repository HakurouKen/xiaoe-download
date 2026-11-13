import cp from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import util from 'node:util';

import { archiveName, checksum } from './skill-package';
import { uploadDraft } from './skill-release';

const execFile = util.promisify(cp.execFile);

async function main(): Promise<void> {
  const tag = process.env.RELEASE_TAG;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!tag || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error('必须明确指定 RELEASE_TAG 和 GITHUB_REPOSITORY');
  const metadata: unknown = JSON.parse(await fsp.readFile('package.json', 'utf8'));
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !('version' in metadata) ||
    typeof metadata.version !== 'string'
  )
    throw new Error('项目版本无效');
  const filename = archiveName(metadata.version, tag);
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
