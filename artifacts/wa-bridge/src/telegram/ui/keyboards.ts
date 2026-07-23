// ============================================================
// WA-Bridge — Telegram Inline Keyboards
// Telegram Bot API 9.0+ features: copy_text, callback pagination
// ============================================================

import type { InlineKeyboardMarkup } from 'telegraf/types';

// ── Helper ────────────────────────────────────────────────

type IKB = InlineKeyboardMarkup['inline_keyboard'][number][number];

function btn(text: string, callback_data: string): IKB {
  return { text, callback_data };
}

function urlBtn(text: string, url: string): IKB {
  return { text, url };
}

function copyBtn(text: string, copy_text: string): IKB {
  // Telegram API 9.0+ copy_text button
  return { text, copy_text: { text: copy_text } } as IKB;
}

// ── Main Menu ─────────────────────────────────────────────

export function mainMenuKeyboard(isOwner: boolean): InlineKeyboardMarkup {
  const rows: IKB[][] = [
    [btn('📱 Sessions', 'sessions:list'), btn('🗂 Buckets', 'bucket:status')],
    [btn('📊 Status', 'status:overview'), btn('⚙️ Settings', 'settings:menu')],
    [btn('❓ Help', 'help:main')],
  ];

  if (isOwner) {
    rows.push([btn('👑 Admin Panel', 'admin:panel')]);
  }

  return { inline_keyboard: rows };
}

// ── Sessions ──────────────────────────────────────────────

export function sessionsListKeyboard(
  sessions: { id: string; phone: string; status: string }[],
  page = 0,
  pageSize = 5
): InlineKeyboardMarkup {
  const start = page * pageSize;
  const slice = sessions.slice(start, start + pageSize);

  const rows: IKB[][] = slice.map((s) => {
    const statusIcon = {
      open: '🟢',
      frozen: '🔵',
      error: '🔴',
      connecting: '🟡',
      closed: '⚫',
      banned: '💀',
    }[s.status] ?? '⚪';

    return [btn(`${statusIcon} ${s.phone}`, `session:${s.id}:menu`)];
  });

  // Pagination
  const nav: IKB[] = [];
  if (page > 0) nav.push(btn('◀ Prev', `sessions:list:${page - 1}`));
  if (start + pageSize < sessions.length) nav.push(btn('Next ▶', `sessions:list:${page + 1}`));
  if (nav.length > 0) rows.push(nav);

  rows.push([btn('➕ New Session', 'session:new'), btn('🔙 Back', 'menu:main')]);

  return { inline_keyboard: rows };
}

export function sessionMenuKeyboard(sessionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('📊 Info', `session:${sessionId}:info`), btn('📋 Groups', `session:${sessionId}:groups`)],
      [btn('❄️ Freeze', `session:${sessionId}:freeze`), btn('🔥 Unfreeze', `session:${sessionId}:unfreeze`)],
      [btn('🔄 Re-Init', `session:${sessionId}:reinit`), btn('🗑 Purge', `session:${sessionId}:purge`)],
      [btn('🌉 Bridge', `session:${sessionId}:bridge`), btn('🔙 Back', 'sessions:list')],
    ],
  };
}

export function sessionPairKeyboard(sessionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('📷 QR Code', `pair:qr:${sessionId}`), btn('🔑 Pairing Code', `pair:code:${sessionId}`)],
      [btn('🔙 Back', 'sessions:list')],
    ],
  };
}

// ── Pairing Code with Copy Button ────────────────────────

export function pairingCodeKeyboard(code: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [copyBtn('📋 Copy Code', code)],
      [btn('🔄 New Code', 'pair:refresh'), btn('🔙 Cancel', 'sessions:list')],
    ],
  };
}

// ── Bucket ────────────────────────────────────────────────

export function bucketMenuKeyboard(filterRunning: boolean): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('📥 Main', 'bucket:view:main'), btn('✅ Active', 'bucket:view:active'), btn('💀 Dead', 'bucket:view:dead')],
      [filterRunning ? btn('⏹ Stop Filter', 'bucket:filter:stop') : btn('▶️ Start Filter', 'bucket:filter:start')],
      [btn('📤 Export TXT', 'bucket:export:txt'), btn('📊 Export CSV', 'bucket:export:csv'), btn('🌐 Export HTML', 'bucket:export:html')],
      [btn('🗑 Purge Dead', 'bucket:purge:dead'), btn('🔀 Merge', 'bucket:merge')],
      [btn('🔙 Back', 'menu:main')],
    ],
  };
}

export function bucketViewKeyboard(
  bucket: 'main' | 'active' | 'dead',
  page: number,
  total: number,
  pageSize: number
): InlineKeyboardMarkup {
  const nav: IKB[] = [];
  if (page > 0) nav.push(btn('◀ Prev', `bucket:page:${bucket}:${page - 1}`));
  if ((page + 1) * pageSize < total) nav.push(btn('Next ▶', `bucket:page:${bucket}:${page + 1}`));

  const rows: IKB[][] = [
    ...(nav.length > 0 ? [nav] : []),
    [btn('🔙 Back', 'bucket:status')],
  ];

  return { inline_keyboard: rows };
}

// ── Admin ─────────────────────────────────────────────────

export function adminPanelKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('👥 Users', 'admin:users:0'), btn('🌐 Master Bucket', 'admin:master:bucket')],
      [btn('📡 Omni-Bridge', 'admin:omni'), btn('⏸ Global Pause', 'admin:pause')],
      [btn('🔧 Maintenance', 'admin:maintenance'), btn('📊 Platform Stats', 'admin:stats')],
      [btn('🔙 Back', 'menu:main')],
    ],
  };
}

export function adminUsersKeyboard(
  users: { telegramId: string; username?: string; isBanned: boolean }[],
  page = 0,
  pageSize = 8
): InlineKeyboardMarkup {
  const start = page * pageSize;
  const slice = users.slice(start, start + pageSize);

  const rows: IKB[][] = slice.map((u) => {
    const label = u.isBanned
      ? `🚫 ${u.username ?? u.telegramId}`
      : `✅ ${u.username ?? u.telegramId}`;
    return [btn(label, `admin:user:${u.telegramId}`)];
  });

  const nav: IKB[] = [];
  if (page > 0) nav.push(btn('◀ Prev', `admin:users:${page - 1}`));
  if (start + pageSize < users.length) nav.push(btn('Next ▶', `admin:users:${page + 1}`));
  if (nav.length > 0) rows.push(nav);

  rows.push([btn('🔙 Back', 'admin:panel')]);
  return { inline_keyboard: rows };
}

export function adminUserKeyboard(telegramId: string, isBanned: boolean): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        isBanned
          ? btn('✅ Unban', `admin:unban:${telegramId}`)
          : btn('🚫 Ban', `admin:ban:${telegramId}`),
        btn('🔍 Inspect', `admin:inspect:${telegramId}`),
      ],
      [btn('🗑 Purge Sessions', `admin:purge_sessions:${telegramId}`)],
      [btn('🔙 Back', 'admin:users:0')],
    ],
  };
}

// ── Confirm Dialog ────────────────────────────────────────

export function confirmKeyboard(
  yesCallback: string,
  noCallback: string
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[btn('✅ Confirm', yesCallback), btn('❌ Cancel', noCallback)]],
  };
}

// ── Settings ──────────────────────────────────────────────

export function settingsKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('🔤 Change Prefix', 'settings:prefix'), btn('🎭 Sticker Macros', 'settings:macros')],
      [btn('🔙 Back', 'menu:main')],
    ],
  };
}
