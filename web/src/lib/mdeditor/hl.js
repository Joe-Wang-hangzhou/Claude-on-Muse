// 阅读态代码块语法高亮 —— 与编辑态同一套解析器（@codemirror/language-data 的语言包）、同一张
// mdHighlight 配色表（mde-c-* / mde-t-* 类，配色在 lib/mdrender.css，两态共用一份），
// 阅读↔编辑切换时代码颜色不再整块跳变（以前阅读态是单色）。
// DocViewer 只在出现带语言的代码块时才懒加载本模块；语言包与编辑器共用同一批 chunk 缓存。
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightCode } from '@lezer/highlight';
import { mdHighlight } from './theme.js';

const MAX = 20000;   // 超长代码块不高亮：整块同步解析会卡主线程，单色也能读

// —— 同步字符串版（聊天 md.js 的 code renderer 用）——
// 聊天正文是 {@html renderMarkdown(块)}，流式尾巴块每 tick 整块重建 DOM，事后改 DOM 的上色会被冲掉，
// 所以要在出 HTML 字符串时就带上 span。parse/highlightCode 本身同步，只有语言包加载是异步：
// 没就绪返回 null（调用方先出单色），加载完调 onReady（md.js 在里面 epoch++ 触发重渲）。
const langs = new Map();   // 小写语言名 → { support } | 'loading' | null(不支持/加载失败)
const htmlCache = new Map();
const CACHE_MAX = 300;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlightToHtml(text, lang, onReady) {
  if (!text || text.length > MAX) return null;
  const key = String(lang).toLowerCase();
  const st = langs.get(key);
  if (st === undefined) {
    const desc = LanguageDescription.matchLanguageName(languages, key, true);
    if (!desc) { langs.set(key, null); return null; }
    langs.set(key, 'loading');
    desc.load().then(
      (support) => { langs.set(key, { support }); onReady?.(); },
      () => langs.set(key, null),
    );
    return null;
  }
  if (!st || st === 'loading') return null;
  const ck = key + '\0' + text;
  const hit = htmlCache.get(ck);
  if (hit !== undefined) return hit;
  let out = '';
  try {
    const tree = st.support.language.parser.parse(text);
    highlightCode(text, tree, mdHighlight,
      (s, cls) => { out += cls ? '<span class="' + cls + '">' + esc(s) + '</span>' : esc(s); },
      () => { out += '\n'; });
  } catch { return null; }
  if (htmlCache.size >= CACHE_MAX) htmlCache.delete(htmlCache.keys().next().value);
  htmlCache.set(ck, out);
  return out;
}

// codeEl：<code class="language-xx">；高亮成功后打 data-hl，重复调用直接跳过
export async function highlightPre(codeEl) {
  if (!codeEl || codeEl.dataset.hl) return;
  codeEl.dataset.hl = '1';   // 先占位：同一块别被并发的两次调用各解析一遍
  const lang = (String(codeEl.className).match(/language-([\w+#-]+)/) || [])[1];
  const text = codeEl.textContent;
  if (!lang || !text || text.length > MAX) return;
  const desc = LanguageDescription.matchLanguageName(languages, lang, true);
  if (!desc) return;
  let support;
  try { support = await desc.load(); } catch { return; }
  // 每块单独让出一个宏任务再解析：语言包已缓存时 load() 立刻兑现，一篇几十个代码块会在同一串
  // 微任务里连续同步解析、把主线程占住；拆开后中间能响应滚动/点击
  await new Promise((r) => setTimeout(r, 0));
  // 加载语言包期间块被重渲染/换文了：放弃，让新一轮 effect 重新来
  if (!codeEl.isConnected || codeEl.textContent !== text) return;
  let tree;
  try { tree = support.language.parser.parse(text); } catch { return; }
  const frag = document.createDocumentFragment();
  highlightCode(text, tree, mdHighlight, (s, cls) => {
    if (!cls) { frag.appendChild(document.createTextNode(s)); return; }
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = s;
    frag.appendChild(span);
  }, () => frag.appendChild(document.createTextNode('\n')));
  codeEl.replaceChildren(frag);
}
