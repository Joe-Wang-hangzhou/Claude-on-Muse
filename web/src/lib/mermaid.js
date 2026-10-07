// Mermaid 图表：懒加载 + 串行渲染 + 结果缓存。md.js 的 mermaidExt（聊天与 DocViewer 共用）同步查缓存，
// 没命中就先出源码代码块、这里在后台渲染，完成后 epoch++ 让所有 {@html renderMarkdown(...)} 重跑取图。
//
// · mermaid 本体（浏览器 chunk 约 2–3MB）只有真的见到 ```mermaid 才 import()，不进启动包；
// · mermaid.render 共用全局配置 + 临时 DOM，并发调用会互相踩，故全部排进一条 Promise 链；
// · 缓存 key = 主题 + 源码：切换亮/暗后 key 自然不同，旧图不必清，MutationObserver 只负责 epoch++；
// · 安全：securityLevel 'strict'（禁 click 回调/脚本链接）+ htmlLabels:false（文字走 <text>，不出
//   foreignObject 里的 HTML），产出的 SVG 再按 svg profile 净化一遍。mermaid 重度依赖内联 style 与
//   SVG 内的 <style>（选择器都以本图 #id 开头），二者放行——CSS 不能执行脚本，可接受。
//   净化后的 SVG 由 md.js 在全局 sanitize【之后】填回占位，避免被默认 HTML 规则二次处理。
import DOMPurify from 'dompurify';
import { mdState } from './mdState.svelte.js';

const cache = new Map();   // key → { svg } | { error } | PENDING
const PENDING = 1;
const CACHE_MAX = 100;
let lib = null, inited = '', seq = 0;
let chain = Promise.resolve();

const themeName = () =>
  (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light') ? 'default' : 'dark';

function put(key, v) {
  if (cache.size >= CACHE_MAX && !cache.has(key)) cache.delete(cache.keys().next().value);
  cache.set(key, v);
}

const SVG_PURIFY = { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['style'], ADD_ATTR: ['style'] };

function enqueue(src, th, key) {
  chain = chain.then(async () => {
    try {
      if (!lib) lib = (await import('mermaid')).default;
      if (inited !== th) {
        lib.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true, theme: th });
        inited = th;
      }
      const id = 'mmd-' + (++seq);
      try {
        const { svg } = await lib.render(id, src);
        put(key, { svg: DOMPurify.sanitize(svg, SVG_PURIFY) });
      } catch (e) {
        document.getElementById('d' + id)?.remove();   // 出错时 mermaid 可能把临时容器留在 body
        put(key, { error: String(e?.message || e).split('\n')[0].slice(0, 200) });
      }
    } catch (e) {
      put(key, { error: String(e?.message || e).split('\n')[0].slice(0, 200) });   // chunk 加载失败
    }
    watchTheme();
    mdState.epoch++;
  });
}

// 同步查询：{ svg } / { error } / null（未就绪，已排队）。只在模板求值中调用，绝不同步改 state。
// theme：不传 = 跟随 app 亮/暗；DocViewer 是固定的象牙白纸面，obsmd 传 'default'。
export function mermaidLookup(src, theme) {
  const th = theme || themeName();
  const key = th + '\0' + src;
  const hit = cache.get(key);
  if (hit === PENDING) return null;
  if (hit) return hit;
  put(key, PENDING);
  enqueue(src, th, key);
  return null;
}

// 亮/暗切换：已出过图才需要重渲（新主题的 key 未命中 → 先出源码 → 渲完换图）
let watching = false;
function watchTheme() {
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  let last = themeName();
  new MutationObserver(() => {
    const th = themeName();
    if (th !== last) { last = th; mdState.epoch++; }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
