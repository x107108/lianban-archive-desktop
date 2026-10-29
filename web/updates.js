/* Shared desktop release inbox. Existing query code and personal data stay independent. */
(() => {
  'use strict';
  const READ_KEY = 'lianban-desktop-read-release';
  const releasePrefix = 'https://github.com/x107108/lianban-archive-desktop/releases/tag/v';

  function isUnread(notice, readId) { return Boolean(notice && notice.id !== readId); }
  function safeReleaseUrl(notice) {
    return notice && /^20\d{2}\.\d{2}\.\d{2}(?:\.\d{1,6})?$/.test(notice.version)
      && notice.url === releasePrefix + notice.version ? notice.url : null;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isUnread, safeReleaseUrl };
    return;
  }
  const topbar = document.querySelector('.topbar-right');
  if (!topbar) return;
  const element = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  let readId = '';
  try { readId = localStorage.getItem(READ_KEY) || ''; } catch (_) {}
  let state = { current_version: '', notice: null, checking: true, checked_at: null, unavailable: false };
  let busy = false;
  let timer;
  let remindAt = 0;
  let remindedId = '';

  const button = element('button', 'text-button update-inbox-button', '站内信');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', 'update-inbox');
  const badge = element('span', 'update-unread-dot');
  badge.setAttribute('aria-hidden', 'true');
  badge.hidden = true;
  button.append(badge);
  topbar.prepend(button);

  const banner = element('section', 'update-banner');
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  const bannerText = element('span');
  const bannerAction = element('button', 'text-button', '查看更新');
  bannerAction.type = 'button';
  banner.append(bannerText, bannerAction);
  document.querySelector('.intro').after(banner);

  const dialog = element('dialog', 'update-dialog');
  dialog.id = 'update-inbox';
  dialog.setAttribute('aria-labelledby', 'update-inbox-title');
  const heading = element('div', 'update-heading');
  const title = element('h2', '', '站内信');
  title.id = 'update-inbox-title';
  const close = element('button', 'icon-button', '×');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭站内信');
  heading.append(title, close);
  const current = element('p', 'update-current');
  const status = element('p', 'update-status');
  status.setAttribute('role', 'status');
  const card = element('article', 'update-notice');
  const noticeTitle = element('h3');
  const date = element('p', 'update-date');
  const notes = element('p', 'update-notes');
  const download = element('a', 'button primary', '去更新');
  download.target = '_blank';
  download.rel = 'noopener noreferrer';
  const hint = element('p', 'update-hint', '请明确选择去更新或稍后提醒。稍后约 10 分钟再次提示，重新打开页面也会提醒。升级会保留你的标签、黑名单和备注。');
  card.append(noticeTitle, date, notes, download, hint);
  const check = element('button', 'button secondary', '检查更新');
  check.type = 'button';
  const footer = element('div', 'update-footer');
  const later = element('button', 'button secondary', '稍后提醒');
  later.type = 'button';
  later.hidden = true;
  footer.append(check, later);
  dialog.append(heading, current, status, card, footer);
  document.body.append(dialog);

  function markRead() {
    if (!state.notice) return;
    readId = state.notice.id;
    try { localStorage.setItem(READ_KEY, readId); } catch (_) {}
  }
  function render() {
    const notice = state.notice && safeReleaseUrl(state.notice) ? state.notice : null;
    const unread = isUnread(notice, readId);
    badge.hidden = !unread;
    button.setAttribute('aria-label', unread ? '站内信，1 条未读更新' : '站内信');
    banner.hidden = dialog.open || (!notice && !state.unavailable);
    banner.classList.toggle('unavailable', !notice && state.unavailable);
    bannerText.textContent = notice ? '发现新版本 v' + notice.version + '，升级提醒会保留到更新完成。'
      : '更新检查未成功，暂时无法确认是否有新版，请重试。';
    bannerAction.textContent = notice ? '查看更新' : '重试检查';
    title.textContent = notice ? '发现新版，请选择更新方式' : '站内信';
    close.hidden = Boolean(notice);
    later.hidden = !notice;
    current.textContent = state.current_version ? '当前版本 ' + state.current_version : '正在读取版本信息';
    check.disabled = busy || state.checking;
    check.textContent = busy || state.checking ? '正在检查…' : '检查更新';
    status.textContent = state.checking ? '正在检查新版本…'
      : state.unavailable ? '暂时无法联网检查。已有消息仍可查看，网站可继续正常使用。'
      : notice ? '有一个新版本可供下载。'
      : state.checked_at ? '本次检查未发现比当前安装版本更新的正式版本。' : '暂时无法检查更新，请稍后重试。';
    card.hidden = !notice;
    if (notice) {
      noticeTitle.textContent = notice.title;
      date.textContent = '版本 ' + notice.version + ' · ' + notice.published_at.slice(0, 10);
      notes.textContent = notice.notes;
      download.href = safeReleaseUrl(notice);
    } else download.removeAttribute('href');
  }
  function openInbox() {
    if (!dialog.open) dialog.showModal();
    render();
    checkUpdates(true);
  }
  function showUpdatePrompt() {
    const notice = state.notice && safeReleaseUrl(state.notice) ? state.notice : null;
    if (!notice || dialog.open || document.visibilityState === 'hidden'
        || (notice.id === remindedId && Date.now() < remindAt)
        || document.querySelector('dialog[open]')) return;
    dialog.showModal();
    render();
  }
  function acknowledgeUpdate() {
    markRead();
    remindedId = state.notice.id;
    remindAt = Date.now() + 10 * 60 * 1000;
    dialog.close();
    render();
  }
  async function checkUpdates(manual) {
    if (busy) return;
    clearTimeout(timer);
    busy = true;
    render();
    try {
      const response = await fetch('/__desktop__/updates' + (manual ? '?check=1' : ''),
        { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('Unavailable');
      state = await response.json();
    } catch (_) { state.checking = false; state.unavailable = true; }
    finally { busy = false; render(); }
    showUpdatePrompt();
    const delay = state.checking ? 1500 : 60 * 1000;
    timer = setTimeout(() => checkUpdates(false), remindAt > Date.now() ? Math.min(delay, remindAt - Date.now()) : delay);
  }
  button.addEventListener('click', openInbox);
  bannerAction.addEventListener('click', openInbox);
  close.addEventListener('click', () => dialog.close());
  later.addEventListener('click', acknowledgeUpdate);
  download.addEventListener('click', acknowledgeUpdate);
  dialog.addEventListener('cancel', event => { if (state.notice && safeReleaseUrl(state.notice)) event.preventDefault(); });
  dialog.addEventListener('close', () => { render(); button.focus(); });
  check.addEventListener('click', () => checkUpdates(true));
  window.addEventListener('storage', event => {
    if (event.key === READ_KEY) { readId = event.newValue || ''; render(); }
  });
  document.addEventListener('close', showUpdatePrompt, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { showUpdatePrompt(); checkUpdates(true); }
  });
  window.addEventListener('online', () => checkUpdates(true));
  window.addEventListener('focus', () => { if (document.visibilityState !== 'hidden') checkUpdates(true); });
  checkUpdates(false);
})();
