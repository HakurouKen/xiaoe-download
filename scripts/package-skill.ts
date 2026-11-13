import fsp from 'node:fs/promises';
import path from 'node:path';

import { archiveName, checksum, packSkill } from './skill-package';

async function main(): Promise<void> {
  const metadata: unknown = JSON.parse(await fsp.readFile('package.json', 'utf8'));
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !('version' in metadata) ||
    typeof metadata.version !== 'string'
  )
    throw new Error('项目版本无效');
  const filename = archiveName(metadata.version, process.env.RELEASE_TAG);
  const archive = await packSkill('dist/skill/xiaoe-download');
  await fsp.rm('dist/release', { recursive: true, force: true });
  await fsp.mkdir('dist/release', { recursive: true });
  await fsp.writeFile(path.join('dist/release', filename), archive);
  await fsp.writeFile(path.join('dist/release', `${filename}.sha256`), checksum(archive, filename));
  console.log(`Skill 分发包已生成：dist/release/${filename}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
