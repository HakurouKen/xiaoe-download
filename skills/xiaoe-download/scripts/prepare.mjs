#!/usr/bin/env node
import fsp from 'node:fs/promises';
import util from 'node:util';

import { checkedOutput, prepareStateDirectory, requireNode24 } from './skill-environment.mjs';

async function main() {
  const { values } = util.parseArgs({
    options: { output: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log('准备目录（写操作）：node <skill目录>/scripts/prepare.mjs --output <包外绝对路径>');
    return;
  }
  requireNode24();
  const output = await checkedOutput(values.output);
  const directory = await prepareStateDirectory();
  await fsp.mkdir(output, { recursive: true });
  console.log(JSON.stringify({ stateDirectory: directory, output, prepared: true }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
