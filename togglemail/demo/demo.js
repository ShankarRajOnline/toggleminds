// Demo mode: runs the real ToggleMail window in a browser with made-up accounts and mail, for the
// website demo, store screenshots and videos. Loaded before app.js only by demo.html; never part of the app.
// URL options: ?open=<uid>&pane=right|bottom|off&nav=full|icons&tint=color|plain&compose=1&settings=<tab>&folder=<name>
'use strict';
(() => {
  const q = new URLSearchParams(location.search);
  try {
    localStorage.setItem('view', JSON.stringify({ pane: q.get('pane') || 'right', nav: q.get('nav') || 'full', tint: q.get('tint') || 'color' }));
    localStorage.setItem('trustedImages', '[]');
  } catch { /* private window */ }

  const now = Math.floor(Date.now() / 1000);
  const h = 3600;
  const d = 24 * h;
  const acct = (id, name, email, host, smtp) => ({
    id, name, email, username: email, protocol: 'imap', imap_host: host, imap_port: 993, incoming_security: 'tls',
    smtp_host: smtp, smtp_port: 587, smtp_security: 'starttls', accept_invalid_certs: false, signature: '',
  });
  const accounts = [
    acct('home', 'Asha Rao', 'asha@toggleminds.com', 'mail.jaiaditya.org', 'mail.jaiaditya.org'),
    acct('gmail', 'Asha Rao', 'asha.rao@example.com', 'imap.gmail.com', 'smtp.gmail.com'),
    acct('work', 'Asha R. Menon', 'asha.menon@example.org', 'outlook.office365.com', 'smtp.office365.com'),
    acct('icloud', 'Asha Rao', 'asharao@example.net', 'imap.mail.me.com', 'smtp.mail.me.com'),
  ];
  const std = ['INBOX', 'Snoozed', 'Drafts', 'Scheduled', 'Sent', 'Archive', 'Junk', 'Trash'];
  const roles = { INBOX: 'inbox', Snoozed: 'snoozed', Drafts: 'drafts', Scheduled: 'scheduled', Sent: 'sent', Archive: 'archive', Junk: 'junk', Trash: 'trash' };
  const folders = (extra) => [...std, ...extra].map((name) => ({ name, role: roles[name] || '', delimiter: '/' }));
  const folderSets = { home: folders(['Family', 'Travel']), gmail: folders(['Receipts']), work: folders(['Projects']), icloud: folders([]) };

  const p = (name, email) => ({ name, email });
  const me = p('Asha Rao', 'asha@toggleminds.com');
  let uid = 100;
  const msg = (from, subject, ago, body, extra = {}) => ({
    uid: uid++, from, to: [me], subject, date: now - ago, seen: false, flagged: false, answered: false, size: 4000,
    send_at: 0, snoozed_until: 0, body, ...extra,
  });
  const card = (title, lines, colour = '#0f7b6c') => `
    <div style="font-family:system-ui,sans-serif;max-width:560px">
      <div style="background:${colour};color:#fff;padding:18px 22px;border-radius:12px 12px 0 0;font-size:20px;font-weight:700">${title}</div>
      <div style="border:1px solid #e3e7ec;border-top:0;border-radius:0 0 12px 12px;padding:18px 22px;line-height:1.6;color:#1c2430">${lines}</div>
    </div>`;
  const mail = {
    'home|INBOX': [
      msg(p('Ravi Kumar', 'ravi@example.com'), 'Weekend trip: train tickets booked', 25 * 60, card('Train tickets confirmed',
        '<p>Hi Asha,</p><p>All four tickets are booked for Saturday morning. Coach B2, seats 33&ndash;36.</p><p><b>Departs</b> 06:10 &middot; <b>Arrives</b> 11:45</p><p>I have attached the e-tickets and the hotel booking.</p><p>Ravi</p>'),
        { flagged: true, attachments: [{ index: 0, name: 'e-tickets.pdf', mime: 'application/pdf', size: 182000 }, { index: 1, name: 'hotel-booking.pdf', mime: 'application/pdf', size: 96000 }] }),
      msg(p('Meena Iyer', 'meena@example.com'), 'Photos from the school annual day', 2 * h, '<p>Asha, here are the photos from yesterday. The children were wonderful!</p><p>Meena</p>',
        { attachments: [{ index: 0, name: 'annual-day-1.jpg', mime: 'image/jpeg', size: 2400000 }, { index: 1, name: 'annual-day-2.jpg', mime: 'image/jpeg', size: 2100000 }, { index: 2, name: 'annual-day-3.jpg', mime: 'image/jpeg', size: 1900000 }] }),
      msg(p('Toggle Minds', 'hello@toggleminds.com'), 'Welcome to ToggleMail', 5 * h, card('Welcome to ToggleMail',
        '<p>All your email in one place: Gmail, Outlook, iCloud, Yahoo and your own domain.</p><ul><li>Schedule an email for later</li><li>Snooze one until you need it</li><li>Pictures load only from senders you trust</li></ul><p>ToggleMail is free and open source &mdash; a family project by Toggle Minds.</p>'), { seen: true }),
      msg(p('Library Updates', 'news@example.org'), 'Three new books on your wishlist are in', 1 * d, '<p>Good news: three books on your wishlist are now available to borrow.</p>', { seen: true }),
      msg(p('Arun Prakash', 'arun@example.com'), 'Re: Cricket on Sunday?', 1 * d + 3 * h, '<p>Count me in! I will bring the stumps.</p><blockquote>Anyone up for cricket on Sunday at 7?</blockquote>', { seen: true, answered: true }),
      msg(p('Electricity Board', 'billing@example.net'), 'Your bill for November is ready', 2 * d, card('November bill', '<p>Amount due: <b>&#8377; 1,240</b></p><p>Due by 30 November.</p>', '#1f6feb'), { seen: true }),
      msg(p('Priya Nair', 'priya@example.com'), 'Recipe you asked for', 3 * d, '<p>Here is the recipe for the lemon rice. Enjoy!</p>', { seen: true, flagged: true }),
      msg(p('Kavya Shah', 'kavya@example.com'), 'Volunteer list for the community clean-up', 4 * d, '<p>Thanks for signing up! The list is attached.</p>', { seen: true, attachments: [{ index: 0, name: 'volunteers.xlsx', mime: 'application/vnd.ms-excel', size: 24000 }] }),
    ],
    'home|Scheduled': [msg(me, 'Happy birthday, Amma!', -14 * h, '<p>Happy birthday, Amma! Lots of love.</p>', { to: [p('Amma', 'amma@example.com')], seen: true, send_at: now + 14 * h })],
    'home|Snoozed': [msg(p('Insurance Desk', 'renewals@example.org'), 'Policy renewal reminder', 6 * d, '<p>Your policy renews next month.</p>', { seen: true, snoozed_until: now + 2 * d })],
    'gmail|INBOX': [
      msg(p('Online Store', 'orders@example.com'), 'Your order has shipped', 40 * 60, card('On its way!', '<p>Your order #4821 has shipped and will arrive on Tuesday.</p>', '#e37400')),
      msg(p('Deepa', 'deepa@example.com'), 'Lunch next week?', 3 * h, '<p>Free on Wednesday?</p>'),
      msg(p('Photo Backup', 'backup@example.com'), '128 photos backed up', 1 * d, '<p>All done.</p>', { seen: true }),
    ],
    'work|INBOX': [
      msg(p('Project Team', 'team@example.org'), 'Sprint review moved to Thursday', 1 * h, '<p>The sprint review is now on Thursday at 3 pm.</p>'),
      msg(p('Rahul Verma', 'rahul@example.org'), 'Slides for tomorrow', 4 * h, '<p>Draft slides attached.</p>', { attachments: [{ index: 0, name: 'review.pptx', mime: 'application/vnd.ms-powerpoint', size: 3400000 }] }),
    ],
    'icloud|INBOX': [msg(p('Apple', 'no-reply@example.com'), 'Your storage is almost full', 2 * d, '<p>Upgrade or free up space.</p>', { seen: true })],
  };
  const list = (a, f) => mail[`${a}|${f}`] || [];
  const all = () => Object.values(mail).flat();
  const find = (u) => all().find((m) => m.uid === u);
  const summary = ({ body, attachments, ...m }) => m;

  const handlers = {
    list_accounts: () => accounts,
    providers: () => [],
    guess_settings: () => ({ provider: '', protocol: 'imap', imap_host: '', imap_port: 993, incoming_security: 'tls', smtp_host: '', smtp_port: 587, smtp_security: 'starttls', accept_invalid_certs: false, pop3_available: true, supported: true, note: '' }),
    folders: ({ account }) => folderSets[account] || folders([]),
    unread: ({ account, folder }) => list(account, folder).filter((m) => !m.seen).length,
    messages: ({ account, folder, before, limit }) => {
      const items = list(account, folder).map(summary);
      return { items: items.slice(before, before + limit), total: items.length };
    },
    starred: ({ account }) => ({ folder: 'INBOX', items: list(account, 'INBOX').filter((m) => m.flagged).map(summary) }),
    search: ({ account, folder, query }) => list(account, folder).filter((m) => (m.subject + m.from.name).toLowerCase().includes(query.toLowerCase())).map(summary),
    open_message: ({ uid: u, markRead }) => {
      const m = find(u);
      if (markRead !== false) m.seen = true;
      return { ...summary(m), cc: [], reply_to: [], message_id: `<demo-${u}@toggleminds.com>`, references: '', html: m.body, text: '', has_remote_images: false, attachments: m.attachments || [] };
    },
    set_flag: ({ uid: u, flag, on }) => { const m = find(u); if (flag === 'seen') m.seen = on; if (flag === 'flagged') m.flagged = on; },
    run_due: () => ({ sent: 0, woke: 0 }),
    password_plan: () => ({ in_app: true, url: '' }),
  };
  const ok = () => undefined;
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        await new Promise((r) => setTimeout(r, 60));
        if (cmd.startsWith('plugin:opener')) return window.open(args.url, '_blank');
        const fn = handlers[cmd];
        if (fn) return fn(args);
        if (['send', 'schedule_send', 'move_message', 'delete_message', 'snooze', 'save_account', 'create_folder'].includes(cmd)) {
          throw new Error('This is a demo: download ToggleMail to use it with your own email.');
        }
        return ok();
      },
    },
  };

  // After the app has loaded: pick a folder, open a message or a dialog, for screenshots.
  window.addEventListener('load', () => setTimeout(async () => {
    const folder = q.get('folder');
    if (folder) await selectFolder(q.get('account') || 'home', folder === 'starred' ? STARRED : folder);
    if (q.get('open')) await openMessage(+q.get('open'));
    if (q.get('compose')) openCompose({ to: 'Ravi Kumar <ravi@example.com>', subject: 'Re: Weekend trip: train tickets booked',
      body: '<p>Thanks Ravi! See you all at the station at 5:45.</p><p>Asha</p>' });
    if (q.get('settings')) openSettings(q.get('settings'));
    document.documentElement.dataset.ready = '1';
  }, 400));
})();
