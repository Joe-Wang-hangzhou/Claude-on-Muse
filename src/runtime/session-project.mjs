// 续聊会话 → claudeCtx（cwd 覆写成所属项目路径）的共享解析。
//
// 为什么要抽出来：routes/chat.mjs 的续聊入口（按 sessionId 反查所属项目、校验路径权限、
// 覆写 ctx.cwd）和 agents/claude.mjs 的队列冷派发入口（dispatchFollowupNow，会话空闲、
// CLI 已退出时冷起一个新 query 续聊）必须用【同一份】逻辑——否则队列续聊的消息，对一个
// 不在默认项目下的会话，会在错误的 cwd 里冷起，找不到自己的 transcript（2026-10-08 复盘，
// c142501 的队列冷启动 bug：dispatchFollowupNow 当时直接拿 routes/followups.mjs 给的裸
// ctx，跳过了这整套解析）。
//
// 只处理【续聊】（sessionId 已知）的分支：新会话按 claudeProjectId 选项目、worktree 勾选框
// 这两段是 /api/chat 专属（没有 sessionId 时才可能触发），不在这个函数的职责内，继续留在
// routes/chat.mjs。

import * as claudeProjects from '../claude-projects.mjs';

// 返回 { ok:true, ctx, claudeProject } 或 { ok:false, reason }。
// reason 面向日志/队列的 error 字段，不是给用户看的 UI 文案（没有 HTTP status 的概念——
// 冷派发没有 res 可回，调用方自己决定怎么处理失败）。
export function resolveSessionClaudeCtx(ctx, sessionId) {
  if (!sessionId) return { ok: true, ctx, claudeProject: null };
  let claudeProject = claudeProjects.locateSessionProject(ctx.claudeProjects, ctx, sessionId);
  if (claudeProject) {
    try {
      claudeProject = { ...claudeProject, path: claudeProjects.authorizeProjectPath(ctx, claudeProject.path) };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || '项目路径不可用', status: (e && e.status) || 400 };
    }
  }
  // 项目 cwd 生效方式：覆写 ctx.cwd 传入——runClaudeChat 的 query cwd / resume 清理 /
  // 沙箱围栏全部吃 ctx.cwd，一处覆写全链路一致。默认项目 path === ctx.cwd，等价原行为。
  // homeRoot 保留身份原本的文件根；worktree 会话另带 worktree:{cwd,branch}。
  const claudeCtx = claudeProject
    ? { ...ctx, cwd: claudeProject.path, homeRoot: ctx.cwd, ...(claudeProject.worktree ? { worktree: { cwd: claudeProject.path, branch: claudeProject.worktree.branch } } : {}) }
    : ctx;
  return { ok: true, ctx: claudeCtx, claudeProject };
}
