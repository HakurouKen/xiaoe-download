/** 支持实体下载的内容种类；未知类型单独记录失败。 */
export type ContentKind = 'video' | 'audio' | 'replay' | 'text' | 'document' | 'unknown';

/** 购买记录中的课程；单独购买的媒体也视为一个课程目录。 */
export interface Course {
  id: string;
  title: string;
  url: string;
  appId: string;
  resourceType: number;
}

/** 课程中的单个资源，章节信息只用于清单，不额外创建章节文件夹。 */
export interface Content {
  id: string;
  title: string;
  kind: ContentKind;
  url: string;
  courseId: string;
  subCourseId: string;
  chapter: string[];
  available: boolean;
}

/** 只在内存使用的短期播放地址。 */
export interface MediaSource {
  url: string;
  hls: boolean;
  audioOnly: boolean;
}

/** 已确认具有全文访问权限的图文正文，不包含页面外壳。 */
export interface ArticleSource {
  html: string;
  baseUrl: string;
}

/** 文档原文件地址；签名地址仅在内存使用。 */
export interface DocumentSource {
  url: string;
  filename: string;
  size?: number;
}

/** 将外部 JSON 收窄为对象，不对未验证响应做类型断言。
 * @param value 待验证的 JSON 值。
 * @returns JSON 对象；非对象返回 undefined。
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 读取 JSON 字符串字段。
 * @param record 外部 JSON 对象。
 * @param key 字段名称。
 * @returns 字符串或空字符串。
 */
export function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** 将资源类型映射到本轮支持的种类。
 * @param type 小鹅通 resource_type。
 * @returns 内容种类；未支持的类型明确返回 unknown。
 */
export function contentKind(type: number): ContentKind {
  switch (type) {
    case 1:
      return 'text';
    case 2:
      return 'audio';
    case 3:
      return 'video';
    case 4:
      return 'replay';
    case 51:
      return 'document';
    default:
      return 'unknown';
  }
}

/** 去掉错误中的 URL 查询签名及常见凭据，避免写入下载清单。
 * @param error 捕获到的异常。
 * @returns 可安全记录的错误说明。
 */
export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => url.split('?')[0] ?? '[url]')
    .replace(/(?:token|sign|cookie|authorization)\s*[:=]\s*\S+/gi, '[凭据已隐藏]')
    .slice(0, 1000);
}
