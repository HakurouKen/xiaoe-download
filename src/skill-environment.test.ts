import { describe, expect, it } from 'vitest';

import { commandAvailable, stateDirectory } from './skill-environment';

describe('Skill 环境', () => {
  it('按系统选择包外状态目录并忽略相对环境变量', () => {
    expect(stateDirectory('darwin', '/Users/test', {})).toBe(
      '/Users/test/Library/Application Support/xiaoe-download',
    );
    expect(stateDirectory('linux', '/home/test', { XDG_STATE_HOME: '/state' })).toBe(
      '/state/xiaoe-download',
    );
    expect(stateDirectory('linux', '/home/test', { XDG_STATE_HOME: 'relative' })).toBe(
      '/home/test/.local/state/xiaoe-download',
    );
    expect(stateDirectory('win32', 'C:\\Users\\test', { LOCALAPPDATA: 'D:\\State' })).toBe(
      'D:\\State\\xiaoe-download',
    );
    expect(stateDirectory('win32', 'C:\\Users\\test', {})).toBe(
      'C:\\Users\\test\\AppData\\Local\\xiaoe-download',
    );
  });
  it('通过实际退出状态检查工具，不经 Shell 执行', async () => {
    expect(await commandAvailable(process.execPath, ['--version'])).toBe(true);
    expect(await commandAvailable(process.execPath, ['-e', 'process.exit(2)'])).toBe(false);
    expect(await commandAvailable('xiaoe-missing-executable', ['--version'])).toBe(false);
  });
});
