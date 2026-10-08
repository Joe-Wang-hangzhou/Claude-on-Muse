// 追问队列（阶段 2）：会话忙时的排队 + Steer 中途注入——前端读写封装。
//
// 状态以服务端为准（见项目要求）：这里不做任何「本地先改、再对账」的乐观更新——每个写操作
// 只管发请求，成功后要么直接拿响应带回的 queue 整表替换，要么再 GET 一次兜底拉齐，中间用
// queueBusy 挂 loading。真正的实时同步走 chat.svelte.js 收到的 queue_updated 事件（活着的
// gen 走它的 SSE 通道、会话空闲走账号总线），这里只负责存一份按会话分桶的镜像给面板读。
import { api } from './api.js';

export const queues = $state({});     // sid -> item[]（服务端 listQueue 形状）
export const queueBusy = $state({});  // sid -> 'load'|'add'|'edit'|'delete'|'reorder'|'steer'|'continue'|null

export function queueFor(sid) { return (sid && queues[sid]) || []; }
export function setQueue(sid, list) { if (sid) queues[sid] = Array.isArray(list) ? list : []; }
export function clearQueueLocal(sid) { if (sid) delete queues[sid]; }

function normErr(e) {
  const status = e && e.status;
  const body = e && e.body;
  const error = (body && typeof body === 'object' && (body.error || body.message)) || (typeof body === 'string' ? body : '') || 'network';
  return { ok: false, status, error };
}

export async function loadQueue(sid) {
  if (!sid) return;
  queueBusy[sid] = 'load';
  try { const r = await api.queue(sid); if (r && r.ok) setQueue(sid, r.queue); }
  catch { /* 网络失败：保留上次已知快照，面板不清空，等下次触发源重试 */ }
  finally { if (queueBusy[sid] === 'load') queueBusy[sid] = null; }
}

export async function addToQueue(sid, content, attachments) {
  if (!sid) return { ok: false, error: 'no_session' };
  queueBusy[sid] = 'add';
  try {
    const r = await api.queueAdd(sid, content, attachments);
    if (r && r.ok) setQueue(sid, r.queue);
    return r;
  } catch (e) { return normErr(e); }
  finally { if (queueBusy[sid] === 'add') queueBusy[sid] = null; }
}

// edit/delete/steer 的响应不带整表 queue——拿到结果后兜底再 GET 一次，确保面板与服务端一致
// （正常情况下 queue_updated 广播会更快地把这件事做掉，这里只是防广播漏网的保险）。
export async function editQueueItem(sid, id, version, patch) {
  if (!sid) return { ok: false, error: 'no_session' };
  queueBusy[sid] = 'edit';
  try { return await api.queueEdit(sid, id, version, patch); }
  catch (e) { return normErr(e); }
  finally { await loadQueue(sid); }
}

export async function deleteQueueItem(sid, id, version) {
  if (!sid) return { ok: false, error: 'no_session' };
  queueBusy[sid] = 'delete';
  try { return await api.queueDelete(sid, id, version); }
  catch (e) { return normErr(e); }
  finally { await loadQueue(sid); }
}

export async function reorderQueue(sid, order, versions) {
  if (!sid) return { ok: false, error: 'no_session' };
  queueBusy[sid] = 'reorder';
  try {
    const r = await api.queueReorder(sid, order, versions);
    if (r && r.ok) setQueue(sid, r.queue);
    return r;
  } catch (e) { return normErr(e); }
  finally { if (queueBusy[sid] === 'reorder') queueBusy[sid] = null; }
}

export async function steerQueueItem(sid, id, version) {
  if (!sid) return { ok: false, error: 'no_session' };
  queueBusy[sid] = 'steer';
  try { return await api.queueSteer(sid, id, version); }
  catch (e) { return normErr(e); }
  finally { await loadQueue(sid); }
}

export async function continueQueue(sid) {
  if (!sid) return { ok: false, error: 'no_session' };
  queueBusy[sid] = 'continue';
  try { return await api.queueContinue(sid); }
  catch (e) { return normErr(e); }
  finally { if (queueBusy[sid] === 'continue') queueBusy[sid] = null; await loadQueue(sid); }
}
