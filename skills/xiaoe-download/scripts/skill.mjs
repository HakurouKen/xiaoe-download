#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import util from "node:util";
import crypto from "node:crypto";
import os from "node:os";
import childProcess from "node:child_process";
//#region src/skill-environment.ts
/** 根据平台选择用户状态目录，不依赖当前工作目录。
* @param platform 操作系统标识。
* @param home 用户主目录。
* @param env 环境变量；仅采用绝对路径覆盖。
* @returns 下载器的绝对状态目录。
*/
function stateDirectory(platform = process.platform, home = os.homedir(), env = process.env) {
	const paths = platform === "win32" ? path.win32 : path.posix;
	if (platform === "win32") {
		const base = env.LOCALAPPDATA;
		return paths.join(base && paths.isAbsolute(base) ? base : paths.join(home, "AppData", "Local"), "xiaoe-download");
	}
	if (platform === "darwin") return paths.join(home, "Library", "Application Support", "xiaoe-download");
	const base = env.XDG_STATE_HOME;
	return paths.join(base && paths.isAbsolute(base) ? base : paths.join(home, ".local", "state"), "xiaoe-download");
}
/** 生成包外、按店铺隔离的缓存路径。
* @param storeUrl 目标店铺 URL。
* @returns 当前用户状态目录中的 Cookie 文件路径。
*/
function skillCookieCache(storeUrl) {
	const key = crypto.createHash("sha256").update(new URL(storeUrl).origin).digest("hex").slice(0, 24);
	return path.join(stateDirectory(), "cookies", `${key}.json`);
}
/** 检查外部命令，不经 Shell 展开路径或参数。
* @param executable 命令名或可执行文件路径。
* @param args 检查参数。
* @returns 是否正常执行并以零状态退出。
*/
async function commandAvailable(executable, args) {
	return new Promise((resolve) => {
		const child = childProcess.spawn(executable, args, { stdio: "ignore" });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve(false);
		}, 1e4);
		const finish = (ready) => {
			clearTimeout(timer);
			resolve(ready);
		};
		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
	});
}
/** 解析现有父目录的真实路径，兼容尚未创建的目录及系统路径别名。
* @param directory 要检查的绝对目录。
* @returns 消除符号链接后的绝对目录。
* @throws 父目录无法访问或解析时抛错。
*/
async function canonicalDirectory(directory) {
	try {
		return await fsp.realpath(directory);
	} catch (error) {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
		const parent = path.dirname(directory);
		if (parent === directory) throw error;
		return path.join(await canonicalDirectory(parent), path.basename(directory));
	}
}
/** 准备用户状态目录；Windows 使用当前账户 ACL 而非依赖 POSIX mode。
* @returns 准备完成的状态目录。
* @throws 无法创建目录或限制目录访问时抛错。
*/
async function prepareStateDirectory() {
	const directory = stateDirectory();
	await fsp.mkdir(directory, {
		recursive: true,
		mode: 448
	});
	if (process.platform === "win32") {
		const user = os.userInfo().username;
		if (!await commandAvailable("icacls.exe", [
			directory,
			"/inheritance:r",
			"/grant:r",
			`${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user}:(OI)(CI)F`
		])) throw new Error("无法限制用户状态目录 ACL，请检查当前账户权限");
	} else await fsp.chmod(directory, 448);
	return directory;
}
//#endregion
//#region src/skill.ts
async function main() {
	const { values, positionals } = util.parseArgs({
		allowPositionals: true,
		options: {
			doctor: { type: "boolean" },
			prepare: { type: "boolean" },
			url: { type: "string" },
			output: { type: "string" },
			cdp: { type: "string" },
			"cookie-cache": { type: "string" },
			"refresh-cookie": { type: "boolean" },
			concurrency: { type: "string" },
			kinds: { type: "string" },
			ffmpeg: { type: "string" },
			ffprobe: { type: "string" },
			"catalog-only": { type: "boolean" },
			help: {
				type: "boolean",
				short: "h"
			}
		}
	});
	if (values.help) {
		console.log("Skill 入口：node <skill目录>/scripts/skill.mjs --doctor [--cdp 地址]\n准备目录：--prepare --output <绝对路径>\n下载：<all|list|course|media> [目标] --url <购买记录URL> --output <绝对路径> [CLI选项]\n外部环境：Node.js 24；媒体需要 ffmpeg、ffprobe；首次认证需要已登录 Chrome CDP。\nSkill 强制指定包外绝对输出路径，自动管理用户缓存，不接受 --cookie-cache。\n下面是底层 cli.mjs 的选项，默认 downloads 和自定义缓存仅适用于直接调用 cli.mjs：");
		process.argv = [
			process.argv[0] ?? "node",
			"cli",
			"--help"
		];
		await import(new URL("./cli.mjs", import.meta.url).href);
		return;
	}
	if (!(Number(process.versions.node.split(".")[0]) === 24)) throw new Error("需要 Node.js 24，请在获得用户许可后安装并重试");
	if (values.doctor) {
		const ffmpeg = await commandAvailable(values.ffmpeg ?? "ffmpeg", ["-version"]);
		const ffprobe = await commandAvailable(values.ffprobe ?? "ffprobe", ["-version"]);
		let cdp = "未检查；缓存有效时无需 Chrome，首次或刷新登录态需用户开启调试并允许连接";
		const endpoint = values.cdp;
		if (endpoint && /^https?:/.test(endpoint)) try {
			const response = await fetch(new URL("/json/version", endpoint), { signal: AbortSignal.timeout(5e3) });
			cdp = response.ok ? "HTTP 调试服务可达；尚未验证店铺登录态" : `HTTP ${response.status}；请检查 Chrome 调试地址`;
		} catch {
			cdp = "HTTP 调试服务不可达；请用户开启调试并确认地址";
		}
		console.log(JSON.stringify({
			node: process.versions.node,
			ffmpeg,
			ffprobe,
			stateDirectory: stateDirectory(),
			cdp,
			prepared: false
		}, null, 2));
		return;
	}
	if (!values.output || !path.isAbsolute(values.output)) throw new Error("请先确认并指定 --output 绝对路径");
	const skillRoot = await canonicalDirectory(path.resolve(import.meta.dirname, ".."));
	const output = await canonicalDirectory(path.resolve(values.output));
	for (const directory of [output, await canonicalDirectory(stateDirectory())]) {
		const relative = path.relative(skillRoot, directory);
		if (!relative || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) throw new Error("下载和用户状态目录必须位于 Skill 安装目录之外");
	}
	if (values["cookie-cache"]) throw new Error("Skill 使用包外用户状态目录，不接受自定义 --cookie-cache；如需手动管理请直接调用 cli.mjs");
	if (values.prepare) {
		const directory = await prepareStateDirectory();
		await fsp.mkdir(output, { recursive: true });
		console.log(JSON.stringify({
			stateDirectory: directory,
			output,
			prepared: true
		}, null, 2));
		return;
	}
	const command = positionals[0];
	if (!command || ![
		"all",
		"list",
		"course",
		"media"
	].includes(command)) throw new Error("请明确指定 all、list、course 或 media");
	const url = values.url ?? (["all", "list"].includes(command) ? positionals[1] : void 0);
	if (!url || !["http:", "https:"].includes(new URL(url).protocol)) throw new Error("请明确指定目标店铺购买记录 URL");
	if (command !== "list" && !values["catalog-only"] && (!values.kinds || values.kinds.split(",").some((kind) => [
		"video",
		"audio",
		"replay"
	].includes(kind.trim()))) && (!await commandAvailable(values.ffmpeg ?? "ffmpeg", ["-version"]) || !await commandAvailable(values.ffprobe ?? "ffprobe", ["-version"]))) throw new Error("缺少 ffmpeg 或 ffprobe；请在获得用户许可后安装，或指定可执行文件绝对路径");
	await prepareStateDirectory();
	process.argv = [
		...process.argv.filter((arg) => arg !== "--doctor" && arg !== "--prepare"),
		"--cookie-cache",
		skillCookieCache(url)
	];
	await import(new URL("./cli.mjs", import.meta.url).href);
}
main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
//#endregion
export {};
