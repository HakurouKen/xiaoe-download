import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import filenamify from 'filenamify';

/** 将标题转换为安全文件名，非法字符替换为空格，控制 UTF-8 字节长度。
 * @param title 原始课程或内容标题。
 * @returns 保留标题的文件名；空标题使用“未命名”。
 */
export function safeTitle(title: string): string {
  let value = filenamify(title, { replacement: ' ', maxLength: 100 }).trim() || '未命名';
  const segments = Array.from(
    new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value),
    (item) => item.segment,
  );
  while (Buffer.byteLength(value, 'utf8') > 180) {
    segments.pop();
    value = segments.join('');
  }
  return value || '未命名';
}

/** 在同一目录内为同名资源分配稳定的名称，不覆盖其他标题或资源。
 * @param items 具有稳定 ID 和标题的条目。
 * @returns ID 到安全基础文件名的映射；冲突时追加短 ID 摘要。
 */
export function allocateNames(items: { id: string; title: string }[]): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const key = safeTitle(item.title).normalize('NFC').toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), item.id]);
  }
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const item of items) {
    const base = safeTitle(item.title);
    const key = base.normalize('NFC').toLowerCase();
    let name =
      (groups.get(key)?.length ?? 0) > 1
        ? `${base} [${crypto.createHash('sha256').update(item.id).digest('hex').slice(0, 10)}]`
        : base;
    let suffix = 1;
    while (used.has(name.normalize('NFC').toLowerCase()))
      name = `${base} [${crypto.createHash('sha256').update(item.id).digest('hex').slice(0, 10)}-${suffix++}]`;
    used.add(name.normalize('NFC').toLowerCase());
    result.set(item.id, name);
  }
  return result;
}

/** 按完整课程目录顺序为内容添加序号，每门课程从 01 开始。
 * @param items 按网页展示顺序排列的完整内容目录，不能预先过滤下载目标。
 * @returns ID 到带至少两位序号的安全基础文件名映射。
 */
export function allocateContentNames(items: { id: string; title: string }[]): Map<string, string> {
  const names = allocateNames(items);
  return new Map(
    items.map((item, index) => [
      item.id,
      `${String(index + 1).padStart(2, '0')}-${names.get(item.id) ?? safeTitle(item.title)}`,
    ]),
  );
}

/** 原子保存可恢复的下载清单，不存储播放签名或 Cookie。
 * @param filename 目标 JSON 路径。
 * @param value 清单对象。
 * @returns 文件写入完成。
 */
export async function writeJson(filename: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, filename);
}
