#!/usr/bin/env node
/**
 * 发布前敏感信息扫描（隐私检查）。
 *
 * 用途：提交 / 打 tag / 发版前，扫描仓库内所有文本文件，确保没有把个人环境信息
 * （真实 IP、主机名、用户名、个人域名、私钥/令牌、个人设备名等）带进公开仓库。
 *
 * 运行：node scripts/privacy-check.mjs [仓库目录]
 *   - 默认扫描 git 跟踪的文件（git ls-files）；不是 git 仓库时扫描目录。
 *   - 退出码 0 = 通过；1 = 命中（列出 文件:行号:原因，但不回显命中的原文）。
 *
 * 本机扩展黑名单（**不提交到仓库**）：
 *   把本机真实主机名/用户名/IP/域名/设备名逐行写进
 *   `$DSH_PRIVACY_DENYLIST`（默认 `~/.dsh/privacy-denylist.txt`），扫描时一并匹配。
 *   仓库里永远不放这份名单，避免名单本身泄露信息。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { extname, join, relative, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? process.cwd());

const BINARY_EXT = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tif", ".tiff",
	".zip", ".gz", ".tgz", ".7z", ".rar", ".pdf", ".woff", ".woff2", ".ttf", ".otf",
	".mp3", ".mp4", ".mov", ".wav", ".exe", ".dll", ".node", ".so", ".dylib",
]);
const MAX_BYTES = 2 * 1024 * 1024;

/** RFC 5737 / 3849 文档专用地址段：允许出现在示例里。 */
const DOC_IPV4 = [/^192\.0\.2\.\d+$/u, /^198\.51\.100\.\d+$/u, /^203\.0\.113\.\d+$/u];
/** 通用回环/绑定地址：与个人身份无关，允许出现。 */
const GENERIC_IPV4 = new Set(["127.0.0.1", "0.0.0.0", "255.255.255.255", "localhost"]);

const denylist = (() => {
	const file = process.env.DSH_PRIVACY_DENYLIST ?? join(homedir(), ".dsh", "privacy-denylist.txt");
	if (!existsSync(file)) return [];
	try {
		return readFileSync(file, "utf8")
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"));
	} catch {
		return [];
	}
})();

const localHostname = (() => {
	try {
		return hostname();
	} catch {
		return "";
	}
})();
const localUser = (() => {
	try {
		return userInfo().username;
	} catch {
		return "";
	}
})();

const userPathRule = localUser.length >= 2
	? new RegExp(`(?:\\\\Users\\\\|/home/|/Users/)${localUser.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:\\\\|/|"|'|\\s|$)`, "u")
	: null;

/** 逐行规则：返回原因，不回显原文。 */
const RULES = [
	{
		name: "真实 IPv4 地址",
		test(line) {
			for (const match of line.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/gu)) {
				const ip = match[1];
				if (ip.split(".").map(Number).some((part) => part > 255)) continue;
				if (GENERIC_IPV4.has(ip)) continue;
				if (DOC_IPV4.some((rule) => rule.test(ip))) continue;
				return true;
			}
			return false;
		},
	},
	{
		name: "私钥 / 令牌 / 密钥字段",
		test(line) {
			return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(line)
				|| /\b(?:network_secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[=:]\s*["']?[A-Za-z0-9_\-]{16,}/iu.test(line)
				|| /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}/u.test(line)
				|| /\bsk-[A-Za-z0-9]{20,}/u.test(line);
		},
	},
	{
		name: "本机用户名或个人目录",
		test(line) {
			return userPathRule !== null && userPathRule.test(line);
		},
	},
	{
		name: "个人设备名",
		test(line) {
			return /\u516c\u53f8\u53f0|\u5bb6\u91cc\u53f0|\u529e\u516c\u5ba4/u.test(line);
		},
	},
];

function checkLine(file, lineNumber, line) {
	const reasons = [];
	for (const rule of RULES) if (rule.test(line)) reasons.push(rule.name);
	for (const word of denylist) {
		if (word.length >= 3 && line.includes(word)) reasons.push("本机黑名单词");
	}
	if (localHostname.length >= 3 && /[A-Za-z0-9]/u.test(localHostname) && line.includes(localHostname)) {
		reasons.push("本机主机名");
	}
	if (reasons.length === 0) return null;
	return `${file}:${lineNumber}: ${[...new Set(reasons)].join(", ")}`;
}

function isBinary(full) {
	if (BINARY_EXT.has(extname(full).toLowerCase())) return true;
	try {
		return statSync(full).size > MAX_BYTES;
	} catch {
		return true;
	}
}

function gitFiles() {
	try {
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, stdio: "pipe" });
		const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		return out.split("\0").filter(Boolean);
	} catch {
		return null;
	}
}

function walk(dir, acc = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, acc);
		else if (entry.isFile()) acc.push(relative(ROOT, full));
	}
	return acc;
}

function main() {
	const files = gitFiles() ?? walk(ROOT);
	const findings = [];
	for (const rel of files) {
		const full = join(ROOT, rel);
		if (isBinary(full)) continue;
		let text;
		try {
			text = readFileSync(full, "utf8");
		} catch {
			continue;
		}
		const lines = text.split(/\r?\n/u);
		for (let index = 0; index < lines.length; index += 1) {
			const finding = checkLine(rel, index + 1, lines[index]);
			if (finding !== null) findings.push(finding);
		}
	}
	if (findings.length === 0) {
		console.log(`privacy-check: 通过（扫描 ${files.length} 个文件）`);
		return 0;
	}
	console.error(`privacy-check: 命中 ${findings.length} 处，禁止提交/发布：`);
	for (const finding of findings.slice(0, 100)) console.error("  " + finding);
	if (findings.length > 100) console.error(`  ... 其余 ${findings.length - 100} 处省略`);
	return 1;
}

process.exitCode = main();
