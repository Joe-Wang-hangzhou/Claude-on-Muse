// resolveSessionClaudeCtx（续聊会话 → claudeCtx 的共享解析，routes/chat.mjs 与
// agents/claude.mjs 的队列冷派发 dispatchFollowupNow 共用同一份逻辑）。
//
// 覆盖：① 没有匹配项目时落到默认项目（cwd 不变，只是多了 homeRoot）；
//      ② 会话归属一个越出授权边界的项目（非 admin 身份、项目路径在工作空间之外）
//        → ok:false + 可读的 reason，不抛异常——这正是 c142501 冷派发 bug 的修复点：
//        这个失败必须在冷起 query() 之前拦住，而不是让它拿着错的 cwd 去 resume。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJson } from '../jsonfile.mjs';
import { sessionsDir } from './paths.mjs';
import { resolveSessionClaudeCtx } from './session-project.mjs';

function world() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'session-project-'));
  const cwd = path.join(tmp, 'workspace');
  mkdirSync(cwd, { recursive: true });
  return {
    tmp,
    cwd,
    claudeProjects: path.join(tmp, 'claude-projects.json'),
    configDir: path.join(tmp, 'claudecfg'),
  };
}

test('没有 sessionId：原样返回 ctx，不碰项目系统', () => {
  const w = world();
  const ctx = { kind: 'admin', cwd: w.cwd, claudeProjects: w.claudeProjects, configDir: w.configDir };
  const r = resolveSessionClaudeCtx(ctx, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.ctx, ctx);
});

test('会话不属于任何已知项目 → 落到默认项目（path===ctx.cwd），cwd 不变', () => {
  const w = world();
  const ctx = { kind: 'admin', cwd: w.cwd, claudeProjects: w.claudeProjects, configDir: w.configDir };
  const r = resolveSessionClaudeCtx(ctx, randomUUID());
  assert.equal(r.ok, true);
  assert.equal(r.ctx.cwd, w.cwd);
  assert.equal(r.ctx.homeRoot, w.cwd);
});

test('非 admin 身份、会话归属的项目路径越出工作空间 → ok:false，不抛异常', () => {
  const w = world();
  const outside = path.join(w.tmp, 'outside-project');
  mkdirSync(outside, { recursive: true });
  const sessionId = randomUUID();

  // 手工注册一个项目路径在工作空间之外（normally 只有 admin 能建这种项目；这里直接造数据
  // 模拟「这个会话本来就不是这个身份的工作空间」的越权情形）。
  writeJson(w.claudeProjects, { projects: [{ id: 'p1', name: 'Outside', path: outside, created: Date.now(), updated: Date.now() }], order: [] }, 2);
  // 这个会话的 transcript 落在 outside 项目下，locateSessionProject 据此把它判给 outside。
  const dir = sessionsDir(outside, w.configDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, sessionId + '.jsonl'), '');

  const ctx = { kind: 'user', cwd: w.cwd, claudeProjects: w.claudeProjects, configDir: w.configDir };
  const r = resolveSessionClaudeCtx(ctx, sessionId);
  assert.equal(r.ok, false);
  assert.match(r.reason, /工作空间/);
  assert.equal(r.status, 403);
});

test('admin 身份同样的越权路径：admin 不受工作空间边界限制，照样解析成功', () => {
  const w = world();
  const outside = path.join(w.tmp, 'outside-project-admin');
  mkdirSync(outside, { recursive: true });
  const sessionId = randomUUID();
  writeJson(w.claudeProjects, { projects: [{ id: 'p1', name: 'Outside', path: outside, created: Date.now(), updated: Date.now() }], order: [] }, 2);
  const dir = sessionsDir(outside, w.configDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, sessionId + '.jsonl'), '');

  const ctx = { kind: 'admin', cwd: w.cwd, claudeProjects: w.claudeProjects, configDir: w.configDir };
  const r = resolveSessionClaudeCtx(ctx, sessionId);
  assert.equal(r.ok, true);
  assert.equal(r.ctx.cwd, outside);
  assert.equal(r.ctx.homeRoot, w.cwd);
});
