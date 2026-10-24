#!/usr/bin/env node
/**
 * 安装本地 Git 钩子：提交前、推送前先跑敏感信息扫描。
 *
 * 运行：node scripts/install-hooks.mjs
 * 效果：写入 .git/hooks/pre-commit 与 .git/hooks/pre-push（已存在则覆盖）。
 * 注意：钩子只在本机生效，不进仓库；新克隆的仓库需要重新执行一次本脚本。
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hooksDir = join(process.cwd(), ".git", "hooks");
if (!existsSync(join(process.cwd(), ".git"))) {
	console.error("install-hooks: 当前目录不是 git 仓库");
	process.exit(1);
}
mkdirSync(hooksDir, { recursive: true });

const script = `#!/bin/sh
# dsh-remote：提交/推送前跑一次敏感信息扫描，命中则阻止。
node "$(git rev-parse --show-toplevel)/scripts/privacy-check.mjs" || {
  echo "privacy-check 未通过：请先移除敏感信息（真实 IP/主机名/用户名/个人设备名等）再提交。" >&2
  exit 1
}
`;

for (const name of ["pre-commit", "pre-push"]) {
	const file = join(hooksDir, name);
	writeFileSync(file, script, "utf8");
	try {
		chmodSync(file, 0o755);
	} catch {
		/* Windows 上忽略 */
	}
	console.log(`installed .git/hooks/${name}`);
}
