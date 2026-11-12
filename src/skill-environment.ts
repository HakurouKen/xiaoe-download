import crypto from 'node:crypto';
import cp from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 根据平台选择用户状态目录，不依赖当前工作目录。
 * @param platform 操作系统标识。
 * @param home 用户主目录。
 * @param env 环境变量；仅采用绝对路径覆盖。
 * @returns 下载器的绝对状态目录。
 */
export function stateDirectory(
  platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA;
    return paths.join(
      base && paths.isAbsolute(base) ? base : paths.join(home, 'AppData', 'Local'),
      'xiaoe-download',
    );
  }
  if (platform === 'darwin')
    return paths.join(home, 'Library', 'Application Support', 'xiaoe-download');
  const base = env.XDG_STATE_HOME;
  return paths.join(
    base && paths.isAbsolute(base) ? base : paths.join(home, '.local', 'state'),
    'xiaoe-download',
  );
}

/** 生成包外、按店铺隔离的缓存路径。
 * @param storeUrl 目标店铺 URL。
 * @returns 当前用户状态目录中的 Cookie 文件路径。
 */
export function skillCookieCache(storeUrl: string): string {
  const key = crypto
    .createHash('sha256')
    .update(new URL(storeUrl).origin)
    .digest('hex')
    .slice(0, 24);
  return path.join(stateDirectory(), 'cookies', `${key}.json`);
}

/** 检查外部命令，不经 Shell 展开路径或参数。
 * @param executable 命令名或可执行文件路径。
 * @param args 检查参数。
 * @returns 是否正常执行并以零状态退出。
 */
export async function commandAvailable(executable: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = cp.spawn(executable, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 10000);
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      resolve(ready);
    };
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/** 解析现有父目录的真实路径，兼容尚未创建的目录及系统路径别名。
 * @param directory 要检查的绝对目录。
 * @returns 消除符号链接后的绝对目录。
 * @throws 父目录无法访问或解析时抛错。
 */
export async function canonicalDirectory(directory: string): Promise<string> {
  try {
    return await fsp.realpath(directory);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await canonicalDirectory(parent), path.basename(directory));
  }
}

/** 准备用户状态目录；Windows 使用当前账户 ACL 而非依赖 POSIX mode。
 * @returns 准备完成的状态目录。
 * @throws 无法创建目录或限制目录访问时抛错。
 */
export async function prepareStateDirectory(): Promise<string> {
  const directory = stateDirectory();
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const user = os.userInfo().username;
    const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
    if (
      !(await commandAvailable('icacls.exe', [
        directory,
        '/inheritance:r',
        '/grant:r',
        `${account}:(OI)(CI)F`,
      ]))
    )
      throw new Error('无法限制用户状态目录 ACL，请检查当前账户权限');
  } else await fsp.chmod(directory, 0o700);
  return directory;
}
