// 桌面快捷键：⌘⇧O（Mac）/ Ctrl+Shift+O（其它）＝在当前会话所在的项目里开新会话。
// 宿主页与分屏格（同源 iframe）各挂一份——iframe 里的按键不会冒泡到宿主。
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

export function isNewSessionKey(e) {
  return (isMac ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey
    && e.code === 'KeyO' && !e.repeat && !e.isComposing;
}

// 挂在 window 的捕获阶段：抢在输入栏 / 编辑器之前，并拦掉浏览器的书签管理器。返回卸载函数。
export function onNewSessionKey(fn) {
  const onKey = (e) => {
    if (!isNewSessionKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
