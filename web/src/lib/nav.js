// 全局返回层级拦截（浏览器返回 / 手机侧滑返回 → 逐级关层，永不误离开页面）。
//
// 做法：垫「哨兵」history entry，系统返回消费哨兵触发 popstate，popstate 里关层再补回哨兵。
//
// 层级模型（从顶到底）：
//   转场播放中 → 吞掉返回，动画不被打断
//   瞬态层栈 pushBackLayer（灯箱/弹出菜单等「开着才挂载」的组件，后开先关）
//   沉浸查看器 preview > 设置 > 登录 > 定时 > claude 抽屉
//   dimensio 分页自带的层级（sheet / 抽屉 / 预览，window.__harnessBack）
//   非根 screen（files / harness / claude 各自分派带动画的 closer）
//   主页根 → 原地不动；单 agent 模式的根页（rootScreen）同理
//
// 关键好处：不改各组件现有的 UI 关闭逻辑（返回按钮/手势照旧直接关），只在这里集中拦系统返回。
// 带关闭动画的层（设置页收场、claude 整页收回入口）由组件用 registerCloser 注册其带动画的关闭
// 函数；其余层直接置 false（关闭动画走各自 CSS/transition）。
import { ui, rootScreen } from './state.svelte.js';
import { preview, closePreview } from './preview.svelte.js';
import { closePage } from './pageMorph.js';

const closers = {};
// 组件注册带动画的关闭函数；返回反注册器（配合 $effect 的 cleanup 使用）。
export function registerCloser(key, fn) {
  closers[key] = fn;
  return () => { if (closers[key] === fn) delete closers[key]; };
}

// —— 瞬态层栈：灯箱/弹出菜单这类「开着才挂载」的浮层，一行接入系统返回 ——
// 组件在 $effect 里 push 自己的关闭函数（卸载时 cleanup 自动弹出）；返回时后开先关。
//   $effect(() => pushBackLayer(onClose));
const layerStack = [];
export function pushBackLayer(fn) {
  layerStack.push(fn);
  return () => { const i = layerStack.indexOf(fn); if (i >= 0) layerStack.splice(i, 1); };
}

// —— 会话历史：每切一次会话往 history 记一条 { navSentinel, sess, proj }，浏览器前进/后退在会话间跳 ——
// 只写 state 不改 URL。最底下页面原本那条（state 为 null）仍是「到底」，落到那儿照旧关层 + 补哨兵。
let sessionNav = null;   // ClaudePage 注册：{ current() → {sess, proj}, open(st) }
export function setSessionNav(nav) {
  sessionNav = nav;
  return () => { if (sessionNav === nav) sessionNav = null; };
}
const isSessEntry = (st) => !!st && st.sess !== undefined;
const sessEntry = (s) => ({ navSentinel: 1, sess: s.sess || null, proj: s.proj || null });
// 会话变化时调用：popstate 自己切过来的（history.state 已是它）不记；首次 / 空白新会话拿到 id 原地替换；其余新记一条。
export function noteSession(sess, proj) {
  if (typeof window === 'undefined') return;
  sess = sess || null; proj = proj || null;
  const cur = history.state;
  try {
    if (isSessEntry(cur) && cur.sess === sess && (sess || cur.proj === proj)) {
      if (cur.proj !== proj) history.replaceState(sessEntry({ sess, proj }), '');   // 归属项目晚到：补上
      return;
    }
    if (!isSessEntry(cur) || (cur.sess === null && sess && (!cur.proj || cur.proj === proj))) {
      history.replaceState(sessEntry({ sess, proj }), '');
    } else {
      history.pushState(sessEntry({ sess, proj }), '');
    }
  } catch {}
}

// 有没有「返回该先关掉」的层（与 closeTopLayer 的浮层部分同序）
function hasOpenLayer() {
  return !!(ui.morphing || layerStack.length || preview.open || ui.settingsOpen
    || ui.loginOpen || ui.routinesOpen || ui.drawerOpen);
}

// 关闭当前最顶层。返回 true=消费了这次返回；false=已在最底(根页)无层可关。顺序＝从最上层到最下层。
function closeTopLayer() {
  // 页面转场播放中：吞掉返回（<1s 的动画，不打断演出）。
  if (ui.morphing) return true;
  // 瞬态层（灯箱/弹出菜单）：最新打开的视为最顶，先关它。
  const top = layerStack[layerStack.length - 1];
  if (top) { try { top(); } catch {} return true; }
  // 沉浸式文件查看器盖在一切之上——系统返回最先关它。
  if (preview.open) { closePreview(); return true; }
  // 任务详情（Agent 子转录 / Workflow 阶段面板）住在右侧工作台里，工作台自己注册返回层（ClaudeDock）。
  if (ui.settingsOpen) { closers.settings ? closers.settings() : (ui.settingsOpen = false); return true; }
  if (ui.loginOpen) { ui.loginOpen = false; return true; }
  if (ui.routinesOpen) { closers.routines ? closers.routines() : (ui.routinesOpen = false); return true; }
  if (ui.drawerOpen) { ui.drawerOpen = false; return true; }
  if (ui.customizeOpen && ui.screen === 'claude') { ui.customizeOpen = false; return true; }
  // dimensio 分页自带完整层级返回（整页/灯箱/sheet/预览/抽屉）：先让它关自己的层——
  // 单 agent 模式下它就是根页，也得先关掉它的抽屉与弹层，才轮到「到底了」。
  if (ui.screen === 'harness') {
    try { if (window.__harnessBack && window.__harnessBack()) return true; } catch {}
  }
  // 单 agent 模式：根页就是「主页」——到这儿无层可关
  if (ui.screen !== rootScreen()) {
    // 按当前分页分派各自的返回逻辑；回主页一律走 closePage：这一页收回它在主页上的入口（lib/pageMorph.js）。
    if (ui.screen === 'files') { closers.files ? closers.files() : closePage('files'); return true; }
    if (ui.screen === 'claude') { closers.claudeSlide ? closers.claudeSlide() : closePage('claude'); return true; }
    closePage(ui.screen); return true;
  }
  return false;
}

let inited = false;
export function initNav() {
  if (inited || typeof window === 'undefined') return;
  inited = true;
  // 垫哨兵，之后任意系统返回都先落到这次 pushState 上、被 popstate 拦截。
  try { history.pushState({ navSentinel: 1 }, ''); } catch {}
  window.addEventListener('popstate', (e) => {
    const st = e.state;
    if (isSessEntry(st) && sessionNav && ui.screen === 'claude') {
      // 前进/后退落到一条会话记录：有浮层先关浮层（原地补回当前会话，这次之后没有「前进」）；否则切过去。
      if (hasOpenLayer()) {
        closeTopLayer();
        try { history.pushState(sessEntry(sessionNav.current()), ''); } catch {}
        return;
      }
      const cur = sessionNav.current();
      if ((st.sess || null) !== (cur.sess || null) || (!st.sess && st.proj !== cur.proj)) sessionNav.open(st);
      return;
    }
    closeTopLayer();
    // 补回哨兵——下次系统返回仍被拦，永不直接离开页面。在 Claude 页时带上当前会话，好让前进/后退认得它。
    const cur = sessionNav && ui.screen === 'claude' ? sessionNav.current() : null;
    try { history.pushState(cur ? sessEntry(cur) : { navSentinel: 1 }, ''); } catch {}
  });
}
