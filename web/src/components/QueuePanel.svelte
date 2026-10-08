<script>
  // 追问队列面板（阶段 2）：输入框上方，列 QUEUED（+ FAILED）条目——编辑/删除/Steer/上移/下移。
  // 状态永远以服务端为准（lib/queue.svelte.js 的镜像由 chat.svelte.js 收到的 queue_updated
  // 广播 + 这里自己的 GET 兜底维持），没有任何「点了就本地先改」的乐观更新；写操作期间按钮
  // 禁用 + 原地 loading，失败（409 版本冲突/已不是 QUEUED）就提示并让 queueBusy 触发的兜底
  // GET 把真实状态拉回来。
  import { session } from '../lib/state.svelte.js';
  import { queueFor, queueBusy, loadQueue, editQueueItem, deleteQueueItem, reorderQueue, steerQueueItem, continueQueue } from '../lib/queue.svelte.js';
  import { uiAlert } from '../lib/dialogs.js';
  import { t } from '../lib/i18n.js';

  const sid = $derived(session.id);
  // 切会话/会话首次拿到 id 都要拉一次——GET 失败不清空上次已知快照（见 loadQueue）。
  let lastSid = null;
  $effect(() => {
    if (sid && sid !== lastSid) { lastSid = sid; loadQueue(sid); }
  });

  const all = $derived(queueFor(sid));
  const visible = $derived(all.filter((x) => x.status === 'QUEUED' || x.status === 'FAILED'));
  const queuedOnly = $derived(all.filter((x) => x.status === 'QUEUED'));
  const busyKind = $derived(sid ? queueBusy[sid] : null);
  // Steer 只在「这个会话眼下有一轮在跑」时有意义——空闲时隐藏那颗按钮，没有误导性的可点态。
  const canSteer = $derived(!!session.busy);
  // 队列不再自动跑（上一轮出错/被用户停止）判定：会话空闲 + 队列里还有 QUEUED。
  const showContinue = $derived(!session.busy && queuedOnly.length > 0);

  let editingId = $state(null);
  let editText = $state('');
  let expandedId = $state(null);

  function preview(text) {
    const t1 = (text || '').replace(/\s+/g, ' ').trim();
    return t1 || t('（空消息）');
  }

  function startEdit(it) { editingId = it.id; editText = it.content || ''; expandedId = null; }
  function cancelEdit() { editingId = null; editText = ''; }
  async function saveEdit(it) {
    const text = editText;
    editingId = null;
    const r = await editQueueItem(sid, it.id, it.version, { content: text });
    if (r && !r.ok) {
      uiAlert(r.status === 409 ? t('这条已经被执行或已变更') : t('保存失败，请重试'));
    }
  }
  async function removeItem(it) {
    const r = await deleteQueueItem(sid, it.id, it.version);
    if (r && !r.ok && r.status === 409) uiAlert(t('这条已经被执行或已变更'));
  }
  function steerReasonText(reason) {
    if (reason === 'awaiting_answer') return t('正在等待你回答问题，暂不能注入');
    return t('暂时无法注入，请稍后重试');
  }
  async function steerItem(it) {
    const r = await steerQueueItem(sid, it.id, it.version);
    if (!r) return;
    if (r.status === 409) { uiAlert(t('这条已经被执行或已变更')); return; }
    if (r.outcome === 'injected') uiAlert(t('已注入当前轮'));
    else if (r.outcome === 'queued_as_next_turn') uiAlert(t('本轮已结束，已作为下一条执行'));
    else if (r.outcome === 'failed') uiAlert(steerReasonText(r.reason));
  }
  async function moveItem(it, dir) {
    const arr = queuedOnly;
    const idx = arr.findIndex((x) => x.id === it.id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= arr.length) return;
    const next = arr.slice();
    const tmp = next[idx]; next[idx] = next[j]; next[j] = tmp;
    const order = next.map((x) => x.id);
    const versions = {};
    for (const x of next) versions[x.id] = x.version;
    await reorderQueue(sid, order, versions);
  }
  async function onContinue() { await continueQueue(sid); }
</script>

{#if sid && (visible.length || showContinue)}
  <div class="queue-panel">
    {#if showContinue}
      <div class="qp-continue">
        <span>{t('队列未在自动执行')}</span>
        <button class="qp-go" disabled={busyKind === 'continue'} onclick={onContinue}>{t('继续执行队列')}</button>
      </div>
    {/if}
    {#each visible as it, vi (it.id)}
      {@const qIdx = it.status === 'QUEUED' ? queuedOnly.findIndex((x) => x.id === it.id) : -1}
      <div class="qp-item" class:failed={it.status === 'FAILED'}>
        <span class="qp-num">{it.status === 'QUEUED' ? qIdx + 1 : '!'}</span>
        <div class="qp-body">
          {#if editingId === it.id}
            <textarea
              class="qp-input"
              bind:value={editText}
              onkeydown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); saveEdit(it); }
                else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
              }}
            ></textarea>
          {:else}
            <button class="qp-text" class:clamp={expandedId !== it.id} onclick={() => (expandedId = expandedId === it.id ? null : it.id)}>{preview(it.content)}</button>
            {#if (it.attachments || []).length}<span class="qp-atts">{t('{n} 个附件', { n: it.attachments.length })}</span>{/if}
            {#if it.status === 'FAILED' && it.error}<div class="qp-err">{it.error}</div>{/if}
          {/if}
        </div>
        <div class="qp-acts">
          {#if editingId === it.id}
            <button class="qp-ic" aria-label={t('保存')} onclick={() => saveEdit(it)}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            </button>
            <button class="qp-ic" aria-label={t('取消')} onclick={cancelEdit}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
            </button>
          {:else}
            {#if it.status === 'QUEUED'}
              <button class="qp-ic" aria-label={t('上移')} disabled={qIdx === 0} onclick={() => moveItem(it, -1)}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>
              </button>
              <button class="qp-ic" aria-label={t('下移')} disabled={qIdx === queuedOnly.length - 1} onclick={() => moveItem(it, 1)}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>
              </button>
              <button class="qp-ic" aria-label={t('编辑')} onclick={() => startEdit(it)}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              {#if canSteer}
                <button class="qp-ic qp-steer" aria-label={t('立即引导')} title={t('立即引导（打断当前推进，把这条插进去）')} disabled={busyKind === 'steer'} onclick={() => steerItem(it)}>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>
                </button>
              {/if}
            {/if}
            <button class="qp-ic qp-del" aria-label={t('删除')} onclick={() => removeItem(it)}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  /* 队列面板：输入框正上方一叠细卡——与 Composer 同一视觉语言（--card/--divider/--muted）。
     折叠屏/手机：按钮排不下就允许换行，宁可卡片高一点，不挤爆正文。 */
  .queue-panel { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .qp-continue { display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 9px 13px; border-radius: 12px; background: var(--card); border: 1px solid var(--divider); font-size: 13px; color: var(--muted); }
  .qp-go { flex: none; padding: 6px 12px; border-radius: 9px; background: var(--text); color: var(--bg); font-size: 12.5px; }
  .qp-go:disabled { opacity: .5; }
  .qp-item { display: flex; align-items: flex-start; gap: 9px; padding: 9px 11px; border-radius: 12px; background: var(--card); border: 1px solid var(--divider); }
  .qp-item.failed { border-color: color-mix(in srgb, var(--coral, #d97757) 45%, var(--divider)); }
  .qp-num { flex: none; width: 18px; height: 18px; margin-top: 2px; border-radius: 50%; background: var(--hover-strong, var(--hover)); color: var(--muted);
    font-size: 11px; display: flex; align-items: center; justify-content: center; }
  .qp-item.failed .qp-num { background: color-mix(in srgb, var(--coral, #d97757) 25%, transparent); color: var(--coral, #d97757); }
  .qp-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .qp-text { text-align: left; font-size: 13.5px; line-height: 1.4; color: var(--text); white-space: pre-wrap; word-break: break-word; }
  .qp-text.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .qp-atts { font-size: 11.5px; color: var(--muted); }
  .qp-err { font-size: 12px; color: var(--coral, #d97757); }
  .qp-input { width: 100%; min-height: 54px; resize: vertical; background: var(--hover); border: 1px solid var(--divider); border-radius: 9px;
    color: var(--text); font: inherit; font-size: 13.5px; padding: 6px 8px; }
  .qp-acts { flex: none; display: flex; align-items: center; gap: 2px; flex-wrap: wrap; justify-content: flex-end; max-width: 112px; }
  .qp-ic { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--muted); }
  .qp-ic:disabled { opacity: .35; }
  .qp-ic:not(:disabled):active { background: var(--hover); color: var(--text); }
  @media (hover: hover) { .qp-ic:not(:disabled):hover { background: var(--hover); color: var(--text); } }
  .qp-steer { color: var(--coral, #d97757); }
  .qp-del:not(:disabled):active, .qp-del:not(:disabled):hover { color: var(--coral, #d97757); }
</style>
