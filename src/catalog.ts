import { asRecord, contentKind, stringField } from './model';

import type { Content, Course } from './model';

/** 目录适配器需要的浏览器内同源 API 能力。 */
export type CourseApi = (
  endpoint: string,
  data: Record<string, string | number>,
) => Promise<unknown>;

/** 从真实购买记录响应读取最小必要字段，不保存用户资料或订单明细。
 * @param value /payRecords 的 JSON 响应。
 * @param origin 目标店铺的源。
 * @returns 当前分页的课程列表。
 * @throws 响应结构变化或必要字段缺失时抛错。
 */
export function parsePurchases(value: unknown, origin: string): Course[] {
  if (!Array.isArray(value)) throw new Error('购买记录响应不是数组，请检查登录状态或接口变化');
  return value.map((item) => {
    const record = asRecord(item);
    if (!record) throw new Error('购买记录存在无效条目');
    const id = stringField(record, 'resource_id');
    const title = stringField(record, 'purchase_name');
    const appId = stringField(record, 'app_id');
    const resourceType = record.resource_type;
    if (!id || !title || !appId || typeof resourceType !== 'number') {
      throw new Error('购买记录缺少资源 ID、标题、店铺或类型');
    }
    const route =
      resourceType === 50
        ? `/p/course/ecourse/${encodeURIComponent(id)}?type=2&sub_course_list_mode=0`
        : stringField(record, 'content_url');
    if (!route) throw new Error(`无法确定课程页面：${title}`);
    const url = new URL(route, origin);
    if (url.origin !== origin) throw new Error(`课程页面不属于当前店铺：${title}`);
    return { id, title, appId, resourceType, url: url.href };
  });
}

/** 递归遍历课程目录及分页；课程、章节节点不当作可下载内容。
 * @param course 当前购买课程。
 * @param api 使用当前登录会话的同源 API 调用器。
 * @returns 去重后的所有内容，保留目录排序。
 * @throws 接口结构、权限或分页不完整时抛错，不返回部分列表作为完整结果。
 */
export async function discoverCourseContents(course: Course, api: CourseApi): Promise<Content[]> {
  if (course.resourceType !== 50) {
    return [
      {
        id: course.id,
        title: course.title,
        kind: contentKind(course.resourceType),
        url: course.url,
        courseId: course.id,
        subCourseId: '',
        chapter: [],
        available: true,
      },
    ];
  }
  const result = new Map<string, Content>();
  const visited = new Set<string>();
  const endpoint = '/xe.course.business_go.avoidlogin.e_course.resource_catalog_list.get/1.0.0';
  async function walk(parent: string, subCourseId: string, chapter: string[]): Promise<void> {
    const key = `${subCourseId}:${parent}`;
    if (visited.has(key)) return;
    visited.add(key);
    const seen = new Set<string>();
    for (let page = 1; page <= 1000; page += 1) {
      const value = asRecord(
        await api(endpoint, {
          app_id: course.appId,
          course_id: course.id,
          resource_id: '',
          p_id: parent,
          sub_course_id: subCourseId,
          order: 'asc',
          page,
          page_size: 50,
          is_display_auth_sections: 0,
        }),
      );
      if (!value || !Array.isArray(value.list) || typeof value.total !== 'number')
        throw new Error('课程目录响应缺少 list / total');
      if (value.available === 0 || value.subscribe === 0)
        throw new Error(`课程未授权或已过期：${course.title}`);
      let added = 0;
      for (const item of value.list) {
        const record = asRecord(item);
        if (!record) throw new Error('目录条目不是对象');
        const id = stringField(record, 'resource_id');
        const title = stringField(record, 'resource_title') || stringField(record, 'chapter_title');
        if (!id || !title) throw new Error('目录条目缺少资源 ID / 标题');
        if (seen.has(id)) continue;
        seen.add(id);
        added += 1;
        const type = record.resource_type;
        if (record.chapter_type === 1 || id.startsWith('chap_')) {
          await walk(id, subCourseId, [...chapter, title]);
        } else if (type === 50 || id.startsWith('course_')) {
          await walk('0', stringField(record, 'sub_course_id') || id, [...chapter, title]);
        } else {
          if (typeof type !== 'number') throw new Error(`目录条目类型无效：${title}`);
          const jump = stringField(record, 'jump_url');
          const url = jump ? new URL(jump, course.url) : undefined;
          if (url && url.origin !== new URL(course.url).origin)
            throw new Error(`资源跳转到其他店铺：${title}`);
          if (url) {
            url.searchParams.set('course_id', course.id);
            url.searchParams.set('product_id', course.id);
            url.searchParams.set('sub_course_id', subCourseId);
          }
          result.set(id, {
            id,
            title,
            kind: contentKind(type),
            url: url?.href ?? '',
            courseId: course.id,
            subCourseId,
            chapter,
            available: record.unlock_state !== 0,
          });
        }
      }
      if (seen.size >= value.total) return;
      if (added === 0)
        throw new Error(`课程目录分页未完成：${chapter.join(' / ') || course.title}`);
    }
    throw new Error('课程目录超过分页上限');
  }
  await walk('0', '', []);
  const sub = await api('/xe.course.business_go.avoidlogin.e_course.sub.course.list/1.0.0', {
    course_id: course.id,
  });
  if (!Array.isArray(sub)) throw new Error('子课程列表响应不是数组');
  for (const item of sub) {
    const record = asRecord(item);
    if (!record) throw new Error('子课程条目无效');
    const id = stringField(record, 'sub_course_id') || stringField(record, 'course_id');
    if (!id) throw new Error('子课程缺少 ID');
    await walk('0', id, [
      stringField(record, 'title') || stringField(record, 'sub_course_title') || id,
    ]);
  }
  if (result.size === 0) throw new Error(`课程目录为空：${course.title}`);
  return [...result.values()];
}
