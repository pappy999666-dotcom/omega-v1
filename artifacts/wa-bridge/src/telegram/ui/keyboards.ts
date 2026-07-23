// ============================================================
// WA-Bridge — Telegram Inline Keyboards
// Telegram Bot API 9.0+ features: copy_text, callback pagination
// ============================================================

import type { InlineKeyboardMarkup } from 'telegraf/types';

// ── Helper ────────────────────────────────────────────────

type IKB = InlineKeyboardMarkup['inline_keyboard'][number][number];
type ButtonStyle = 'primary' | 'success' | 'danger';
type StyledIKB = IKB & { style?: ButtonStyle };

function btn(text: string, callback_data: string, style: ButtonStyle = 'primary'): IKB {
  return { text, callback_data, style } as StyledIKB;
}

function urlBtn(text: string, url: string, style: ButtonStyle = 'primary'): IKB {
  return { text, url, style } as StyledIKB;
}

function copyBtn(text: string, copy_text: string, style: ButtonStyle = 'primary'): IKB {
  // Telegram API 9.0+ copy_text button
  return { text, copy_text: { text: copy_text }, style } as IKB;
}

export function backKeyboard(callback = 'menu:main'): InlineKeyboardMarkup {
  return { inline_keyboard: [[btn('🔙 Back', callback)]] };
}

export function bridgeExitKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[btn('❌ Exit Bridge', 'bridge:exit', 'danger')]] };
}

export function helpKeyboard(): InlineKeyboardMarkup {
  return backKeyboard('menu:main');
}

export function statusKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('🔄 Refresh', 'status:overview', 'success')],
      [btn('🔙 Back', 'menu:main')],
    ],
  };
}

export function stickerMacrosKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('📖 Binding Help', 'help:stickers')],
      [btn('🔙 Back', 'settings:menu')],
    ],
  };
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
  sessions: { id: string; phone: string; label?: string; status: string }[],
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

    return [btn(`${statusIcon} ${s.label || s.phone}`, `session:${s.id}:menu`)];
  });

  // Pagination
  const nav: IKB[] = [];
  if (page > 0) nav.push(btn('◀ Prev', `sessions:list:${page - 1}`));
  if (start + pageSize < sessions.length) nav.push(btn('Next ▶', `sessions:list:${page + 1}`));
  if (nav.length > 0) rows.push(nav);

  rows.push([btn('➕ New Session', 'session:new', 'success'), btn('🔙 Back', 'menu:main')]);

  return { inline_keyboard: rows };
}

export function sessionMenuKeyboard(sessionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('📊 Info', `session:${sessionId}:info`, 'primary'), btn('📋 Groups', `session:${sessionId}:groups`, 'primary')],
      [btn('❄️ Freeze', `session:${sessionId}:freeze`, 'danger'), btn('🔥 Unfreeze', `session:${sessionId}:unfreeze`, 'success')],
      [btn('🔄 Re-Init', `session:${sessionId}:reinit`, 'primary'), btn('🗑 Purge', `session:${sessionId}:purge`, 'danger')],
      [btn('🌉 Bridge', `session:${sessionId}:bridge`, 'primary'), btn('🔙 Back', 'sessions:list')],
    ],
  };
}

export function sessionPairKeyboard(sessionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('📷 QR Code', `pair:qr:${sessionId}`, 'primary'), btn('🔑 Pairing Code', `pair:code:${sessionId}`, 'primary')],
      [btn('❌ Cancel', 'session:new:cancel', 'danger')],
    ],
  };
}

export function sessionWizardKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[btn('❌ Cancel Setup', 'session:new:cancel', 'danger')]],
  };
}

// ── Pairing Code with Copy Button ────────────────────────

export function pairingCodeKeyboard(code: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [copyBtn('📋 Copy Exact Code', code)],
      [btn('🔙 Cancel', 'sessions:list')],
    ],
  };
}

// ── Bucket ────────────────────────────────────────────────

export function bucketMenuKeyboard(filterRunning: boolean): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('📥 Main', 'bucket:view:main'), btn('✅ Active', 'bucket:view:active'), btn('💀 Dead', 'bucket:view:dead')],
      [filterRunning ? btn('⏹ Stop Filter', 'bucket:filter:stop', 'danger') : btn('▶️ Start Filter', 'bucket:filter:start', 'success')],
      [btn('📤 Export TXT', 'bucket:export:txt', 'primary'), btn('📊 Export CSV', 'bucket:export:csv', 'primary'), btn('🌐 Export HTML', 'bucket:export:html', 'primary')],
      [btn('🗑 Purge Dead', 'bucket:purge:dead', 'danger'), btn('🔀 Merge', 'bucket:merge', 'primary')],
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

export function adminPanelKeyboard(paused = false, maintenance = false): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('👥 Users', 'admin:users:0'), btn('🌐 Master Bucket', 'admin:master:bucket')],
      [
        btn('📡 Omni-Bridge', 'admin:omni'),
        paused
          ? btn('▶️ Resume Traffic', 'admin:pause:off', 'success')
          : btn('⏸ Global Pause', 'admin:pause:on', 'danger'),
      ],
      [
        maintenance
          ? btn('✅ End Maintenance', 'admin:maintenance:off', 'success')
          : btn('🔧 Maintenance', 'admin:maintenance:on', 'danger'),
        btn('📊 Platform Stats', 'admin:stats'),
      ],
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
          ? btn('✅ Unban', `admin:unban:${telegramId}`, 'success')
          : btn('🚫 Ban', `admin:ban:${telegramId}`, 'danger'),
        btn('🔍 Inspect', `admin:inspect:${telegramId}`, 'primary'),
      ],
      [btn('🗑 Purge Sessions', `admin:purge_sessions:${telegramId}`, 'danger')],
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
    inline_keyboard: [[btn('✅ Confirm', yesCallback, 'success'), btn('❌ Cancel', noCallback, 'danger')]],
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
