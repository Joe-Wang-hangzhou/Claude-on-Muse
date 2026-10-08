// 应用层消息队列（追问队列）：每个会话一份，持久化到 FOLLOWUPS.json。
//
// 为什么是应用层队列而不是直接塞进 SDK 输入流：2026-10-08 回滚的那版（steer-queue.patch）
// 把「排队」消息不带 priority 直接 push 进 turnInput，探针实测这等于 'next' —— 消息会在
// 下一个工具返回时被并进当前这一轮，排队变成了插话。这次排队的消息只存在这个模块的数组里，
// 只有在当前轮【真正定局】之后（claude.mjs 的 emitDone 之后、parkWarm 之前）才会被原子地
// claim 出来、用 warmTake 换 gen 续到同一个 CLI 上——从头到尾不进 SDK 的输入流,直到它自己
// 成为"当前这一轮"。
//
// Steer（中途注入）走另一条路：claude.mjs 直接把队列项的内容 turnInput.push 进活着的
// 输入流（本模块只负责把它的状态从 QUEUED 原子地翻成 STEERED，不碰 SDK）。
//
// 并发模型：Node 单线程、这里的读写函数全是同步的（没有 await 穿插），所以「查状态 →
// 改状态 → 持久化」这一串在任何一个导出函数内部天然是一个原子的临界区——HTTP 路由和
// claude.mjs 的自动派发点都只通过这些函数touch队列，不会出现两边同时改同一条记录的撕裂。

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const STATUSES = Object.freeze({
  QUEUED: 'QUEUED',
  DISPATCHING: 'DISPATCHING',
  STEERED: 'STEERED',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
});

// 每个会话保留的终态记录上限（DELIVERED/CANCELLED/FAILED）：队列本身该是短的，
// 长期堆积的历史记录没有价值，定期裁掉最老的，防止常驻进程无限增长。
const TERMINAL_KEEP = 20;

let FILE = '';
// 复合键 -> item[]（item 顺序无意义，位置看各自的 position 字段）
const _store = new Map();

// 长度前缀复合键，与 runtime/inflight.mjs 同一个套路：key 里本身可能带冒号（'u:名字'），
// 拼接必须无歧义。
const idOf = (key, sessionId) => {
  const k = String(key || '');
  return k.length + ':' + k + ':' + String(sessionId || '');
};

function writeJson(file, value) {
  if (!file) return;
  const tmp = file + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  } catch { /* 队列持久化尽力而为：写不下去不该拖垮正在跑的轮 */ }
}

function persist() {
  const out = [];
  for (const [id, items] of _store) {
    if (items.length) out.push({ id, items });
  }
  writeJson(FILE, out);
}

export function initFollowups(root) {
  FILE = path.join(root, 'followups.json');
  _store.clear();
  if (!existsSync(FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    if (Array.isArray(raw)) {
      for (const rec of raw) {
        if (rec && rec.id && Array.isArray(rec.items)) _store.set(rec.id, rec.items);
      }
    }
  } catch { /* 坏文件起个空队列，别让启动失败 */ }
  // 上一条命死在半途：DISPATCHING 只是「claim 到了，还没确认真正起了一轮」的瞬时态
  // （见 agents/claude.mjs dispatchFollowupNow：现在是「轮确认起来了才 markDelivered」），
  // 从没见过它被确认过——退回 QUEUED 置于队首最安全，不会丢也不会被当成已经执行过。
  let changed = false;
  for (const items of _store.values()) {
    const dispatching = items.filter((x) => x.status === STATUSES.DISPATCHING).sort((a, b) => a.position - b.position);
    if (!dispatching.length) continue;
    const queuedMin = Math.min(0, ...items.filter((x) => x.status === STATUSES.QUEUED).map((x) => x.position));
    let pos = queuedMin - dispatching.length;
    for (const item of dispatching) {
      item.status = STATUSES.QUEUED;
      item.position = pos++;
      item.version += 1;
      item.error = null;
      item.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) persist();
}

function arr(key, sessionId) {
  const id = idOf(key, sessionId);
  let a = _store.get(id);
  if (!a) { a = []; _store.set(id, a); }
  return a;
}

function trimTerminal(a) {
  const terminal = a.filter((x) => x.status === STATUSES.DELIVERED || x.status === STATUSES.CANCELLED || x.status === STATUSES.FAILED);
  if (terminal.length <= TERMINAL_KEEP) return;
  terminal.sort((x, y) => x.updatedAt - y.updatedAt);
  const drop = new Set(terminal.slice(0, terminal.length - TERMINAL_KEEP).map((x) => x.id));
  if (!drop.size) return;
  for (let i = a.length - 1; i >= 0; i--) if (drop.has(a[i].id)) a.splice(i, 1);
}

// 对外暴露的快照：按位置排序（QUEUED/DISPATCHING/STEERED 在前，终态按更新时间混排在后，
// 前端自己按 status 分组展示）。深拷贝，调用方改不动内部状态。
export function listQueue(key, sessionId) {
  const a = arr(key, sessionId);
  return a.map((x) => ({ ...x, attachments: [...(x.attachments || [])] }))
    .sort((x, y) => (x.position - y.position) || (x.createdAt - y.createdAt));
}

function find(a, id) { return a.find((x) => x.id === id) || null; }

// 下一个排队位置：当前所有 QUEUED 项里的最大 position + 1（没有则 0）。
function nextPosition(a) {
  let max = -1;
  for (const x of a) if (x.status === STATUSES.QUEUED && x.position > max) max = x.position;
  return max + 1;
}

export function enqueueFollowup(key, sessionId, { content, attachments } = {}) {
  const a = arr(key, sessionId);
  const now = Date.now();
  const item = {
    id: randomUUID(),
    content: String(content || ''),
    attachments: Array.isArray(attachments) ? attachments.filter((p) => typeof p === 'string') : [],
    status: STATUSES.QUEUED,
    position: nextPosition(a),
    version: 1,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  a.push(item);
  persist();
  return { ok: true, item: { ...item } };
}

export function editFollowup(key, sessionId, id, expectedVersion, { content, attachments } = {}) {
  const a = arr(key, sessionId);
  const item = find(a, id);
  if (!item) return { ok: false, error: 'not_found' };
  if (item.status !== STATUSES.QUEUED) return { ok: false, error: 'not_queued', item: { ...item } };
  if (item.version !== expectedVersion) return { ok: false, error: 'conflict', item: { ...item } };
  if (content !== undefined) item.content = String(content || '');
  if (attachments !== undefined) item.attachments = Array.isArray(attachments) ? attachments.filter((p) => typeof p === 'string') : [];
  item.version += 1;
  item.updatedAt = Date.now();
  // 编辑不改变 id / position。
  persist();
  return { ok: true, item: { ...item } };
}

export function deleteFollowup(key, sessionId, id, expectedVersion) {
  const a = arr(key, sessionId);
  const item = find(a, id);
  if (!item) return { ok: false, error: 'not_found' };
  if (item.status !== STATUSES.QUEUED) return { ok: false, error: 'not_queued', item: { ...item } };
  if (item.version !== expectedVersion) return { ok: false, error: 'conflict', item: { ...item } };
  const i = a.indexOf(item);
  if (i >= 0) a.splice(i, 1);
  persist();
  return { ok: true };
}

// order：期望的 QUEUED 子集的新顺序（完整覆盖，不是增量）；versions：{id: expectedVersion}。
// 任何一条版本不符，或 order 与当前 QUEUED 集合不是同一个集合，整体 409（不做部分应用）。
export function reorderFollowups(key, sessionId, order, versions) {
  const a = arr(key, sessionId);
  if (!Array.isArray(order) || !order.length) return { ok: false, error: 'bad_order' };
  const queued = a.filter((x) => x.status === STATUSES.QUEUED);
  const queuedIds = new Set(queued.map((x) => x.id));
  const orderIds = new Set(order);
  if (orderIds.size !== order.length || orderIds.size !== queuedIds.size || [...orderIds].some((id) => !queuedIds.has(id))) {
    return { ok: false, error: 'bad_order' };
  }
  for (const id of order) {
    const item = find(a, id);
    const v = versions && versions[id];
    if (v === undefined || item.version !== v) return { ok: false, error: 'conflict', id };
  }
  order.forEach((id, idx) => {
    const item = find(a, id);
    item.position = idx;
    item.version += 1;
    item.updatedAt = Date.now();
  });
  persist();
  return { ok: true };
}

// 原子地领取队首（position 最小的 QUEUED 项），翻成 DISPATCHING。没有 QUEUED 项返回 null。
export function claimNextQueued(key, sessionId) {
  const a = arr(key, sessionId);
  let head = null;
  for (const x of a) if (x.status === STATUSES.QUEUED && (!head || x.position < head.position)) head = x;
  if (!head) return null;
  head.status = STATUSES.DISPATCHING;
  head.version += 1;
  head.updatedAt = Date.now();
  persist();
  return { ...head };
}

export function markDelivered(key, sessionId, id) { return setTerminal(key, sessionId, id, STATUSES.DELIVERED, null); }
// reason：失败原因（项目路径解析失败 / 冷启动没能真正起一轮等），落进 item.error，队列面板能
// 直接显示「为什么失败」而不是只有一个光秃秃的 FAILED。
export function markFailed(key, sessionId, id, reason) { return setTerminal(key, sessionId, id, STATUSES.FAILED, reason ?? null); }
export function markCancelled(key, sessionId, id) { return setTerminal(key, sessionId, id, STATUSES.CANCELLED, null); }

function setTerminal(key, sessionId, id, status, error) {
  const a = arr(key, sessionId);
  const item = find(a, id);
  if (!item) return { ok: false, error: 'not_found' };
  item.status = status;
  item.error = error ?? null;
  item.version += 1;
  item.updatedAt = Date.now();
  trimTerminal(a);
  persist();
  return { ok: true, item: { ...item } };
}

// Steer：把一条 QUEUED 项原子地翻成 STEERED（claude.mjs 翻完才把正文塞进 SDK 输入流）。
export function markSteered(key, sessionId, id, expectedVersion) {
  const a = arr(key, sessionId);
  const item = find(a, id);
  if (!item) return { ok: false, error: 'not_found' };
  if (item.status !== STATUSES.QUEUED) return { ok: false, error: 'not_queued', item: { ...item } };
  if (expectedVersion !== undefined && item.version !== expectedVersion) return { ok: false, error: 'conflict', item: { ...item } };
  item.status = STATUSES.STEERED;
  item.version += 1;
  item.updatedAt = Date.now();
  persist();
  return { ok: true, item: { ...item } };
}

// 把一条项目退回 QUEUED 并放到队首（position = 当前最小 QUEUED position - 1）。
// 用于：① Steer 撞上本轮结束/挂起/gen 不存在时的回退；② DISPATCHING 项认领失败（并发槽满）的放回。
// item 必须不是终态（DELIVERED/CANCELLED/FAILED 不可复活）；version 匹配才放回，防止和并发的
// 编辑/删除撕裂。expectedVersion 缺省时跳过版本检查（claude.mjs 内部回退自己刚认领的项，版本是
// 已知的最新值，调用方总是传）。
export function requeueFront(key, sessionId, id, expectedVersion) {
  const a = arr(key, sessionId);
  const item = find(a, id);
  if (!item) return { ok: false, error: 'not_found' };
  if (item.status === STATUSES.DELIVERED || item.status === STATUSES.CANCELLED || item.status === STATUSES.FAILED) {
    return { ok: false, error: 'not_queued', item: { ...item } };
  }
  if (expectedVersion !== undefined && item.version !== expectedVersion) return { ok: false, error: 'conflict', item: { ...item } };
  let min = 0;
  for (const x of a) if (x.status === STATUSES.QUEUED && x.position < min) min = x.position;
  item.status = STATUSES.QUEUED;
  item.position = min - 1;
  item.version += 1;
  item.error = null;   // 重新派发是全新的一次尝试，别带着上一次（如果有）的失败原因
  item.updatedAt = Date.now();
  persist();
  return { ok: true, item: { ...item } };
}

// 测试/调试用：清掉某个会话的队列（node --test 的 mkdtemp 世界用，生产代码不调）。
export function _clearQueueForTest(key, sessionId) { _store.delete(idOf(key, sessionId)); persist(); }
