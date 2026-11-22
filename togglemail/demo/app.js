'use strict';

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const openUrl = (url) => invoke('plugin:opener|open_url', { url });
const $ = (sel) => document.querySelector(sel);
const PAGE = 50;

const state = {
  accounts: [],
  folders: {},      // account id -> [{name, role, delimiter}]
  unread: {},       // "id|folder" -> count
  account: null,    // current account id
  folder: null,     // current folder name
  items: [],        // summaries shown in the list
  total: 0,
  searching: false,
  open: null,       // the message open in the reader
  showImages: false,
};

// ---------- helpers ----------
function toast(text, ms = 3500) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const who = (p) => (p && (p.name || p.email)) || '(unknown)';
const addr = (p) => (p.name ? `${p.name} <${p.email}>` : p.email);
function when(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
const fullDate = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '');
const size = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const folderOf = (id, role) => (state.folders[id] || []).find((f) => f.role === role);
const label = (f) => {
  const names = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', trash: 'Trash', junk: 'Spam', archive: 'Archive', scheduled: 'Scheduled', snoozed: 'Snoozed' };
  if (names[f.role] && !f.name.includes(f.delimiter)) return names[f.role];
  return f.name.split(f.delimiter).pop();
};

// ---------- view options (reading pane, navigation, colours) ----------
const view = { pane: 'right', nav: 'full', tint: 'color' };
try { Object.assign(view, JSON.parse(localStorage.getItem('view') || '{}')); } catch { /* defaults */ }

// Reading and new-mail preferences (Settings > General).
const prefs = { markRead: 'open', images: 'ask', confirmDelete: 'no', interval: '2' };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('prefs') || '{}')); } catch { /* defaults */ }
function savePrefs() {
  try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch { /* not saved */ }
  startPolling();
}

function applyView() {
  const app = $('#app');
  const reading = app.classList.contains('reading');
  app.className = `pane-${view.pane} nav-${view.nav}${view.tint === 'plain' ? ' plain' : ''}${reading ? ' reading' : ''}`;
  for (const k of ['pane', 'nav', 'tint']) {
    const input = document.querySelector(`#view-menu input[name=${k}][value=${view[k]}]`);
    if (input) input.checked = true;
    const sel = document.querySelector(`#settings-dlg [data-view=${k}]`);
    if (sel) sel.value = view[k];
  }
  try { localStorage.setItem('view', JSON.stringify(view)); } catch { /* not saved */ }
}

const ICONS = {
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z"/>',
  sent: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  drafts: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/><path d="m9 17 1-3 4.5-4.5 2 2L12 16Z"/>',
  scheduled: '<circle cx="10" cy="12" r="7"/><path d="M10 8v4l2.5 1.5"/><path d="m17 5 4 0 0 4"/><path d="m21 5-4.5 4.5"/>',
  snoozed: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6M19 3l3 3"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  junk: '<path d="M12 2 2 20h20Z"/><path d="M12 9v5M12 17h.01"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  '': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
};
const folderIcon = (role) => `<svg viewBox="0 0 24 24">${ICONS[role] ?? ICONS['']}</svg>`;

// ---------- sidebar ----------
async function loadAccounts() {
  state.accounts = await invoke('list_accounts');
  $('#compose-btn').disabled = state.accounts.length === 0;
  $('#reader-empty').querySelector('p').hidden = state.accounts.length > 0;
  renderSidebar();
  await Promise.all(state.accounts.map((a) => loadFolders(a.id)));
  if (!state.account && state.accounts.length) {
    const a = state.accounts[0];
    const inbox = folderOf(a.id, 'inbox') || (state.folders[a.id] || [])[0];
    if (inbox) selectFolder(a.id, inbox.name);
  }
}

async function loadFolders(id) {
  try {
    state.folders[id] = await invoke('folders', { account: id });
    state.folders[id].error = null;
  } catch (e) {
    state.folders[id] = Object.assign([], { error: String(e) });
  }
  renderSidebar();
  refreshUnread(id);
}

async function refreshUnread(id) {
  for (const f of state.folders[id] || []) {
    if (!['inbox', 'junk'].includes(f.role)) continue;
    try {
      state.unread[`${id}|${f.name}`] = await invoke('unread', { account: id, folder: f.name });
    } catch { /* offline: keep the old number */ }
  }
  renderSidebar();
}

// ---------- accounts grouped by mail service ----------
const SERVICES = [
  { id: 'toggle', label: 'Toggle Minds', test: (h, d) => /jaiaditya\.org$/.test(h) || ['shankars.org', 'jaiaditya.org', 'knkoa.org', 'toggleminds.com', 'phonemail.net'].includes(d),
    logo: '<img src="logo.svg" alt="">' },
  { id: 'google', label: 'Google', test: (h) => /gmail\.com$|google/.test(h),
    logo: '<svg viewBox="0 0 24 24" class="brand-logo"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3Z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2Z"/><path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1Z"/></svg>' },
  { id: 'microsoft', label: 'Microsoft', test: (h) => /office365|outlook|hotmail|live\.com/.test(h),
    logo: '<svg viewBox="0 0 24 24" class="brand-logo"><path fill="#F25022" d="M3 3h8.5v8.5H3z"/><path fill="#7FBA00" d="M12.5 3H21v8.5h-8.5z"/><path fill="#00A4EF" d="M3 12.5h8.5V21H3z"/><path fill="#FFB900" d="M12.5 12.5H21V21h-8.5z"/></svg>' },
  { id: 'apple', label: 'Apple iCloud', test: (h) => /mail\.me\.com|icloud/.test(h),
    logo: '<svg viewBox="0 0 24 24" class="brand-logo mono"><path d="M16.4 12.7c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.5-1-2.5-3.9ZM14 5.6c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.1-.6 2.8-1.4Z"/></svg>' },
  { id: 'yahoo', label: 'Yahoo', test: (h) => /yahoo/.test(h),
    logo: '<svg viewBox="0 0 24 24" class="brand-logo"><rect width="24" height="24" rx="5" fill="#6001D2"/><path fill="#fff" d="M5 7h3l2 4.6L12.1 7H15l-4.2 9H8l1-2.1Zm11 0h3l-2.6 6h-3Zm-1.6 7h2.4v2.4h-2.4z"/></svg>' },
  { id: 'proton', label: 'Proton', test: (h, d) => /proton|pm\.me/.test(d) || h === '127.0.0.1',
    logo: '<svg viewBox="0 0 24 24" class="brand-logo"><rect width="24" height="24" rx="5" fill="#6D4AFF"/><path fill="#fff" d="M7 18V6h5.5a4 4 0 0 1 0 8H10v4Zm3-6.6h2.3a1.4 1.4 0 0 0 0-2.8H10Z"/></svg>' },
  { id: 'zoho', label: 'Zoho', test: (h) => /zoho/.test(h),
    logo: '<svg viewBox="0 0 24 24" class="brand-logo"><rect width="24" height="24" rx="5" fill="#E42527"/><path fill="#fff" d="M6 7h8v2l-5 6h5v2H6v-2l5-6H6Z"/></svg>' },
];
const OTHER_LOGO = '<svg viewBox="0 0 24 24" class="brand-logo mono"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';

function serviceOf(a) {
  const h = (a.imap_host || '').toLowerCase();
  const d = domainOf(a.email);
  return SERVICES.find((s) => s.test(h, d)) || { id: 'other:' + d, label: d, logo: OTHER_LOGO };
}

/** Initials from the account's name (first, middle, last); without a name, guessed from the address. */
function initialsOf(a) {
  let words = (a.name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    const local = a.email.split('@')[0];
    words = local.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s._\-+]+/).filter((w) => /[a-z]/i.test(w));
  }
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const letters = words.length === 2 ? [words[0], words[1]] : [words[0], words[1], words[words.length - 1]];
  return letters.map((w) => w[0]).join('').toUpperCase().slice(0, 3);
}

function renderSidebar() {
  const nav = $('#accounts');
  nav.innerHTML = '';
  // Group accounts by mail service, in the order of SERVICES, then other domains.
  const groups = new Map();
  for (const a of state.accounts) {
    const s = serviceOf(a);
    if (!groups.has(s.id)) groups.set(s.id, { service: s, accounts: [] });
    groups.get(s.id).accounts.push(a);
  }
  const rank = (id) => { const i = SERVICES.findIndex((s) => s.id === id); return i < 0 ? 99 : i; };
  const ordered = [...groups.values()].sort((x, y) => rank(x.service.id) - rank(y.service.id) || x.service.label.localeCompare(y.service.label));
  for (const g of ordered) {
    const head = document.createElement('div');
    head.className = 'service-head';
    head.title = g.service.label;
    head.innerHTML = `<span class="service-logo">${g.service.logo}</span><span class="txt">${esc(g.service.label)}</span>`;
    nav.append(head);
    for (const a of g.accounts) renderAccount(nav, a, g.service);
  }
}

function renderAccount(nav, a, service) {
  {
    const box = document.createElement('div');
    box.className = 'acct';
    const hue = [...a.email.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
    const ini = esc(initialsOf(a));
    box.innerHTML = `<div class="acct-head" title="${esc((a.name ? a.name + ' · ' : '') + a.email)}">
      <span class="avatar${ini.length > 2 ? ' three' : ''}" style="background:hsl(${hue} 60% 74%)">${ini}<span class="badge">${service.logo}</span></span>
      <span class="aname"><span class="who">${esc(a.name || a.email.split('@')[0])}</span><span class="addr">${esc(a.email)}</span></span>
      <button title="Account settings">⚙</button></div>`;
    box.querySelector('button').onclick = () => openAccountForm(a);
    // With icons-only navigation the avatar opens the account settings.
    box.querySelector('.avatar').onclick = () => view.nav === 'icons' && openAccountForm(a);
    const folders = state.folders[a.id];
    if (folders?.error) {
      const e = document.createElement('div');
      e.className = 'acct-error';
      e.textContent = folders.error;
      box.append(e);
    }
    for (const f of folders || []) {
      const row = document.createElement('div');
      row.className = 'folder' + (f.role === '' && f.name.includes(f.delimiter) ? ' sub' : '');
      if (a.id === state.account && f.name === state.folder && !state.virtual) row.classList.add('active');
      const n = state.unread[`${a.id}|${f.name}`];
      row.title = label(f);
      row.innerHTML = `${folderIcon(f.role)}<span class="fname">${esc(label(f))}</span>${n ? `<span class="count">${n}</span>` : ''}`;
      if (f.role === '') {
        // Your own folders: rename and delete buttons show on hover.
        const tools = document.createElement('span');
        tools.className = 'ftools';
        tools.innerHTML = '<button type="button" title="Rename folder">✎</button><button type="button" title="Delete folder">🗑</button>';
        const [ren, del] = tools.querySelectorAll('button');
        ren.onclick = (e) => { e.stopPropagation(); openFolderDialog(a.id, f); };
        del.onclick = (e) => { e.stopPropagation(); deleteFolder(a.id, f, null); };
        row.append(tools);
      }
      row.onclick = () => selectFolder(a.id, f.name);
      row.oncontextmenu = (e) => folderMenu(e, a.id, f);
      // Drop a message here to move it.
      row.ondragover = (e) => { if (a.id === state.account && f.name !== state.folder) { e.preventDefault(); row.classList.add('drop'); } };
      row.ondragleave = () => row.classList.remove('drop');
      row.ondrop = (e) => {
        e.preventDefault();
        row.classList.remove('drop');
        const uid = +e.dataTransfer.getData('text/uid');
        if (uid) moveUid(uid, f.name);
      };
      box.append(row);
      if (f.role === 'inbox') {
        // Starred: flagged mail in the inbox (a view, not a server folder), as in PhoneMail.
        const star = document.createElement('div');
        star.className = 'folder' + (a.id === state.account && state.virtual === 'starred' ? ' active' : '');
        star.title = 'Starred';
        star.innerHTML = `<svg viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9Z"/></svg><span class="fname">Starred</span>`;
        star.onclick = () => selectFolder(a.id, STARRED);
        box.append(star);
      }
    }
    if (folders && !folders.error && a.protocol !== 'pop3') {
      const add = document.createElement('div');
      add.className = 'folder new-folder-row';
      add.title = 'New folder';
      add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 10v6M9 13h6"/></svg><span class="fname">New folder</span>';
      add.onclick = () => openFolderDialog(a.id);
      box.append(add);
    }
    nav.append(box);
  }
}

// ---------- message list ----------
const STARRED = '\u0000starred';

async function selectFolder(id, folder) {
  state.account = id;
  state.virtual = folder === STARRED ? 'starred' : null;
  // Starred messages live in the inbox, so actions on them use the inbox.
  state.folder = state.virtual ? folderOf(id, 'inbox')?.name || 'INBOX' : folder;
  state.searching = false;
  $('#search').value = '';
  closeReader();
  renderSidebar();
  const acct = state.accounts.find((a) => a.id === id);
  const title = state.virtual ? 'Starred' : label((state.folders[id] || []).find((f) => f.name === folder) || { name: folder, role: '', delimiter: '/' });
  $('#list-title').textContent = `${title} · ${acct?.email ?? ''}`;
  await loadMessages(true);
  renderMoveMenu();
}

const currentRole = () => (state.virtual ? state.virtual : (state.folders[state.account] || []).find((f) => f.name === state.folder)?.role || '');

async function loadMessages(reset) {
  const list = $('#messages');
  if (reset) {
    state.items = [];
    list.innerHTML = '<li class="placeholder">Loading…</li>';
  }
  try {
    if (state.virtual === 'starred') {
      const r = await invoke('starred', { account: state.account });
      state.items = r.items;
      state.total = r.items.length;
      return renderList();
    }
    const page = await invoke('messages', { account: state.account, folder: state.folder, before: state.items.length, limit: PAGE });
    state.total = page.total;
    state.items = reset ? page.items : state.items.concat(page.items);
    renderList();
  } catch (e) {
    list.innerHTML = `<li class="placeholder">${esc(e)}</li>`;
  }
}

function renderList() {
  const list = $('#messages');
  list.innerHTML = '';
  if (!state.items.length) list.innerHTML = `<li class="placeholder">${state.searching ? 'Nothing found' : 'No messages'}</li>`;
  const sentLike = ['sent', 'drafts'].includes((state.folders[state.account] || []).find((f) => f.name === state.folder)?.role);
  for (const m of state.items) {
    const li = document.createElement('li');
    li.dataset.uid = m.uid;
    if (!m.seen) li.classList.add('unread');
    if (state.open?.uid === m.uid) li.classList.add('active');
    const role = currentRole();
    const name = sentLike || role === 'scheduled' ? 'To: ' + (m.to.map(who).join(', ') || '—') : who(m.from);
    // Scheduled shows when it will go out; Snoozed shows when it comes back.
    const whenHtml = role === 'scheduled' && m.send_at
      ? `<span class="when sched" title="Sends ${esc(fullDate(m.send_at))}">⏰ ${when(m.send_at)}</span>`
      : role === 'snoozed' && m.snoozed_until
        ? `<span class="when sched" title="Back ${esc(fullDate(m.snoozed_until))}">⏰ ${when(m.snoozed_until)}</span>`
        : `<span class="when">${when(m.date)}</span>`;
    li.innerHTML = `<div class="top"><span class="who">${esc(name)}</span>${m.flagged ? '<span class="flag">★</span>' : ''}${whenHtml}</div>
      <div class="subj">${m.answered ? '↩ ' : ''}${esc(m.subject)}</div>`;
    li.onclick = () => openMessage(m.uid);
    li.draggable = true;
    li.ondragstart = (e) => { e.dataTransfer.setData('text/uid', String(m.uid)); li.classList.add('dragging'); };
    li.ondragend = () => li.classList.remove('dragging');
    list.append(li);
  }
  $('#more-btn').hidden = state.searching || state.items.length >= state.total;
}

// ---------- reader ----------
function closeReader() {
  state.open = null;
  $('#reader-msg').hidden = true;
  $('#reader-empty').hidden = false;
  $('#app').classList.remove('reading');
}

async function openMessage(uid) {
  state.showImages = false;
  document.querySelectorAll('#messages li').forEach((li) => li.classList.toggle('active', +li.dataset.uid === uid));
  try {
    const markRead = prefs.markRead === 'open';
    const m = await invoke('open_message', { account: state.account, folder: state.folder, uid, markRead });
    state.open = m;
    state.showImages = prefs.images === 'always';
    const item = state.items.find((x) => x.uid === uid);
    if (markRead && item && !item.seen) {
      item.seen = true;
      renderList();
      refreshUnread(state.account);
    }
    renderReader();
  } catch (e) {
    toast(String(e));
  }
}

function renderReader() {
  const m = state.open;
  $('#reader-empty').hidden = true;
  $('#reader-msg').hidden = false;
  $('#app').classList.add('reading');
  $('#r-subject').textContent = m.subject;
  $('#r-from').textContent = m.from.name || m.from.email;
  $('#r-from-email').textContent = m.from.name ? `<${m.from.email}>` : '';
  const to = m.to.map(addr).join(', ');
  const cc = m.cc.map(addr).join(', ');
  $('#r-to').textContent = `To: ${to}${cc ? ' · Cc: ' + cc : ''}`;
  $('#r-date').textContent = fullDate(m.date);
  const item = state.items.find((x) => x.uid === m.uid);
  $('#reader-msg [data-act=flag]').textContent = item?.flagged ? '★ Unflag' : '☆ Flag';
  $('#reader-msg [data-act=unread]').textContent = item && !item.seen ? 'Mark read' : 'Mark unread';
  const inJunk = folderOf(state.account, 'junk')?.name === state.folder;
  $('#reader-msg [data-act=junk]').textContent = inJunk ? 'Not spam' : 'Spam';
  const role = currentRole();
  const pop = state.accounts.find((a) => a.id === state.account)?.protocol === 'pop3';
  $('#reader-msg [data-act=snooze]').hidden = pop || role === 'snoozed' || role === 'scheduled';
  $('#reader-msg [data-act=unsnooze]').hidden = role !== 'snoozed';
  $('#reader-msg [data-act=sendnow]').hidden = role !== 'scheduled';
  $('#reader-msg [data-act=unschedule]').hidden = role !== 'scheduled';
  if (role === 'scheduled' && item?.send_at) $('#r-date').textContent = `Will be sent ${fullDate(item.send_at)}`;
  if (role === 'snoozed' && item?.snoozed_until) $('#r-date').textContent = `Snoozed until ${fullDate(item.snoozed_until)}`;
  if (trustsImages(m.from.email)) state.showImages = true;
  $('#remote-banner').hidden = !m.has_remote_images || state.showImages;

  const ul = $('#r-attachments');
  ul.innerHTML = '';
  for (const a of m.attachments) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = `📎 ${a.name} (${size(a.size)})`;
    b.onclick = async () => {
      try {
        const path = await invoke('save_attachment', { account: state.account, folder: state.folder, uid: m.uid, index: a.index });
        toast(`Saved to ${path}`);
        invoke('plugin:opener|reveal_item_in_dir', { path }).catch(() => {});
      } catch (e) { toast(String(e)); }
    };
    li.append(b);
    ul.append(li);
  }
  if (m.attachments.length > 1) {
    const li = document.createElement('li');
    const all = document.createElement('button');
    all.textContent = `⬇ Save all ${m.attachments.length}`;
    all.onclick = async () => {
      let saved = 0;
      let last = '';
      for (const a of m.attachments) {
        try {
          last = await invoke('save_attachment', { account: state.account, folder: state.folder, uid: m.uid, index: a.index });
          saved++;
        } catch (e) { toast(String(e)); }
      }
      toast(`Saved ${saved} file${saved === 1 ? '' : 's'} to Downloads`);
      if (last) invoke('plugin:opener|reveal_item_in_dir', { path: last }).catch(() => {});
    };
    li.append(all);
    ul.append(li);
  }

  const imgs = state.showImages ? 'data: https: http:' : 'data:';
  const frame = $('#r-body');
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgs}; style-src 'unsafe-inline'; font-src data:">
    <base target="_blank"><style>body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Ubuntu,sans-serif;margin:16px;color:#1c2430;word-wrap:break-word}
    img{max-width:100%;height:auto}blockquote{border-left:3px solid #ccd;margin-left:4px;padding-left:10px;color:#556}
    </style></head><body>${m.html}</body></html>`;
  frame.onload = () => {
    // Links open in the system browser; the frame itself never runs scripts.
    frame.contentDocument.addEventListener('click', (ev) => {
      const a = ev.target.closest('a[href]');
      if (!a) return;
      ev.preventDefault();
      const href = a.getAttribute('href');
      if (href.startsWith('mailto:')) composeTo(decodeURIComponent(href.slice(7).split('?')[0]));
      else if (/^https?:/i.test(href)) openUrl(href);
    });
  };
}

function renderMoveMenu() {
  const sel = $('#move-to');
  sel.innerHTML = '<option value="">Move to…</option>';
  for (const f of state.folders[state.account] || []) {
    if (f.name === state.folder) continue;
    const o = document.createElement('option');
    o.value = f.name;
    o.textContent = label(f);
    sel.append(o);
  }
}

async function afterRemoval(uid) {
  const i = state.items.findIndex((x) => x.uid === uid);
  state.items = state.items.filter((x) => x.uid !== uid);
  state.total = Math.max(0, state.total - 1);
  renderList();
  const next = state.items[Math.min(i, state.items.length - 1)];
  if (next) openMessage(next.uid); else closeReader();
  refreshUnread(state.account);
}

async function moveOpen(target) {
  return moveUid(state.open.uid, target);
}

async function moveUid(uid, target) {
  try {
    await invoke('move_message', { account: state.account, folder: state.folder, uid, target });
    const f = (state.folders[state.account] || []).find((x) => x.name === target);
    toast(`Moved to ${f ? label(f) : target}`);
    if (state.open?.uid === uid) afterRemoval(uid);
    else {
      state.items = state.items.filter((x) => x.uid !== uid);
      state.total = Math.max(0, state.total - 1);
      renderList();
      refreshUnread(state.account);
    }
  } catch (e) { toast(String(e)); }
}

async function act(action) {
  const m = state.open;
  if (!m) return;
  const item = state.items.find((x) => x.uid === m.uid);
  try {
    switch (action) {
      case 'reply': return composeReply(false);
      case 'replyall': return composeReply(true);
      case 'forward': return composeForward();
      case 'delete':
        if (prefs.confirmDelete === 'yes' && act.armed !== m.uid) {
          act.armed = m.uid;
          setTimeout(() => (act.armed = null), 4000);
          return toast('Press Delete again to confirm');
        }
        act.armed = null;
        await invoke('delete_message', { account: state.account, folder: state.folder, uid: m.uid });
        toast('Deleted');
        return afterRemoval(m.uid);
      case 'archive': {
        const f = folderOf(state.account, 'archive');
        if (!f) return toast('This account has no Archive folder');
        return moveOpen(f.name);
      }
      case 'junk': {
        const inJunk = folderOf(state.account, 'junk')?.name === state.folder;
        const f = folderOf(state.account, inJunk ? 'inbox' : 'junk');
        if (!f) return toast('This account has no Junk folder');
        return moveOpen(f.name);
      }
      case 'snooze':
        return openTimeMenu($('#reader-msg [data-act=snooze]'), 'Snooze until', async (until) => {
          try {
            await invoke('snooze', { account: state.account, folder: state.folder, uid: m.uid, until });
            toast(`Snoozed until ${fullDate(until)}`);
            await loadFolders(state.account);
            afterRemoval(m.uid);
          } catch (e) { toast(String(e)); }
        });
      case 'unsnooze':
        await invoke('unsnooze', { account: state.account, uid: m.uid });
        toast('Back in your inbox');
        refreshUnread(state.account);
        return afterRemoval(m.uid);
      case 'sendnow':
        await invoke('send_scheduled_now', { account: state.account, uid: m.uid });
        toast('Sent');
        return afterRemoval(m.uid);
      case 'unschedule': {
        const drafts = folderOf(state.account, 'drafts');
        if (!drafts) return toast('This account has no Drafts folder');
        return moveOpen(drafts.name);
      }
      case 'unread': {
        const seen = !(item?.seen ?? true);
        await invoke('set_flag', { account: state.account, folder: state.folder, uid: m.uid, flag: 'seen', on: seen });
        if (item) item.seen = seen;
        renderList();
        refreshUnread(state.account);
        return seen ? renderReader() : closeReader();
      }
      case 'flag': {
        const on = !item?.flagged;
        await invoke('set_flag', { account: state.account, folder: state.folder, uid: m.uid, flag: 'flagged', on });
        if (item) item.flagged = on;
        renderList();
        return renderReader();
      }
    }
  } catch (e) { toast(String(e)); }
}

// ---------- compose ----------
let draftMeta = {};
let files = [];
let savedRange = null;

function fillFromSelect() {
  const sel = $('#compose-form [name=account]');
  sel.innerHTML = '';
  for (const a of state.accounts) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.name ? `${a.name} <${a.email}>` : a.email;
    sel.append(o);
  }
  sel.value = state.account || state.accounts[0]?.id;
}

function signatureHtml(id) {
  const a = state.accounts.find((x) => x.id === id);
  return a?.signature ? `<p><br></p><div class="signature">-- <br>${a.signature}</div>` : '';
}

function openCompose({ to = '', cc = '', subject = '', body = '', meta = {} } = {}) {
  if (!state.accounts.length) return toast('Add an account first');
  const f = $('#compose-form');
  fillFromSelect();
  f.to.value = to;
  f.cc.value = cc;
  f.bcc.value = '';
  f.subject.value = subject;
  $('#editor').innerHTML = `<p><br></p>${signatureHtml(f.account.value)}${body}`;
  draftMeta = meta;
  files = [];
  renderFiles();
  $('#compose-error').textContent = '';
  $('#compose-dlg').showModal();
  (to ? $('#editor') : f.to).focus();
}

const composeTo = (address) => openCompose({ to: address });

function quoteBlock(m) {
  return `<p>On ${esc(fullDate(m.date))}, ${esc(addr(m.from))} wrote:</p><blockquote>${m.html}</blockquote>`;
}

function composeReply(all) {
  const m = state.open;
  const me = state.accounts.find((a) => a.id === state.account)?.email.toLowerCase();
  const primary = (m.reply_to.length ? m.reply_to : [m.from]).map(addr);
  let cc = [];
  if (all) {
    cc = [...m.to, ...m.cc]
      .filter((p) => p.email && p.email.toLowerCase() !== me && !primary.some((x) => x.includes(p.email)))
      .map(addr);
  }
  const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
  openCompose({
    to: primary.join(', '),
    cc: cc.join(', '),
    subject,
    body: quoteBlock(m),
    meta: { in_reply_to: m.message_id, references: `${m.references} ${m.message_id}`.trim(), reply_uid: m.uid, reply_folder: state.folder },
  });
}

function composeForward() {
  const m = state.open;
  const subject = /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`;
  const head = `<p>---------- Forwarded message ----------<br>From: ${esc(addr(m.from))}<br>Date: ${esc(fullDate(m.date))}<br>Subject: ${esc(m.subject)}<br>To: ${esc(m.to.map(addr).join(', '))}</p>`;
  openCompose({ subject, body: head + m.html });
}

function renderFiles() {
  const ul = $('#compose-files');
  ul.innerHTML = '';
  files.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = `📎 ${esc(f.name)} (${size(f.size)})<button type="button" title="Remove">✕</button>`;
    li.querySelector('button').onclick = () => { files.splice(i, 1); renderFiles(); };
    ul.append(li);
  });
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, mime: file.type || 'application/octet-stream', size: file.size, data: String(r.result).split(',')[1] || '' });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const splitList = (s) => s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);

function htmlToText(html) {
  const div = document.createElement('div');
  div.innerHTML = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|blockquote)>/gi, '\n');
  return div.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

/** Sends now, or with `sendAt` (unix seconds) puts it in Scheduled to go out then. */
async function send(ev, sendAt = 0) {
  ev?.preventDefault();
  const f = $('#compose-form');
  const btn = $('#send-btn');
  const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px">${$('#editor').innerHTML}</div>`;
  const draft = {
    to: splitList(f.to.value),
    cc: splitList(f.cc.value),
    bcc: splitList(f.bcc.value),
    subject: f.subject.value,
    html,
    text: htmlToText($('#editor').innerHTML),
    in_reply_to: draftMeta.in_reply_to || '',
    references: draftMeta.references || '',
    attachments: files.map(({ name, mime, data }) => ({ name, mime, data })),
  };
  btn.disabled = true;
  btn.textContent = 'Sending…';
  $('#compose-error').textContent = '';
  try {
    const sameAccount = f.account.value === state.account;
    if (sendAt) {
      await invoke('schedule_send', { account: f.account.value, draft, sendAt });
      $('#compose-dlg').close();
      toast(`Scheduled for ${fullDate(sendAt)}. Keep ToggleMail open on a computer that's on at that time.`, 7000);
      loadFolders(f.account.value);
      return;
    }
    await invoke('send', {
      account: f.account.value,
      draft,
      replyToUid: sameAccount ? draftMeta.reply_uid ?? null : null,
      replyFolder: sameAccount ? draftMeta.reply_folder ?? null : null,
    });
    $('#compose-dlg').close();
    toast('Sent');
    if (draftMeta.reply_uid) {
      const it = state.items.find((x) => x.uid === draftMeta.reply_uid);
      if (it) { it.answered = true; renderList(); }
    }
  } catch (e) {
    $('#compose-error').textContent = String(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}

// ---------- account form ----------
let editing = null;

function openAccountForm(account = null) {
  editing = account;
  const f = $('#account-form');
  f.reset();
  $('#account-title').textContent = account ? 'Account settings' : 'Add account';
  $('#account-save').textContent = account ? 'Save' : 'Sign in';
  $('#account-remove').hidden = !account;
  $('#account-error').textContent = '';
  $('#provider-note').textContent = '';
  $('#advanced').open = !!account;
  if (account) {
    for (const k of ['name', 'email', 'username', 'protocol', 'imap_host', 'imap_port', 'incoming_security', 'smtp_host', 'smtp_port', 'smtp_security', 'signature']) f[k].value = account[k] ?? f[k].value;
    f.accept_invalid_certs.checked = !!account.accept_invalid_certs;
    f.password.placeholder = 'Leave blank to keep the saved password';
    f.password.required = false;
  } else {
    f.password.placeholder = '';
    f.password.required = true;
  }
  $('#incoming-label').textContent = f.protocol.value === 'pop3' ? 'POP3 server' : 'IMAP server';
  $('#account-save').disabled = false;
  $('#app-password-btn').hidden = true;
  showCertOption('known'); // hidden unless already ticked; a provider choice updates it
  $('#account-dlg').showModal();
}

async function loadProviders() {
  const sel = $('#account-form').provider;
  for (const p of await invoke('providers')) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label;
    sel.append(o);
  }
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = 'Other / custom servers';
  sel.append(custom);
}

/// Fills the server fields from the chosen provider (or the address), unless the user picked custom.
async function suggestServers() {
  const f = $('#account-form');
  $('#incoming-label').textContent = f.protocol.value === 'pop3' ? 'POP3 server' : 'IMAP server';
  if (f.provider.value === 'custom') {
    $('#provider-note').textContent = 'Enter the server names and ports your mail provider gives you.';
    $('#app-password-btn').hidden = true;
    showCertOption('');
    $('#advanced').open = true;
    $('#account-save').disabled = false;
    return;
  }
  if (!f.email.value.includes('@')) return;
  const s = await invoke('guess_settings', { email: f.email.value, provider: f.provider.value, protocol: f.protocol.value });
  if (s.protocol !== f.protocol.value) f.protocol.value = s.protocol;
  $('#incoming-label').textContent = s.protocol === 'pop3' ? 'POP3 server' : 'IMAP server';
  f.imap_host.value = s.imap_host;
  f.imap_port.value = s.imap_port;
  f.incoming_security.value = s.incoming_security;
  f.smtp_host.value = s.smtp_host;
  f.smtp_port.value = s.smtp_port;
  f.smtp_security.value = s.smtp_security;
  f.accept_invalid_certs.checked = s.accept_invalid_certs;
  if (!f.username.value) f.username.placeholder = f.email.value;
  let note = s.note;
  if (!s.pop3_available && s.supported) note = (note ? note + ' ' : '') + 'This provider offers IMAP only.';
  if (s.provider === 'icloud' && !/@(icloud|me|mac)\.com$/i.test(f.email.value.trim())) {
    note = 'iCloud Mail signs in with your @icloud.com address (Settings > your name > iCloud > iCloud Mail on an iPhone), '
      + 'not an Apple ID that is a Gmail or other address. ' + note;
  }
  $('#provider-note').textContent = note;
  // A button to the provider's app-password page, where one is needed.
  const page = APP_PASSWORD_PAGES[s.provider];
  const btn = $('#app-password-btn');
  btn.hidden = !page;
  btn.onclick = () => page && openUrl(page);
  showCertOption(s.provider);
  $('#account-save').disabled = !s.supported;
}

const APP_PASSWORD_PAGES = {
  gmail: 'https://myaccount.google.com/apppasswords',
  icloud: 'https://account.apple.com/account/manage/section/security',
  yahoo: 'https://login.yahoo.com/account/security/app-passwords/list',
  startmail: 'https://mail.startmail.com/settings',
};

/** The "accept the server's own certificate" box only makes sense for a local bridge or custom servers. */
function showCertOption(provider) {
  const f = $('#account-form');
  const show = provider === 'proton' || provider === '' || f.accept_invalid_certs.checked;
  f.accept_invalid_certs.closest('label').hidden = !show;
}

/// Standard ports when the security choice changes on custom servers.
function defaultPorts(ev) {
  const f = $('#account-form');
  const pop = f.protocol.value === 'pop3';
  if (ev.target === f.incoming_security) f.imap_port.value = f.incoming_security.value === 'tls' ? (pop ? 995 : 993) : (pop ? 110 : 143);
  if (ev.target === f.smtp_security) f.smtp_port.value = f.smtp_security.value === 'tls' ? 465 : 587;
}

async function saveAccount(ev) {
  ev.preventDefault();
  const f = $('#account-form');
  const btn = $('#account-save');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  $('#account-error').textContent = '';
  try {
    const input = {
      id: editing?.id ?? null,
      name: f.name.value,
      email: f.email.value,
      username: f.username.value,
      protocol: f.protocol.value,
      imap_host: f.imap_host.value,
      imap_port: +f.imap_port.value,
      incoming_security: f.incoming_security.value,
      smtp_host: f.smtp_host.value,
      smtp_port: +f.smtp_port.value,
      smtp_security: f.smtp_security.value,
      accept_invalid_certs: f.accept_invalid_certs.checked,
      signature: f.signature.value,
    };
    const saved = await invoke('save_account', { input, password: f.password.value });
    $('#account-dlg').close();
    toast(`${saved.email} is ready`);
    if (!editing) state.account = null;
    await loadAccounts();
    if (!editing) {
      const inbox = folderOf(saved.id, 'inbox');
      if (inbox) selectFolder(saved.id, inbox.name);
    }
  } catch (e) {
    $('#account-error').textContent = String(e);
    $('#advanced').open = true;
  } finally {
    btn.disabled = false;
    btn.textContent = editing ? 'Save' : 'Sign in';
  }
}

async function removeAccount() {
  if (!editing) return;
  const btn = $('#account-remove');
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = 'Click again to remove';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Remove account'; }, 4000);
    return;
  }
  await invoke('remove_account', { id: editing.id });
  delete state.folders[editing.id];
  if (state.account === editing.id) {
    state.account = null;
    state.items = [];
    renderList();
    closeReader();
  }
  $('#account-dlg').close();
  toast('Account removed from this computer (mail stays on the server)');
  loadAccounts();
}

// ---------- wiring ----------
function wire() {
  applyView();
  $('#nav-toggle').onclick = () => { view.nav = view.nav === 'icons' ? 'full' : 'icons'; applyView(); };
  $('#view-btn').onclick = (e) => { e.stopPropagation(); $('#view-menu').hidden = !$('#view-menu').hidden; };
  $('#view-menu').onclick = (e) => e.stopPropagation();
  $('#view-menu').onchange = (e) => { view[e.target.name] = e.target.value; applyView(); };
  document.addEventListener('click', () => ($('#view-menu').hidden = true));
  $('#back-btn').onclick = () => {
    closeReader();
    document.querySelectorAll('#messages li.active').forEach((li) => li.classList.remove('active'));
  };

  $('#compose-btn').onclick = () => openCompose();
  $('#add-account-btn').onclick = () => openAccountForm();
  $('#refresh-btn').onclick = () => state.account && selectFolder(state.account, state.folder);
  $('#more-btn').onclick = () => loadMessages(false);
  $('#show-images').onclick = () => {
    const who = trustImages(state.open.from.email);
    state.showImages = true;
    renderReader();
    if (who) toast(`Pictures from ${who} will always show`);
  };
  $('#move-to').onchange = (e) => { if (e.target.value) moveOpen(e.target.value); e.target.value = ''; };
  document.querySelectorAll('#reader-msg [data-act]').forEach((b) => (b.onclick = (e) => {
    if (b.dataset.act === 'snooze') e.stopPropagation(); // keep the time menu open
    act(b.dataset.act);
  }));

  let timer;
  $('#search').oninput = (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    timer = setTimeout(async () => {
      if (!state.account) return;
      if (!q) return selectFolder(state.account, state.folder);
      state.searching = true;
      try {
        state.items = await invoke('search', { account: state.account, folder: state.folder, query: q });
        renderList();
      } catch (err) { toast(String(err)); }
    }, 400);
  };

  $('#account-form').onsubmit = saveAccount;
  $('#account-form').email.onchange = () => !editing && suggestServers();
  $('#account-form').provider.onchange = suggestServers;
  $('#account-form').protocol.onchange = suggestServers;
  $('#account-form').incoming_security.onchange = defaultPorts;
  $('#account-form').smtp_security.onchange = defaultPorts;
  $('#account-cancel').onclick = () => $('#account-dlg').close();
  $('#account-remove').onclick = removeAccount;

  $('#compose-form').onsubmit = send;
  $('#compose-cancel').onclick = () => $('#compose-dlg').close();
  document.querySelectorAll('.editor-bar [data-cmd]').forEach((b) => {
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      if (b.dataset.cmd === 'createLink') {
        // Remember the selection, then ask for the address in the inline box.
        const sel = window.getSelection();
        savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        $('#link-box').hidden = false;
        $('#link-url').value = 'https://';
        $('#link-url').focus();
        return;
      }
      document.execCommand(b.dataset.cmd, false, null);
      $('#editor').focus();
    };
  });
  $('#link-add').onclick = () => {
    const url = $('#link-url').value.trim();
    $('#link-box').hidden = true;
    if (!savedRange || !/^(https?:\/\/|mailto:)\S+$/i.test(url)) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
    if (savedRange.collapsed) document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>`);
    else document.execCommand('createLink', false, url);
    $('#editor').focus();
  };
  $('#link-url').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#link-add').click(); }
    if (e.key === 'Escape') { e.preventDefault(); $('#link-box').hidden = true; }
  };
  $('#attach-input').onchange = async (e) => {
    for (const file of e.target.files) {
      if (file.size > 25 * 1048576) { toast(`${file.name} is over 25 MB`); continue; }
      files.push(await readFile(file));
    }
    e.target.value = '';
    renderFiles();
  };

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (e.target.matches('input, textarea, [contenteditable]')) return;
    if (e.key === 'F5') { e.preventDefault(); $('#refresh-btn').click(); }
    else if (e.key === 'Escape' && state.open) $('#back-btn').click();
    else if (e.key === 'Delete' && state.open) act('delete');
    else if (e.key === 'r' && state.open) act('reply');
    else if (e.key === 'n' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); openCompose(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!state.items.length) return;
      e.preventDefault();
      const i = state.items.findIndex((x) => x.uid === state.open?.uid);
      const j = Math.max(0, Math.min(state.items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      openMessage(state.items[j].uid);
    }
  });

  wireSettings();
  startPolling();

  // Scheduled sending and snooze wake-ups: check every minute (and once shortly after start).
  setTimeout(runDue, 15000);
  setInterval(runDue, 60000);

  $('#time-set').onclick = () => {
    const v = $('#time-pick').value;
    const t = v ? Math.floor(new Date(v).getTime() / 1000) : 0;
    if (!t || t * 1000 <= Date.now()) return toast('Pick a time in the future');
    $('#time-menu').hidden = true;
    timeChosen?.(t);
  };
  $('#time-menu').onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => ($('#time-menu').hidden = true));
  $('#schedule-btn').onclick = (e) => {
    e.stopPropagation();
    openTimeMenu($('#schedule-btn'), 'Send at', (sendAt) => send(null, sendAt));
  };
}

// ---------- new mail check (interval from Settings) ----------
let pollTimer;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    for (const a of state.accounts) refreshUnread(a.id);
    if (state.account && !state.searching) {
      try {
        const page = await invoke('messages', { account: state.account, folder: state.folder, before: 0, limit: PAGE });
        state.total = page.total;
        const known = new Set(state.items.map((x) => x.uid));
        const fresh = page.items.filter((x) => !known.has(x.uid));
        if (fresh.length) { state.items = fresh.concat(state.items); renderList(); }
      } catch { /* offline */ }
    }
  }, Math.max(1, +prefs.interval || 2) * 60000);
}

// ---------- pictures: remembered senders ----------
// Our own domains always load pictures. Allowing a sender remembers its domain, except on
// personal-mail services, where only that one address is remembered.
const OUR_DOMAINS = ['phonemail.net', 'shankars.org', 'jaiaditya.org', 'knkoa.org', 'toggleminds.com'];
const PERSONAL_MAIL = ['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'ymail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'zoho.com',
  'zohomail.in', 'rediffmail.com', 'gmx.com', 'mail.com', 'tuta.com', 'tutanota.com'];
let trusted = [];
try { trusted = JSON.parse(localStorage.getItem('trustedImages') || '[]'); } catch { /* none */ }
const domainOf = (email) => (email || '').toLowerCase().split('@').pop();

function trustsImages(email) {
  const e = (email || '').toLowerCase();
  const d = domainOf(e);
  return OUR_DOMAINS.some((x) => d === x || d.endsWith('.' + x)) || trusted.includes(e) || trusted.includes('@' + d);
}

/** Remembers the sender; returns what was remembered (for the message), or '' if nothing new. */
function trustImages(email) {
  const e = (email || '').toLowerCase();
  if (!e.includes('@') || trustsImages(e)) return '';
  const key = PERSONAL_MAIL.includes(domainOf(e)) ? e : '@' + domainOf(e);
  trusted.push(key);
  try { localStorage.setItem('trustedImages', JSON.stringify(trusted)); } catch { /* not saved */ }
  return key.startsWith('@') ? key.slice(1) : key;
}

function renderTrusted() {
  const ul = $('#trusted-list');
  ul.innerHTML = trusted.length ? '' : '<li class="muted">None yet</li>';
  trusted.forEach((t, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="grow">${esc(t.startsWith('@') ? 'Everyone at ' + t.slice(1) : t)}</span><button type="button">Remove</button>`;
    li.querySelector('button').onclick = () => {
      trusted.splice(i, 1);
      try { localStorage.setItem('trustedImages', JSON.stringify(trusted)); } catch { /* not saved */ }
      renderTrusted();
    };
    ul.append(li);
  });
}

// ---------- time picker (snooze and schedule) ----------
let timeChosen = null;
function at(days, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d;
}
function nextWeekday(day, hour) { // 0 = Sunday
  const d = new Date();
  const add = ((day - d.getDay() + 7) % 7) || 7;
  return at(add, hour);
}

function openTimeMenu(anchor, title, onChoose) {
  const now = new Date();
  const later = new Date(now.getTime() + 3 * 3600 * 1000);
  later.setMinutes(0, 0, 0);
  const presets = [
    ['Later today', later, later.getDate() === now.getDate()],
    ['Tomorrow morning', at(1, 8), true],
    ['Tomorrow afternoon', at(1, 13), true],
    ['This weekend', nextWeekday(6, 9), now.getDay() !== 6 && now.getDay() !== 0],
    ['Next week', nextWeekday(1, 8), true],
  ].filter((p) => p[2]);
  const box = $('#time-presets');
  box.innerHTML = '';
  for (const [text, d] of presets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${esc(text)} <span class="muted">${esc(d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>`;
    b.onclick = () => { $('#time-menu').hidden = true; onChoose(Math.floor(d.getTime() / 1000)); };
    box.append(b);
  }
  $('#time-title').textContent = title;
  const pick = new Date(at(1, 9).getTime() - new Date().getTimezoneOffset() * 60000);
  $('#time-pick').value = pick.toISOString().slice(0, 16);
  timeChosen = onChoose;
  const m = $('#time-menu');
  const r = anchor.getBoundingClientRect();
  m.hidden = false;
  m.style.left = `${Math.min(r.left, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 8)}px`;
}

// ---------- scheduled and snoozed mail ----------
async function runDue() {
  for (const a of state.accounts) {
    if (a.protocol === 'pop3') continue;
    try {
      const r = await invoke('run_due', { account: a.id });
      if (r.sent) toast(`${r.sent} scheduled email${r.sent > 1 ? 's' : ''} sent from ${a.email}`);
      if (r.woke) toast(`${r.woke} snoozed email${r.woke > 1 ? 's are' : ' is'} back in your inbox`);
      if ((r.sent || r.woke) && a.id === state.account && !state.open) loadMessages(true);
      if (r.woke) refreshUnread(a.id);
    } catch { /* offline: try again next minute */ }
  }
}

// ---------- settings ----------
function showTab(name) {
  document.querySelectorAll('#settings-dlg .tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('#settings-dlg [data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
  $('#settings-error').textContent = '';
  if (name === 'accounts') renderSettingsAccounts();
  if (name === 'folders') renderSettingsFolders();
}

function openSettings(tab = 'general') {
  for (const sel of document.querySelectorAll('#settings-dlg [data-pref]')) sel.value = prefs[sel.dataset.pref];
  renderTrusted();
  applyView();
  showTab(tab);
  $('#settings-dlg').showModal();
}

function renderSettingsAccounts() {
  const ul = $('#settings-accounts');
  ul.innerHTML = state.accounts.length ? '' : '<li class="muted">No accounts yet</li>';
  for (const a of state.accounts) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="avatar">${esc((a.name || a.email).charAt(0))}</span>
      <span class="grow"><strong>${esc(a.email)}</strong><br><span class="muted">${esc(a.protocol === 'pop3' ? 'POP3' : 'IMAP')} · ${esc(a.imap_host)}</span></span>
      <button type="button" data-do="edit">Edit</button><button type="button" data-do="pw">Change password</button>`;
    li.querySelector('[data-do=edit]').onclick = () => { $('#settings-dlg').close(); openAccountForm(a); };
    li.querySelector('[data-do=pw]').onclick = () => openPassword(a);
    ul.append(li);
  }
}

function renderSettingsFolders() {
  const sel = $('#folders-account');
  const keep = sel.value || state.account;
  sel.innerHTML = '';
  for (const a of state.accounts) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.email;
    sel.append(o);
  }
  sel.value = keep && state.accounts.some((a) => a.id === keep) ? keep : state.accounts[0]?.id || '';
  const id = sel.value;
  const ul = $('#settings-folders');
  ul.innerHTML = '';
  for (const f of state.folders[id] || []) {
    const li = document.createElement('li');
    const standard = f.role !== '';
    li.innerHTML = `${folderIcon(f.role)}<span class="grow">${esc(label(f))}${f.name !== label(f) ? ` <span class="muted">(${esc(f.name)})</span>` : ''}</span>
      ${standard ? '<span class="tag">standard</span>' : '<button type="button" data-do="rename">Rename</button><button type="button" data-do="delete" class="danger">Delete</button>'}`;
    if (!standard) {
      li.querySelector('[data-do=rename]').onclick = () => openFolderDialog(id, f);
      li.querySelector('[data-do=delete]').onclick = (e) => deleteFolder(id, f, e.target);
    }
    ul.append(li);
  }
}

async function afterFolderChange(id) {
  await loadFolders(id);
  renderMoveMenu();
  if ($('#settings-dlg').open) renderSettingsFolders();
}

async function createFolder(id, name) {
  await invoke('create_folder', { account: id, name });
  toast(`Folder "${name}" created`);
  await afterFolderChange(id);
}

async function deleteFolder(id, f, btn) {
  // Second click confirms (no browser dialogs inside the app).
  if (btn && btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Click again to delete';
    setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Delete'; }, 4000);
    return;
  }
  if (!btn && deleteFolder.armed !== `${id}|${f.name}`) {
    deleteFolder.armed = `${id}|${f.name}`;
    setTimeout(() => (deleteFolder.armed = null), 6000);
    return toast(`Click delete again to remove "${label(f)}" and all its messages`, 6000);
  }
  deleteFolder.armed = null;
  try {
    await invoke('delete_folder', { account: id, name: f.name });
    toast(`Folder "${label(f)}" and its messages deleted`);
    if (state.account === id && state.folder === f.name) {
      const inbox = folderOf(id, 'inbox');
      if (inbox) selectFolder(id, inbox.name);
    }
    await afterFolderChange(id);
  } catch (e) { toast(String(e)); }
}

// New folder / rename dialog.
let folderTarget = null;
function openFolderDialog(id, folder = null) {
  folderTarget = { id, folder };
  const f = $('#folder-form');
  f.reset();
  $('#folder-title').textContent = folder ? `Rename "${label(folder)}"` : 'New folder';
  if (folder) f.name.value = label(folder);
  $('#folder-error').textContent = '';
  $('#folder-dlg').showModal();
  f.name.focus();
}

async function saveFolderDialog(ev) {
  ev.preventDefault();
  const { id, folder } = folderTarget;
  const f = $('#folder-form');
  let name = f.name.value.trim();
  try {
    if (folder) {
      // Keep the folder where it is in the tree.
      const parts = folder.name.split(folder.delimiter);
      parts[parts.length - 1] = name;
      name = parts.join(folder.delimiter);
      await invoke('rename_folder', { account: id, from: folder.name, to: name });
      if (state.account === id && state.folder === folder.name) state.folder = name;
      toast('Folder renamed');
      $('#folder-dlg').close();
      await afterFolderChange(id);
    } else {
      $('#folder-dlg').close();
      await createFolder(id, name);
    }
  } catch (e) {
    $('#folder-error').textContent = String(e);
    if (!$('#folder-dlg').open) $('#folder-dlg').showModal();
  }
}

// Right-click on a folder in the sidebar.
function folderMenu(e, id, f) {
  e.preventDefault();
  const m = $('#ctx-menu');
  const items = [['New folder', () => openFolderDialog(id)]];
  if (f.role === '') {
    items.push(['Rename', () => openFolderDialog(id, f)]);
    items.push(['Delete folder', () => deleteFolder(id, f, null), 'danger']);
  }
  items.push(['Mark all as read', () => markAllRead(id, f)]);
  m.innerHTML = '';
  for (const [text, fn, cls] of items) {
    const b = document.createElement('button');
    b.textContent = text;
    if (cls) b.className = cls;
    b.onclick = () => { m.hidden = true; fn(); };
    m.append(b);
  }
  m.style.left = `${e.clientX}px`;
  m.style.top = `${e.clientY}px`;
  m.hidden = false;
}

async function markAllRead(id, f) {
  try {
    const page = await invoke('messages', { account: id, folder: f.name, before: 0, limit: 200 });
    for (const x of page.items.filter((x) => !x.seen)) {
      await invoke('set_flag', { account: id, folder: f.name, uid: x.uid, flag: 'seen', on: true });
    }
    if (state.account === id && state.folder === f.name) state.items.forEach((x) => (x.seen = true));
    renderList();
    refreshUnread(id);
    toast('Marked as read');
  } catch (e) { toast(String(e)); }
}

// ---------- change password ----------
let pwAccount = null;
let pwPlan = null;

async function openPassword(a) {
  pwAccount = a;
  const f = $('#password-form');
  f.reset();
  $('#password-error').textContent = '';
  $('#pw-account').textContent = a.email;
  try {
    pwPlan = await invoke('password_plan', { account: a.id });
  } catch (e) { return toast(String(e)); }
  $('#pw-in-app').hidden = !pwPlan.in_app;
  $('#pw-external').hidden = pwPlan.in_app;
  $('#pw-open-page').hidden = !pwPlan.url;
  $('#pw-external-text').textContent = pwPlan.url
    ? 'This provider only lets you change the password on its website.'
    : 'Change the password with your mail provider (its website or control panel).';
  $('#password-save').textContent = pwPlan.in_app ? 'Change password' : 'Save new password';
  $('#password-dlg').showModal();
}

async function savePassword(ev) {
  ev.preventDefault();
  const f = $('#password-form');
  const btn = $('#password-save');
  const err = $('#password-error');
  err.textContent = '';
  try {
    btn.disabled = true;
    if (pwPlan.in_app) {
      if (f.new1.value !== f.new2.value) throw new Error('the two new passwords are different');
      await invoke('change_password', { account: pwAccount.id, current: f.current.value, new: f.new1.value });
      toast('Password changed. Use the new one in webmail and on your phone too.', 6000);
    } else {
      await invoke('save_new_password', { account: pwAccount.id, password: f.saved.value });
      toast('New password saved');
    }
    $('#password-dlg').close();
  } catch (e) {
    err.textContent = String(e).replace(/^Error: /, '');
  } finally {
    btn.disabled = false;
  }
}

function wireSettings() {
  $('#settings-btn').onclick = () => openSettings();
  $('#settings-close').onclick = () => $('#settings-dlg').close();
  document.querySelectorAll('#settings-dlg [data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  document.querySelectorAll('#settings-dlg [data-view]').forEach((s) => (s.onchange = () => { view[s.dataset.view] = s.value; applyView(); }));
  document.querySelectorAll('#settings-dlg [data-pref]').forEach((s) => (s.onchange = () => { prefs[s.dataset.pref] = s.value; savePrefs(); }));
  $('#settings-add-account').onclick = () => { $('#settings-dlg').close(); openAccountForm(); };
  $('#folders-account').onchange = renderSettingsFolders;
  $('#new-folder-btn').onclick = async () => {
    const name = $('#new-folder-name').value.trim();
    if (!name) return;
    try {
      await createFolder($('#folders-account').value, name);
      $('#new-folder-name').value = '';
    } catch (e) { $('#settings-error').textContent = String(e); }
  };
  $('#folder-form').onsubmit = saveFolderDialog;
  $('#folder-cancel').onclick = () => $('#folder-dlg').close();
  $('#password-form').onsubmit = savePassword;
  $('#password-cancel').onclick = () => $('#password-dlg').close();
  $('#pw-open-page').onclick = () => pwPlan?.url && openUrl(pwPlan.url);
  document.querySelectorAll('a[data-external]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); openUrl(a.href); }));
  document.addEventListener('click', () => ($('#ctx-menu').hidden = true));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#ctx-menu').hidden = true; });
}

wire();
loadProviders().catch(() => {});
loadAccounts().catch((e) => toast(String(e)));
