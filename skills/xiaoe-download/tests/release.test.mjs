import { expect, it, vi } from 'vitest';

import { uploadDraft } from '../../../scripts/release';

const tag = 'v0.1.0';
const repo = 'owner/repo';
const files = ['skill.zip', 'skill.zip.sha256'];

it('仅在 Release 不存在时创建草稿，并要求远端 tag 已存在', async () => {
  const gh = vi
    .fn()
    .mockRejectedValueOnce({ stderr: 'gh: Not Found (HTTP 404)' })
    .mockResolvedValueOnce('');
  expect(await uploadDraft(tag, repo, files, gh)).toBe('created');
  expect(gh.mock.calls[1]?.[0]).toEqual([
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
});

it('草稿允许重试上传 ZIP 和校验文件', async () => {
  const gh = vi
    .fn()
    .mockResolvedValueOnce(JSON.stringify({ draft: true }))
    .mockResolvedValueOnce('');
  expect(await uploadDraft(tag, repo, files, gh)).toBe('updated');
  expect(gh.mock.calls[1]?.[0]).toEqual([
    'release',
    'upload',
    tag,
    ...files,
    '--repo',
    repo,
    '--clobber',
  ]);
});

it('正式版本或未知状态禁止上传', async () => {
  for (const response of [{ draft: false }, {}, null]) {
    const gh = vi.fn().mockResolvedValue(JSON.stringify(response));
    await expect(uploadDraft(tag, repo, files, gh)).rejects.toThrow('禁止覆盖');
    expect(gh).toHaveBeenCalledTimes(1);
  }
});

it('认证、网络、响应解析及创建失败均不被误当成可重试草稿', async () => {
  for (const error of [{ stderr: 'Forbidden (HTTP 403)' }, new Error('network failed')]) {
    const gh = vi.fn().mockRejectedValue(error);
    await expect(uploadDraft(tag, repo, files, gh)).rejects.toBe(error);
    expect(gh).toHaveBeenCalledTimes(1);
  }
  const malformed = vi.fn().mockResolvedValue('invalid json');
  await expect(uploadDraft(tag, repo, files, malformed)).rejects.toThrow();
  expect(malformed).toHaveBeenCalledTimes(1);
  const createError = new Error('upload failed');
  const create = vi
    .fn()
    .mockRejectedValueOnce({ stderr: '(HTTP 404)' })
    .mockRejectedValueOnce(createError);
  await expect(uploadDraft(tag, repo, files, create)).rejects.toBe(createError);
  expect(create).toHaveBeenCalledTimes(2);
});
