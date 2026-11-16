import { expect, it } from 'vitest';

import cp from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

const execFile = util.promisify(cp.execFile);

it.skipIf(process.platform === 'win32')(
  '工作流离线验证首次发布、已有版本拒绝及失败门禁，不执行真实 GitHub 操作',
  async () => {
    const workflow = await fsp.readFile('.github/workflows/release.yml', 'utf8');
    const block = workflow.split('      - name: 创建标签并发布已验收的版本\n')[1];
    const script = block
      .split('        run: |\n')[1]
      .split('\n')
      .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
      .join('\n');
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'release workflow '));
    try {
      const bin = path.join(root, 'bin');
      await fsp.mkdir(bin);
      // 两个命令均替换为本地模拟器，执行的是工作流原始 Bash 分支。
      const mock = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = process.env.SCENARIO;
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify([name, ...args]) + '\\n');
const fail = () => process.exit(1);
if (name === 'git') {
  if (args[0] === 'rev-parse') console.log(scenario === 'wrong-tag' ? 'other-sha' : 'tested-sha');
  if (args[0] === 'ls-remote') {
    if (scenario === 'tag-query-failure') fail();
    if (['tag-only', 'wrong-tag', 'fetch-failure'].includes(scenario)) console.log('tag-object\\trefs/tags/v0.1.0');
  }
  if (args[0] === 'fetch' && scenario === 'fetch-failure') fail();
  if (args[0] === 'push' && scenario === 'push-failure') fail();
} else {
  if (args[0] === 'api') {
    if (scenario === 'api-failure') fail();
    if (scenario === 'published' || scenario === 'draft') console.log('123');
  }
  if (args[1] === 'create' && scenario === 'create-failure') fail();
  if (args[1] === 'upload' && scenario === 'upload-failure') fail();
  if (args[1] === 'edit' && scenario === 'publish-failure') fail();
}
`;
      for (const name of ['git', 'gh']) {
        await fsp.writeFile(path.join(bin, name), mock);
        await fsp.chmod(path.join(bin, name), 0o755);
      }
      const release = path.join(root, 'release');
      await fsp.mkdir(release, { recursive: true });
      await fsp.writeFile(path.join(release, 'xiaoe-download-skill-v0.1.0.zip'), 'tested zip');
      await fsp.writeFile(
        path.join(release, 'xiaoe-download-skill-v0.1.0.zip.sha256'),
        'tested checksum',
      );
      for (const scenario of [
        'new',
        'tag-only',
        'draft',
        'published',
        'wrong-tag',
        'api-failure',
        'tag-query-failure',
        'fetch-failure',
        'push-failure',
        'create-failure',
        'upload-failure',
        'publish-failure',
      ]) {
        const log = path.join(root, `${scenario}.jsonl`);
        let success = false;
        try {
          await execFile('bash', ['-c', script], {
            cwd: root,
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH}`,
              SCENARIO: scenario,
              COMMAND_LOG: log,
              RELEASE_TAG: 'v0.1.0',
              RELEASE_SHA: 'tested-sha',
              GH_REPO: 'owner/repo',
            },
          });
          success = true;
        } catch (error) {
          expect(error.code).toBe(1);
        }
        const calls = (await fsp.readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const published = calls.some((call) => call[0] === 'gh' && call[2] === 'edit');
        expect(success, scenario).toBe(['new', 'tag-only'].includes(scenario));
        expect(published, scenario).toBe(success || scenario === 'publish-failure');
        if (success) {
          expect(calls.at(-1)).toEqual(['gh', 'release', 'edit', 'v0.1.0', '--draft=false']);
          expect(calls.some((call) => call[0] === 'git' && call[1] === 'push')).toBe(
            scenario === 'new',
          );
          expect(calls.some((call) => call[0] === 'gh' && call[2] === 'create')).toBe(true);
          const upload = calls.find((call) => call[0] === 'gh' && call[2] === 'upload');
          expect(upload).toEqual([
            'gh',
            'release',
            'upload',
            'v0.1.0',
            'release/xiaoe-download-skill-v0.1.0.zip',
            'release/xiaoe-download-skill-v0.1.0.zip.sha256',
          ]);
        }
        if (
          [
            'published',
            'draft',
            'wrong-tag',
            'api-failure',
            'tag-query-failure',
            'fetch-failure',
          ].includes(scenario)
        )
          expect(calls.some((call) => call[0] === 'gh' && call[1] === 'release')).toBe(false);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  },
);
