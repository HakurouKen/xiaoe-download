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
