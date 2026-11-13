import { expect, it } from 'vitest';

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { zipSync } from 'fflate';

import { archiveName, checksum, packSkill, unpackSkill } from '../scripts/skill-package';

it('版本化附件严格匹配稳定版本及 tag', () => {
  expect(archiveName('0.1.0', 'v0.1.0')).toBe('xiaoe-download-skill-v0.1.0.zip');
  expect(() => archiveName('0.1.0', 'v0.2.0')).toThrow('tag');
  for (const version of ['../secret', '01.1.0', '1.0.0-beta.1'])
    expect(() => archiveName(version)).toThrow('版本');
});

it('打包确定性、保留所有 chunk，并拒绝凭据、缺失文件及特殊路径', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill package '));
  const source = path.join(root, 'source');
  try {
    await fsp.mkdir(path.join(source, 'scripts'), { recursive: true });
    await fsp.mkdir(path.join(source, 'references'));
    for (const name of [
      'SKILL.md',
      'scripts/skill.mjs',
      'scripts/cli.mjs',
      'scripts/shared.mjs',
      'references/third-party-licenses.txt',
    ])
      await fsp.writeFile(path.join(source, name), name);
    const archive = await packSkill(source);
    expect(await packSkill(source)).toEqual(archive);
    expect(checksum(archive, 'skill.zip')).toMatch(/^[a-f0-9]{64}  skill\.zip\n$/);
    const extracted = await unpackSkill(archive, path.join(root, 'extracted files'));
    expect(await fsp.readFile(path.join(extracted, 'scripts/shared.mjs'), 'utf8')).toBe(
      'scripts/shared.mjs',
    );
    await fsp.writeFile(path.join(source, 'references/.env'), 'secret');
    await expect(packSkill(source)).rejects.toThrow('非交付');
    await fsp.unlink(path.join(source, 'references/.env'));
    if (process.platform !== 'win32') {
      const link = path.join(source, 'references/linked.txt');
      await fsp.symlink(path.join(source, 'SKILL.md'), link);
      await expect(packSkill(source)).rejects.toThrow('符号链接');
      await fsp.unlink(link);
    }
    await fsp.unlink(path.join(source, 'scripts/cli.mjs'));
    await expect(packSkill(source)).rejects.toThrow('必要文件');
    for (const name of [
      'xiaoe-download/../escape.txt',
      'xiaoe-download/scripts/C:escape.mjs',
      'xiaoe-download/references/node_modules/license.txt',
    ])
      await expect(
        unpackSkill(zipSync({ [name]: new Uint8Array([1]) }), path.join(root, 'unsafe')),
      ).rejects.toThrow('非交付');
    await expect(fsp.access(path.join(root, 'unsafe'))).rejects.toThrow();
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
