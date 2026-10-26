/**
 * 401/403 的人话提示（0.29.0：从 store.js 抽出来；store.js 的 token/会话机制已整体删除）。
 */

import { deviceIdOf, info, warn } from "./util.js";

/** 401/403 给**人看得懂**的一句话（写进 state.devices[].lastError 与 notes，日志同义）。 */
export function authRejectMessage(status) {
	const code = Number.isFinite(status) && status > 0 ? String(status) : "401/403";
	return `对端拒绝了会话/令牌（HTTP ${code}）：可能对端重启过，请在那台机器设置页重新复制 token 填过来`;
}

/**
 * 记下"这台设备最近被对端拒绝了一次"（401/403）。
 * - 只在状态变化时打日志；
 * - **不动 reach.reachable**：对端是活的、只是认证不认。
 */
export function noteAuthRejected(runtime, device, status, messageOverride) {
	if (runtime === null || typeof runtime !== "object") return;
	const deviceId = deviceIdOf(device);
	if (deviceId === "") return;
	if (!(runtime.authNotices instanceof Map)) runtime.authNotices = new Map();
	const message = typeof messageOverride === "string" && messageOverride !== ""
		? messageOverride
		: authRejectMessage(status);
	const previous = runtime.authNotices.get(deviceId);
	runtime.authNotices.set(deviceId, { status: Number(status), message, at: Date.now() });
	if (previous === undefined || previous.status !== status || previous.message !== message) {
		warn(runtime.ctx, `设备 "${deviceId}"：${message}`);
	}
}

/** 认证恢复了（拿到非 401/403 的响应）⇒ 清掉那条提示。 */
export function clearAuthNotice(runtime, deviceId) {
	if (runtime === null || typeof runtime !== "object" || !(runtime.authNotices instanceof Map)) return;
	if (runtime.authNotices.delete(deviceId)) {
		info(runtime.ctx, `设备 "${deviceId}"：认证已恢复（不再提示重新填 token）`);
	}
}
