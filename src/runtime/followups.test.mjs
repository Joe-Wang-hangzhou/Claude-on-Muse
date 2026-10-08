// 追问队列（runtime/followups.mjs）：增删改查 + 乐观锁 + 编辑后顺序不变 + claim 的原子性。
// 每个用例自己的 mkdtemp 临时目录，互不串味（CLAUDE.md 铁律：单元测试一律用 mkdtemp）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initFollowups, listQueue, enqueueFollowup, editFollowup, deleteFollowup, reorderFollowups,
  claimNextQueued, requeueFront, markDelivered, markFailed, markSteered, STATUSES,
} from './followups.mjs';

const KEY = 'admin';
const SID = '11111111-2222-3333-4444-555555555555';

function world() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'followups-'));
  initFollowups(tmp);
  return tmp;
}

test('enqueue：新项是 QUEUED、version=1，顺序按 position', () => {
  world();
  const a = enqueueFollowup(KEY, SID, { content: '第一条' });
  const b = enqueueFollowup(KEY, SID, { content: '第二条' });
  assert.equal(a.item.status, STATUSES.QUEUED);
  assert.equal(a.item.version, 1);
  const q = listQueue(KEY, SID);
  assert.deepEqual(q.map((x) => x.content), ['第一条', '第二条']);
  assert.ok(q[0].position < q[1].position);
  assert.notEqual(a.item.id, b.item.id);
});

test('编辑：不改 id/position，version+1；content/attachments 按传入覆盖', () => {
  world();
  const { item } = enqueueFollowup(KEY, SID, { content: '原文', attachments: [] });
  const r = editFollowup(KEY, SID, item.id, item.version, { content: '改过了' });
  assert.equal(r.ok, true);
  assert.equal(r.item.id, item.id);
  assert.equal(r.item.position, item.position);
  assert.equal(r.item.version, item.version + 1);
  assert.equal(r.item.content, '改过了');
});

test('乐观锁：版本不符 → 409 等价的 conflict，内容不变', () => {
  world();
  const { item } = enqueueFollowup(KEY, SID, { content: '原文' });
  const bad = editFollowup(KEY, SID, item.id, item.version + 1, { content: '企图改' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'conflict');
  const q = listQueue(KEY, SID);
  assert.equal(q[0].content, '原文');
});

test('只有 QUEUED 才能编辑/删除：DISPATCHING 项编辑/删除都被拒', () => {
  world();
  const { item } = enqueueFollowup(KEY, SID, { content: 'x' });
  const claimed = claimNextQueued(KEY, SID);
  assert.equal(claimed.id, item.id);
  assert.equal(claimed.status, STATUSES.DISPATCHING);
  const e = editFollowup(KEY, SID, item.id, claimed.version, { content: 'y' });
  assert.equal(e.ok, false);
  assert.equal(e.error, 'not_queued');
  const d = deleteFollowup(KEY, SID, item.id, claimed.version);
  assert.equal(d.ok, false);
  assert.equal(d.error, 'not_queued');
});

test('删除：成功后查不到，position/id 对其余项无影响', () => {
  world();
  const a = enqueueFollowup(KEY, SID, { content: 'a' }).item;
  const b = enqueueFollowup(KEY, SID, { content: 'b' }).item;
  const r = deleteFollowup(KEY, SID, a.id, a.version);
  assert.equal(r.ok, true);
  const q = listQueue(KEY, SID);
  assert.equal(q.length, 1);
  assert.equal(q[0].id, b.id);
  assert.equal(q[0].position, b.position);
});

test('排序：只认完整的 QUEUED 子集，顺序落到 position；版本校验同样生效', () => {
  world();
  const a = enqueueFollowup(KEY, SID, { content: 'a' }).item;
  const b = enqueueFollowup(KEY, SID, { content: 'b' }).item;
  const c = enqueueFollowup(KEY, SID, { content: 'c' }).item;
  const r = reorderFollowups(KEY, SID, [c.id, a.id, b.id], { [a.id]: a.version, [b.id]: b.version, [c.id]: c.version });
  assert.equal(r.ok, true);
  const q = listQueue(KEY, SID);
  assert.deepEqual(q.map((x) => x.content), ['c', 'a', 'b']);
});

test('排序：集合不匹配（缺项/多项/混进非 QUEUED）一律 bad_order，不部分生效', () => {
  world();
  const a = enqueueFollowup(KEY, SID, { content: 'a' }).item;
  const b = enqueueFollowup(KEY, SID, { content: 'b' }).item;
  const r = reorderFollowups(KEY, SID, [a.id], { [a.id]: a.version });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_order');
  // 没有任何改动
  const q = listQueue(KEY, SID);
  assert.deepEqual(q.map((x) => x.content), ['a', 'b']);
});

test('排序：任一项版本不符 → 整体 409 conflict，不部分应用', () => {
  world();
  const a = enqueueFollowup(KEY, SID, { content: 'a' }).item;
  const b = enqueueFollowup(KEY, SID, { content: 'b' }).item;
  const r = reorderFollowups(KEY, SID, [b.id, a.id], { [a.id]: a.version + 1, [b.id]: b.version });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'conflict');
  const q = listQueue(KEY, SID);
  assert.deepEqual(q.map((x) => x.content), ['a', 'b']); // 原序不变
});

test('claimNextQueued：总是拿到 position 最小的 QUEUED 项，且原子翻成 DISPATCHING', () => {
  world();
  enqueueFollowup(KEY, SID, { content: 'a' });
  enqueueFollowup(KEY, SID, { content: 'b' });
  const got = claimNextQueued(KEY, SID);
  assert.equal(got.content, 'a');
  assert.equal(got.status, STATUSES.DISPATCHING);
  const q = listQueue(KEY, SID);
  assert.equal(q.find((x) => x.content === 'a').status, STATUSES.DISPATCHING);
  assert.equal(q.find((x) => x.content === 'b').status, STATUSES.QUEUED);
});

test('claimNextQueued：队列空/全是非 QUEUED 时返回 null', () => {
  world();
  assert.equal(claimNextQueued(KEY, SID), null);
  const a = enqueueFollowup(KEY, SID, { content: 'a' }).item;
  claimNextQueued(KEY, SID);
  assert.equal(claimNextQueued(KEY, SID), null); // 'a' 已经是 DISPATCHING，没有别的 QUEUED 项了
  void a;
});

test('删除与派发的并发竞态：claim 先发生，随后对 DISPATCHING 项的删除被拒——消息不会被双重处理也不会凭空消失', () => {
  world();
  const item = enqueueFollowup(KEY, SID, { content: 'race' }).item;
  const claimed = claimNextQueued(KEY, SID);           // "派发" 先拿到了它
  assert.equal(claimed.id, item.id);
  const del = deleteFollowup(KEY, SID, item.id, item.version); // 用户几乎同时点"删除"，但带的是旧版本号
  assert.equal(del.ok, false);
  assert.equal(del.error, 'not_queued');               // 拒绝——不是 QUEUED 了，删不掉
  // 队列里这条消息还在（状态是 DISPATCHING），没有被谁错误地删掉或重复派发
  const q = listQueue(KEY, SID);
  assert.equal(q.length, 1);
  assert.equal(q[0].status, STATUSES.DISPATCHING);
});

test('requeueFront：把 DISPATCHING 项放回 QUEUED 队首（position 比现有最小值还小）', () => {
  world();
  const a = enqueueFollowup(KEY, SID, { content: 'a' }).item;
  const b = enqueueFollowup(KEY, SID, { content: 'b' }).item;
  const claimedB = (() => { claimNextQueued(KEY, SID); return claimNextQueued(KEY, SID); })(); // 先把 a claim 掉，再 claim b
  assert.equal(claimedB.content, 'b');
  const r = requeueFront(KEY, SID, b.id, claimedB.version);
  assert.equal(r.ok, true);
  assert.equal(r.item.status, STATUSES.QUEUED);
  const q = listQueue(KEY, SID);
  assert.deepEqual(q.map((x) => x.content), ['b', 'a']); // b 现在排在最前面
  void a;
});

test('requeueFront：终态项（DELIVERED/FAILED/CANCELLED）不可复活', () => {
  world();
  const item = enqueueFollowup(KEY, SID, { content: 'x' }).item;
  const claimed = claimNextQueued(KEY, SID);
  markDelivered(KEY, SID, item.id);
  const r = requeueFront(KEY, SID, item.id, claimed.version + 1);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_queued');
});

test('Steer 用的 markSteered：只对 QUEUED 生效，版本符才翻成 STEERED', () => {
  world();
  const item = enqueueFollowup(KEY, SID, { content: 'steer me' }).item;
  const bad = markSteered(KEY, SID, item.id, item.version + 1);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'conflict');
  const ok = markSteered(KEY, SID, item.id, item.version);
  assert.equal(ok.ok, true);
  assert.equal(ok.item.status, STATUSES.STEERED);
  // 已经是 STEERED，再 steer 一次会被拒（不是 QUEUED 了）
  const again = markSteered(KEY, SID, item.id, ok.item.version);
  assert.equal(again.ok, false);
  assert.equal(again.error, 'not_queued');
});

test('不同会话 / 不同身份的队列互不串味', () => {
  world();
  enqueueFollowup(KEY, SID, { content: 'admin 的' });
  enqueueFollowup('u:someone', SID, { content: '别人的' });
  enqueueFollowup(KEY, '22222222-3333-4444-5555-666666666666', { content: 'admin 另一个会话的' });
  assert.deepEqual(listQueue(KEY, SID).map((x) => x.content), ['admin 的']);
  assert.deepEqual(listQueue('u:someone', SID).map((x) => x.content), ['别人的']);
});

test('markFailed / markCancelled：终态记录可查，但 claim 不会再碰它们', () => {
  world();
  const a = enqueueFollowup(KEY, SID, { content: 'a' }).item;
  const b = enqueueFollowup(KEY, SID, { content: 'b' }).item;
  claimNextQueued(KEY, SID); // a → DISPATCHING
  markFailed(KEY, SID, a.id);
  const got = claimNextQueued(KEY, SID);
  assert.equal(got.content, 'b');
  const q = listQueue(KEY, SID);
  assert.equal(q.find((x) => x.id === a.id).status, STATUSES.FAILED);
});

test('持久化：initFollowups 重新读盘拿到同样的队列', () => {
  const tmp = world();
  enqueueFollowup(KEY, SID, { content: '持久化测试' });
  initFollowups(tmp); // 模拟进程重启：重新从同一个目录加载
  const q = listQueue(KEY, SID);
  assert.equal(q.length, 1);
  assert.equal(q[0].content, '持久化测试');
});
