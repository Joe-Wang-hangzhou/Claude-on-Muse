// Steer 撞上「本轮已经结束」时的回退：steerFollowup 必须退回 QUEUED 置于队首并走正常派发，
// 且只执行一次——不管调用时 gen 已经完全不在了，还是还留着一份 done:true 的retained 记录。
//
// 不触发真实 SDK：dispatchFollowupNow 的冷启动分支认 ctx.__testNoDispatch（agents/claude.mjs
// 里的测试钩子），到了「要 spawn CLI」那一步就提前退出——本机内存/并发都经不起单元测试
// 意外起一个真实 claude 子进程，更不能打真实 API。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initFollowups, listQueue, enqueueFollowup, STATUSES } from '../runtime/followups.mjs';
import { setCurrentGen } from '../runtime/gen.mjs';
import { steerFollowup } from './claude.mjs';

const KEY = 'admin';

test('Steer：会话里压根没有 gen（本轮早就彻底收尾退出）→ 退回 QUEUED 置于队首', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'followups-claude-'));
  initFollowups(tmp);
  const ctx = { key: KEY, __testNoDispatch: true };
  const sid = randomUUID();
  const a = enqueueFollowup(KEY, sid, { content: 'a' }).item;
  const b = enqueueFollowup(KEY, sid, { content: 'b (要 steer 的是它)' }).item;

  const r = steerFollowup(ctx, sid, b.id, b.version);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'queued_as_next_turn');

  const q = listQueue(KEY, sid);
  const stillB = q.find((x) => x.id === b.id);
  assert.equal(stillB.status, STATUSES.QUEUED, '消息没有被标记成已执行——它还会被正常派发一次');
  // b 现在排在 a 前面（置于队首）
  assert.ok(stillB.position < q.find((x) => x.id === a.id).position);
});

test('Steer：gen 还留着（已经 done，是收尾后保留的那份）→ 同样退回 QUEUED，不会尝试注入', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'followups-claude-'));
  initFollowups(tmp);
  const ctx = { key: KEY, __testNoDispatch: true };
  const sid = randomUUID();
  const item = enqueueFollowup(KEY, sid, { content: '撞上轮尾' }).item;
  // 模拟「这一轮刚刚定局」：gen 还在台账里，但 done=true，且没有挂 steerInject
  // （真实代码里 done 的 gen 仍挂着 armGen 设的函数，但 steerFollowup 只看 g.done，不看这个）。
  setCurrentGen(KEY, { sessionId: sid, done: true });

  const r = steerFollowup(ctx, sid, item.id, item.version);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'queued_as_next_turn');
  const q = listQueue(KEY, sid);
  assert.equal(q[0].id, item.id);
  assert.equal(q[0].status, STATUSES.QUEUED);
});

test('Steer：版本不符 → conflict，消息原样不动，不会误判成"本轮结束"而悄悄重排', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'followups-claude-'));
  initFollowups(tmp);
  const ctx = { key: KEY, __testNoDispatch: true };
  const sid = randomUUID();
  const item = enqueueFollowup(KEY, sid, { content: 'x' }).item;

  const r = steerFollowup(ctx, sid, item.id, item.version + 1);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'conflict');
  const q = listQueue(KEY, sid);
  assert.equal(q[0].status, STATUSES.QUEUED);
  assert.equal(q[0].version, item.version);
});

test('Steer：不存在的 id → not_found', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'followups-claude-'));
  initFollowups(tmp);
  const ctx = { key: KEY, __testNoDispatch: true };
  const sid = randomUUID();
  const r = steerFollowup(ctx, sid, 'nope', 1);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_found');
});
