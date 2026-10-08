// 应用层消息队列（追问队列）+ Steer 的 HTTP 接口。
//
// 鉴权/身份识别风格与 routes/chat.mjs 一致：identify(req) → contextFor(id)。快照访客（isSnap）
// 整组接口都不开放——队列是「这个账号的这个会话」的持久状态，快照是一次性匿名桶，没有
// 回访的意义，开放了也只是白占一份 followups.json 记录。
//
// 编辑/删除/排序用 version 做乐观锁：冲突（版本不符）或状态不是 QUEUED 一律 409——
// 前端据此重新拉一次 GET /api/queue 再决定要不要重试。

import { readBody } from '../runtime/body.mjs';
import { filterAttachmentPaths } from '../runtime/attachment-guard.mjs';
import { contextFor } from '../runtime/identity.mjs';
import {
  listQueue, enqueueFollowup, editFollowup, deleteFollowup, reorderFollowups,
} from '../runtime/followups.mjs';
import { broadcastQueue, dispatchFollowupNow, steerFollowup } from '../agents/claude.mjs';

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// 把 followups.mjs 的 {ok:false,error} 翻成 HTTP 状态码。
function errStatus(error) {
  if (error === 'not_found') return 404;
  if (error === 'conflict') return 409;
  if (error === 'not_queued') return 409;
  return 400;
}

export function registerFollowupRoutes(router, { identify }) {
  const resolve = (req, res) => {
    const id = identify(req);
    if (!id || id.kind === 'none' || id.kind === 'share') {
      json(res, 401, { error: 'unauthorized' });
      return null;
    }
    const ctx = contextFor(id);
    if (ctx.kind === 'snap' || ctx.snap) {
      json(res, 403, { error: '快照访客不支持消息队列' });
      return null;
    }
    return ctx;
  };

  router.on('GET', '/api/queue', (req, res, url) => {
    const ctx = resolve(req, res); if (!ctx) return;
    const sessionId = url.searchParams.get('session') || '';
    if (!sessionId) { json(res, 400, { error: 'missing session' }); return; }
    json(res, 200, { ok: true, queue: listQueue(ctx.key, sessionId) });
  });

  router.on('POST', '/api/queue/add', async (req, res) => {
    const ctx = resolve(req, res); if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
    const sessionId = String(body.sessionId || '');
    const content = String(body.content ?? body.message ?? '').trim();
    const attachments = filterAttachmentPaths(body.attachments, {
      allowAnywhere: ctx.kind === 'admin',
      roots: [ctx.uploads, ctx.cwd],
    });
    if (!sessionId) { json(res, 400, { error: 'missing sessionId' }); return; }
    if (!content && !attachments.length) { json(res, 400, { error: 'empty message' }); return; }
    const r = enqueueFollowup(ctx.key, sessionId, { content, attachments });
    broadcastQueue(ctx, sessionId);
    // 会话可能正空闲（没有活着的 gen、没有停放的 CLI）——这条消息要有人去领。不等它跑完再回应
    // （那会让「排队」接口挂等一整轮的时间），只是触发；跑完与否通过 queue_updated / SSE 广播。
    dispatchFollowupNow(ctx, sessionId).catch(() => {});
    json(res, 200, { ok: true, item: r.item, queue: listQueue(ctx.key, sessionId) });
  });

  router.on('POST', '/api/queue/edit', async (req, res) => {
    const ctx = resolve(req, res); if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
    const sessionId = String(body.sessionId || '');
    const id = String(body.id || '');
    const version = Number(body.version);
    if (!sessionId || !id || !Number.isFinite(version)) { json(res, 400, { error: 'missing fields' }); return; }
    const attachments = body.attachments !== undefined ? filterAttachmentPaths(body.attachments, {
      allowAnywhere: ctx.kind === 'admin',
      roots: [ctx.uploads, ctx.cwd],
    }) : undefined;
    const r = editFollowup(ctx.key, sessionId, id, version, { content: body.content, attachments });
    if (!r.ok) { json(res, errStatus(r.error), { error: r.error, item: r.item || null }); return; }
    broadcastQueue(ctx, sessionId);
    json(res, 200, { ok: true, item: r.item });
  });

  router.on('POST', '/api/queue/delete', async (req, res) => {
    const ctx = resolve(req, res); if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
    const sessionId = String(body.sessionId || '');
    const id = String(body.id || '');
    const version = Number(body.version);
    if (!sessionId || !id || !Number.isFinite(version)) { json(res, 400, { error: 'missing fields' }); return; }
    const r = deleteFollowup(ctx.key, sessionId, id, version);
    if (!r.ok) { json(res, errStatus(r.error), { error: r.error, item: r.item || null }); return; }
    broadcastQueue(ctx, sessionId);
    json(res, 200, { ok: true });
  });

  router.on('POST', '/api/queue/reorder', async (req, res) => {
    const ctx = resolve(req, res); if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
    const sessionId = String(body.sessionId || '');
    const order = Array.isArray(body.order) ? body.order.map(String) : null;
    const versions = body.versions && typeof body.versions === 'object' ? body.versions : {};
    if (!sessionId || !order) { json(res, 400, { error: 'missing fields' }); return; }
    const r = reorderFollowups(ctx.key, sessionId, order, versions);
    if (!r.ok) { json(res, errStatus(r.error), { error: r.error }); return; }
    broadcastQueue(ctx, sessionId);
    json(res, 200, { ok: true, queue: listQueue(ctx.key, sessionId) });
  });

  // Steer：把队列里的一条消息转成「中途注入」。只有 outcome:'failed' 才算真正拒绝（消息仍留在
  // QUEUED，正文一字未动）；'injected' = 已经进了活着的输入流；'queued_as_next_turn' = 回退到了
  // 正常派发（本轮刚好定局/挂起/没有 gen），后续会被当队首自动执行——不管哪种结局，这条消息
  // 保证只被执行一次。乐观锁冲突（版本不符/已不是 QUEUED）单独判 409，不进 outcome 字段。
  router.on('POST', '/api/queue/steer', async (req, res) => {
    const ctx = resolve(req, res); if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
    const sessionId = String(body.sessionId || '');
    const id = String(body.id || '');
    const version = Number(body.version);
    if (!sessionId || !id || !Number.isFinite(version)) { json(res, 400, { error: 'missing fields' }); return; }
    const r = steerFollowup(ctx, sessionId, id, version);
    if (!r.ok) { json(res, errStatus(r.error), { error: r.error, item: r.item || null }); return; }
    json(res, 200, { outcome: r.outcome, reason: r.reason || null });
  });

  // 「继续队列」：手动恢复自动派发——给用户在「本轮出错结束 / 用户停止」这类不自动派发的
  // 状态之后，想接着跑队列里剩下的消息用。会话仍在跑（live gen 未定局）或队列空都是无害的
  // no-op（dispatched:false + reason）。
  router.on('POST', '/api/queue/continue', async (req, res) => {
    const ctx = resolve(req, res); if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
    const sessionId = String(body.sessionId || '');
    if (!sessionId) { json(res, 400, { error: 'missing sessionId' }); return; }
    const r = await dispatchFollowupNow(ctx, sessionId);
    json(res, 200, r);
  });
}
