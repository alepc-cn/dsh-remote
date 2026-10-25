/**
 * 可达性账本 / 快失败 / 失败退避（纯逻辑：只读写 runtime.reach / runtime.probeBackoff，不碰网络）。
 *
 * 从 lib/index.js 原样搬出（重构第 11 刀，行为一个字节都没改）。搬出的符号：
 *  - 账本：markReach / reachCheckedAt / reachFreshWindow / recentlyUnreachable / unreachableProxyReason
 *  - 退避：PROBE_BACKOFF_MAX_MS / probeBackoffDelay / probeBackoffEntry / probeBackoffDue /
 *    noteProbeFailure / noteProbeSuccess
 *  - 快失败：proxyConnectTimeout / triggerReachProbe
 *
 * **probeDevice 没有搬进来**（仍留在 index.js 的「体检 / 状态数据」region）：它要用
 * node:http / node:https、USER_AGENT / CONNECT_TIMEOUT_MS、ensureSession / cookieHeaderFor，
 * 为了一个探测函数把网络层与凭据层拉进来不值；reach 侧只通过注入拿到它。
 *
 * 由宿主半通过 configureReach() **注入**（本文件**不 import ./index.js**，否则成环）：
 *  - LIVE_POLL_MS / REACH_FRESH_MS / PROXY_CONNECT_TIMEOUT_MS：三个阈值常量（同时被代理 / live /
 *    对外入口 / 自测共用，所以留在 index.js）；
 *  - probeDevice：上面说的那个探测函数（{@link triggerReachProbe} 用）。
 */
let LIVE_POLL_MS, REACH_FRESH_MS, PROXY_CONNECT_TIMEOUT_MS, probeDevice;
export function configureReach(deps) {
	({ LIVE_POLL_MS, REACH_FRESH_MS, PROXY_CONNECT_TIMEOUT_MS, probeDevice } = deps);
}

//#region 可达性账本 / 快失败

/** 记一次"这台设备最近一次代理结果"（体检页要用；`checkedAt` 也给代理的"快失败"当新鲜度判据）。 */
function markReach(runtime, deviceId, ok, error) {
	const previous = runtime.reach.get(deviceId) ?? { reachable: null, lastOkAt: null, lastError: null };
	const next = {
		reachable: ok === true,
		/** 这次判定的时刻（ms）。**2026-10-17 第二刀新增**：快失败的新鲜度就用它（见 recentlyUnreachable）。 */
		checkedAt: Date.now(),
		lastOkAt: ok === true ? new Date().toISOString() : previous.lastOkAt,
		lastError: ok === true ? null : (error === undefined || error === null || error === "" ? previous.lastError : String(error)),
	};
	runtime.reach.set(deviceId, next);
	if (ok === true) noteProbeSuccess(runtime, deviceId);
	else noteProbeFailure(runtime, deviceId);
}

/** 失败退避上限（0.17.1）：后台轮询对持续失败的设备最多 30 秒探一次；用户操作不受限。 */
const PROBE_BACKOFF_MAX_MS = 30_000;

/** 第 n 次连续失败后的等待时间：2s → 4s → 8s → 16s → 30s（封顶）。 */
function probeBackoffDelay(failures) {
	if (failures <= 0) return 0;
	const delay = LIVE_POLL_MS * Math.pow(2, Math.min(failures - 1, 10));
	return Math.min(delay, PROBE_BACKOFF_MAX_MS);
}

/** 取/建某台设备的退避记录。 */
function probeBackoffEntry(runtime, id) {
	const map = runtime.probeBackoff;
	if (map === undefined) return { failures: 0, nextAt: 0 };
	let entry = map.get(id);
	if (entry === undefined) {
		entry = { failures: 0, nextAt: 0 };
		map.set(id, entry);
	}
	return entry;
}

/** 后台轮询现在该不该探这台（用户主动操作不看这个）。 */
function probeBackoffDue(runtime, id) {
	const entry = runtime.probeBackoff === undefined ? undefined : runtime.probeBackoff.get(id);
	return entry === undefined || Date.now() >= entry.nextAt;
}

/** 记录一次失败：累加连续失败数并排下一次后台探测时间。 */
function noteProbeFailure(runtime, id) {
	const entry = probeBackoffEntry(runtime, id);
	entry.failures += 1;
	entry.nextAt = Date.now() + probeBackoffDelay(entry.failures);
}

/** 成功：清零退避。 */
function noteProbeSuccess(runtime, id) {
	const entry = probeBackoffEntry(runtime, id);
	entry.failures = 0;
	entry.nextAt = 0;
}

/** 账本里"最近一次判定"的时刻（ms）。老记录没有 `checkedAt` ⇒ 退回解析 `lastOkAt`；都没有 = 0（不知道）。 */
function reachCheckedAt(record) {
	if (record === undefined || record === null) return 0;
	if (typeof record.checkedAt === "number" && Number.isFinite(record.checkedAt) && record.checkedAt > 0) return record.checkedAt;
	const parsed = Date.parse(String(record.lastOkAt ?? ""));
	return Number.isFinite(parsed) ? parsed : 0;
}

/** 快失败用的新鲜度窗口（`deps.reachFreshMs` 可覆盖，给自测把 4 秒缩成几百毫秒/2 秒）。 */
function reachFreshWindow(runtime) {
	return Number.isFinite(runtime.reachFreshMs) && runtime.reachFreshMs > 0 ? runtime.reachFreshMs : REACH_FRESH_MS;
}

/** 代理的建连超时（`deps.proxyConnectTimeoutMs` 可覆盖，给自测把 3 秒缩成几百毫秒）。 */
function proxyConnectTimeout(runtime) {
	return Number.isFinite(runtime.proxyConnectTimeoutMs) && runtime.proxyConnectTimeoutMs > 0
		? runtime.proxyConnectTimeoutMs
		: PROXY_CONNECT_TIMEOUT_MS;
}

/**
 * **这台设备"刚刚被判过不可达"吗**（= 代理可以快失败的唯一依据）。
 *
 * 三条同时成立才算：① 账本里有这台；② `reachable === false`；③ 判定时刻距今 **<** 新鲜度窗口。
 * 拿不准（没有记录 / 时间戳读不出来 / 已经过期）一律 **false** —— 宁可去真连一次，
 * 也绝不拿着过期结论把正常的设备拦在门外。
 */
function recentlyUnreachable(runtime, device, now = Date.now()) {
	const record = runtime.reach.get(device.id);
	if (record === undefined || record === null || record.reachable !== false) return false;
	const at = reachCheckedAt(record);
	if (at <= 0) return false;
	return now - at < reachFreshWindow(runtime);
}

/**
 * 快失败时**顺手**探一次这台设备（用它一恢复就马上可用）。
 *
 * 同一台同时只允许一次在途（`runtime.reachProbes`）：白屏时页面会同时打出几十条 `/api`，
 * 不拦一下就会对一台关机的设备并发几十个探测。`probeDevice` 自己带超时且只 resolve（不 reject）。
 * @returns 这次真的起了探测吗（已有在途的 ⇒ false）。
 */
function triggerReachProbe(runtime, device) {
	if (runtime.reachProbes.has(device.id)) return false;
	runtime.reachProbes.add(device.id);
	const done = () => { runtime.reachProbes.delete(device.id); };
	try {
		const pending = probeDevice(runtime, device);
		if (pending !== null && pending !== undefined && typeof pending.then === "function") pending.then(done, done);
		else done();
	} catch {
		done();
	}
	return true;
}

/** 不可达时的统一文案（纯文本，I1：绝不吐 HTML）。 */
function unreachableProxyReason(runtime, device) {
	const record = runtime.reach.get(device.id);
	const detail = record !== undefined && record !== null && typeof record.lastError === "string" && record.lastError !== ""
		? `（最近一次：${record.lastError}）`
		: "";
	return `本机可达性账本刚判过这台设备不可达，不再等上游建连，直接失败${detail}`;
}

//#endregion

export {
	PROBE_BACKOFF_MAX_MS, markReach, noteProbeFailure, noteProbeSuccess, probeBackoffDelay,
	probeBackoffDue, probeBackoffEntry, proxyConnectTimeout, reachCheckedAt, reachFreshWindow,
	recentlyUnreachable, triggerReachProbe, unreachableProxyReason,
};
