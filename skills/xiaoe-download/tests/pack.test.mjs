import { expect, it } from 'vitest';

import cp from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

import { archiveName, checksum, packSkill } from '../../../scripts/release';

const execFile = util.promisify(cp.execFile);

it('版本化附件严格匹配稳定版本及 tag', () => {
  expect(archiveName('0.1.0', 'v0.1.0')).toBe('xiaoe-download-skill-v0.1.0.zip');
  expect(() => archiveName('0.1.0', 'v0.2.0')).toThrow('tag');
  for (const version of ['../secret', '01.1.0', '1.0.0-beta.1'])
    expect(() => archiveName(version)).toThrow('版本');
});

it.skipIf(process.platform === 'win32')(
  '展开指定软链接、保留 chunk，不打包测试、旧附件或源码映射',
  async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill pack '));
    const skill = path.join(root, 'skills/xiaoe-download');
    const dist = path.join(root, 'dist');
    const filename = archiveName('0.1.0');
    try {
      await fsp.mkdir(path.join(skill, 'scripts'), { recursive: true });
      await fsp.mkdir(path.join(skill, 'references'));
      await fsp.mkdir(dist);
      await fsp.symlink('../../../dist', path.join(skill, 'references/downloader'));
      for (const name of ['SKILL.md', 'scripts/skill.mjs', 'scripts/skill-environment.mjs'])
        await fsp.writeFile(path.join(skill, name), name);
      for (const name of ['cli.mjs', 'shared.mjs', 'third-party-licenses.txt', 'cli.mjs.map'])
        await fsp.writeFile(path.join(dist, name), name);
      await fsp.mkdir(path.join(skill, 'tests'));
      await fsp.writeFile(path.join(skill, 'tests/private.test.mjs'), 'not delivered');
      await fsp.mkdir(path.join(dist, 'release'));
      await fsp.writeFile(path.join(dist, 'release/old.zip'), 'stale');
      const archive = await packSkill(root, filename);
      const data = await fsp.readFile(archive);
      expect(await fsp.readFile(`${archive}.sha256`, 'utf8')).toBe(checksum(data, filename));
      expect((await execFile('unzip', ['-Z1', archive])).stdout.trim().split('\n')).toEqual([
        'xiaoe-download/SKILL.md',
        'xiaoe-download/references/downloader/cli.mjs',
        'xiaoe-download/references/downloader/shared.mjs',
        'xiaoe-download/references/downloader/third-party-licenses.txt',
        'xiaoe-download/scripts/skill-environment.mjs',
        'xiaoe-download/scripts/skill.mjs',
      ]);
      expect(await fsp.readdir(path.join(dist, 'release'))).toEqual([
        filename,
        `${filename}.sha256`,
      ]);
      await packSkill(root, filename);
      expect(await fsp.readFile(archive)).toEqual(data);
      const extracted = path.join(root, 'extracted');
      await execFile('unzip', ['-q', archive, '-d', extracted]);
      expect(
        (
          await fsp.lstat(path.join(extracted, 'xiaoe-download/references/downloader/cli.mjs'))
        ).isSymbolicLink(),
      ).toBe(false);
      expect(
        await fsp.readFile(
          path.join(extracted, 'xiaoe-download/references/downloader/shared.mjs'),
          'utf8',
        ),
      ).toBe('shared.mjs');
      await fsp.writeFile(path.join(skill, 'scripts/.env'), 'secret');
      await expect(packSkill(root, filename)).rejects.toThrow('非交付');
      await fsp.unlink(path.join(skill, 'scripts/.env'));
      await fsp.symlink(path.join(dist, 'cli.mjs'), path.join(skill, 'scripts/linked.mjs'));
      await expect(packSkill(root, filename)).rejects.toThrow('符号链接');
      await fsp.unlink(path.join(skill, 'scripts/linked.mjs'));
      await fsp.unlink(path.join(dist, 'cli.mjs'));
      await expect(packSkill(root, filename)).rejects.toThrow('必要文件');
      await fsp.unlink(path.join(skill, 'references/downloader'));
      await fsp.symlink(root, path.join(skill, 'references/downloader'));
      await expect(packSkill(root, filename)).rejects.toThrow('指向项目 dist');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  },
);

it('Skill 运行模块只使用 Node 内置模块，核心源码不依赖 Skill', async () => {
  for (const name of await fsp.readdir('skills/xiaoe-download/scripts')) {
    expect(name.endsWith('.mjs')).toBe(true);
    const source = await fsp.readFile(path.join('skills/xiaoe-download/scripts', name), 'utf8');
    // 同目录手写模块及 Node 内置模块允许；下载器只能由子进程调用。
    for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(.*?)\1/g))
      expect(match[2].startsWith('node:') || /^\.\/[^/]+\.mjs$/.test(match[2])).toBe(true);
  }
  for (const name of await fsp.readdir('src')) {
    expect(name.startsWith('skill')).toBe(false);
    if (name.endsWith('.ts'))
      expect(await fsp.readFile(path.join('src', name), 'utf8')).not.toMatch(
        /from\s+['"][^'"]*skills\//,
      );
  }
});
