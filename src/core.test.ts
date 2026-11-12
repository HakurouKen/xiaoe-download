import { describe, expect, it } from 'vitest';
import { allocateContentNames, allocateNames, safeTitle } from './files';
import { discoverCourseContents, parsePurchases } from './catalog';
import { parseMediaSources, resolveMediaSources } from './media-source';
import { selectHlsVariant } from './hls';
import { StoreClient } from './store';
import type { Content, Course } from './model';

const course: Course = {
  id: 'course_a',
  title: '课程',
  url: 'https://store.test/p/course/ecourse/course_a',
  appId: 'appA',
  resourceType: 50,
};
const content: Content = {
  id: 'live_a',
  title: '回放',
  kind: 'replay',
  url: '',
  courseId: course.id,
  subCourseId: '',
  chapter: [],
  available: true,
};
describe('标题和目录', () => {
  it('每门课程从 01 编号，保留安全标题和同名摘要，不给课程文件夹编号', () => {
    const items = [
      { id: 'a', title: 'a:b/c' },
      { id: 'b', title: '同名' },
      { id: 'c', title: '同名' },
    ];
    const names = allocateContentNames(items);
    const titles = allocateNames(items);
    expect(names.get('a')).toBe('01-a b c');
    expect(names.get('b')).toBe(`02-${titles.get('b')}`);
    expect(names.get('c')).toBe(`03-${titles.get('c')}`);
    expect(allocateContentNames([{ id: 'd', title: '另一课程' }]).get('d')).toBe('01-另一课程');
    expect(titles.get('a')).toBe('a b c');
  });
  it('空格替换非法字符并避免同名资源覆盖', () => {
    expect(safeTitle('a:b/c')).toBe('a b c');
    expect(Buffer.byteLength(safeTitle('中'.repeat(200)))).toBeLessThanOrEqual(180);
    const names = allocateNames([
      { id: 'a', title: '同名' },
      { id: 'b', title: '同名' },
    ]);
    expect(names.get('a')).not.toBe(names.get('b'));
  });
  it('验证购买记录，拒绝登录页或跨店铺跳转', () => {
    expect(() => parsePurchases({ code: 1 }, 'https://store.test')).toThrow();
    expect(() =>
      parsePurchases(
        [
          {
            resource_id: 'a',
            purchase_name: 'a',
            app_id: 'a',
            resource_type: 3,
            content_url: 'https://other.test/a',
          },
        ],
        'https://store.test',
      ),
    ).toThrow();
  });
  it('分页递归章节，不把章节下载成视频', async () => {
    const calls: string[] = [];
    const result = await discoverCourseContents(course, async (endpoint, data) => {
      if (endpoint.includes('sub.course')) return [];
      calls.push(`${data.p_id}:${data.page}`);
      if (data.p_id === '0')
        return {
          total: 1,
          list: [{ resource_id: 'chap_a', chapter_title: '第一章', chapter_type: 1 }],
        };
      return {
        total: 2,
        list: [
          {
            resource_id: `v_${data.page}`,
            resource_title: `视频${data.page}`,
            resource_type: 3,
            jump_url: `/p/course/video/v_${data.page}`,
          },
        ],
      };
    });
    expect(calls).toEqual(['0:1', 'chap_a:1', 'chap_a:2']);
    expect(result.map((item) => item.id)).toEqual(['v_1', 'v_2']);
    expect(result[0]?.chapter).toEqual(['第一章']);
  });
  it('目录分页重复时拒绝返回部分成功', async () => {
    await expect(
      discoverCourseContents(course, async () => ({
        total: 2,
        list: [{ resource_id: 'v', resource_title: 'v', resource_type: 3 }],
      })),
    ).rejects.toThrow('分页未完成');
  });
});
describe('媒体解析', () => {
  it('选择最高画质并合并签名，音频只选择音频', () => {
    const value = {
      play_list: {
        '360p_hls': { is_support: true, play_url: 'https://cdn.test/low.m3u8' },
        '720p_hls': {
          is_support: true,
          encrypt_type: 'normal',
          play_url: 'https://cdn.test/main.m3u8?sign=old',
          ext: { param: 'sign=new&t=123' },
        },
        mp3: { is_support: true, play_url: 'https://cdn.test/a.mp3' },
      },
    };
    expect(parseMediaSources(value, false)[0]?.url).toBe(
      'https://cdn.test/main.m3u8?sign=new&t=123',
    );
    expect(parseMediaSources(value, true)[0]?.url).toBe('https://cdn.test/a.mp3');
  });
  it('主清单保留最高画质关联的独立音轨', () => {
    expect(
      selectHlsVariant(
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200,AUDIO="a"\nhigh.m3u8',
      )?.audio,
    ).toContain('audio.m3u8');
  });
  it('直播使用回放接口，禁止下载仍在直播的拉流地址', async () => {
    const client = new StoreClient(course.url, {
      userAgent: 'test',
      cookieHeader: async () => '',
      run: async (operation) => operation(),
    });
    client.get = async (endpoint) =>
      endpoint.includes('base_info')
        ? {
            available_info: { available: true },
            alive_info: { alive_state: 3 },
            alive_conf: { is_lookback: 1 },
            alive_play: { url: 'https://cdn.test/live.m3u8' },
          }
        : { aliveVideoUrl: 'https://cdn.test/replay.m3u8', videoUrlValid: '1' };
    expect(await resolveMediaSources(client, content, course.appId)).toEqual([
      { url: 'https://cdn.test/replay.m3u8', hls: true, audioOnly: false },
    ]);
    client.get = async () => ({
      available_info: { available: true },
      alive_info: { alive_state: 1 },
      alive_conf: { is_lookback: 1 },
    });
    await expect(resolveMediaSources(client, content, course.appId)).rejects.toThrow('尚未结束');
  });
});
