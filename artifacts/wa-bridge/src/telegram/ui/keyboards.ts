// ============================================================
// WA-Bridge — Telegram Inline Keyboards
// Telegram Bot API 9.0+ features: copy_text, callback pagination
// ============================================================

import type { InlineKeyboardMarkup } from 'telegraf/types';

// ── Helper ────────────────────────────────────────────────

type IKB = InlineKeyboardMarkup['inline_keyboard'][number][number];
type ButtonStyle = 'primary' | 'success' | 'danger';
type StyledIKB = IKB & { style?: ButtonStyle };

export function btn(text: string, callback_data: string, style: ButtonStyle = 'primary'): IKB {
  return { text, callback_data, style } as StyledIKB;
}

export function urlBtn(text: string, url: string, style: ButtonStyle = 'primary'): IKB {
  return { text, url, style } as StyledIKB;
}

export function copyBtn(text: string, copy_text: string, style: ButtonStyle = 'primary'): IKB {
  // Telegram API 9.0+ copy_text button
  return { text, copy_text: { text: copy_text }, style } as unknown as IKB;
}

export function backKeyboard(callback = 'menu:main'): InlineKeyboardMarkup {
  return { inline_keyboard: [[btn('🔙 Back', callback, 'primary')]] };
}

export function bridgeExitKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[btn('❌ Exit Bridge', 'bridge:exit', 'danger')]] };
}

export function groupBridgeActiveKeyboard(sessionId: string, gcKey: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('❌ Exit Group Bridge', `gcbridge:${sessionId}:${gcKey}:exit`, 'danger')],
    ],
  };
}

export function helpKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('◈ Group Moderation', 'help:cat:groupmod', 'primary'), btn('◈ Anti System', 'help:cat:antisystem', 'primary')],
      [btn('◈ Status Engine', 'help:cat:status', 'primary'), btn('◈ Broadcast', 'help:cat:broadcast', 'primary')],
      [btn('◈ Lifecycle', 'help:cat:lifecycle', 'primary'), btn('◈ Settings', 'help:cat:settings', 'primary')],
      [btn('🔙 Back', 'menu:main', 'primary')],
    ],
  };
}

export function helpCategoryKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('🔙 Back to Commands', 'help:main', 'primary')],
    ],
  };
}

export function statusKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('🔄 Refresh', 'status:overview', 'success')],
      [btn('🔙 Back', 'menu:main', 'primary')],
    ],
  };
}

export function stickerMacrosKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('📖 Binding Help', 'help:stickers', 'primary')],
      [btn('🔙 Back', 'settings:menu', 'primary')],
    ],
  };
}

// ── Main Menu ─────────────────────────────────────────────

export function mainMenuKeyboard(isOwner: boolean): InlineKeyboardMarkup {
  const rows: IKB[][] = [
    [btn('Pair Number', 'session:new', 'success'), btn('Sessions', 'sessions:list', 'primary')],
    [btn('Validator Hub', 'bucket:status', 'primary'), btn('Global Bridge', 'bridge:global', 'primary')],
    [btn('Sleep Mode', 'sleep:menu', 'primary'), btn('Settings', 'settings:menu', 'primary')],
    [btn('Support', 'support:menu', 'primary'), btn('Help', 'help:main', 'primary')],
    [btn('💡 Send Idea', 'idea:submit', 'success')],
  ];

  if (isOwner) {
    rows.push([btn('👑 Admin Panel', 'admin:panel', 'primary')]);
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
      ACTIVE: '🟢',
      FROZEN: '❄️',
      PAIRING: '🟡',
      PURGED: '🔴',
    }[s.status] ?? '⚪';

    return [btn(`${statusIcon} ${s.label || s.phone}`, `session:${s.id}:menu`, 'primary')];
  });

  // Pagination
  const nav: IKB[] = [];
  if (page > 0) nav.push(btn('◀ Prev', `sessions:list:${page - 1}`, 'primary'));
  if (start + pageSize < sessions.length) nav.push(btn('Next ▶', `sessions:list:${page + 1}`, 'primary'));
  if (nav.length > 0) rows.push(nav);

  rows.push([btn('➕ New Session', 'session:new', 'success'), btn('🔙 Back', 'menu:main', 'primary')]);

  return { inline_keyboard: rows };
}

export function gameApiKeyboard(sessionId: string, configured: boolean): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn(configured ? '✅ Current Status' : '📊 Current Status', `session:${sessionId}:gameapi`, 'primary')],
      [btn(configured ? '🔄 Change API Key' : '🔑 Setup API Key', `session:${sessionId}:gameapi:setup`, 'success')],
      [btn('🧪 Test API', `session:${sessionId}:gameapi:test`, 'primary'), btn('📚 Tutorial', `session:${sessionId}:gameapi:tutorial`, 'primary')],
      [btn('🔙 Back', `session:${sessionId}:menu`, 'primary')],
    ],
  };
}

export function sessionMenuKeyboard(sessionId: string, status?: string): InlineKeyboardMarkup {
  const isFrozen = status === 'FROZEN';
  const isActive = status === 'ACTIVE';
  
  return {
    inline_keyboard: [
      [btn('📊 Info', `session:${sessionId}:info`, 'primary'), btn('📋 Groups', `session:${sessionId}:groups`, 'primary')],
      isFrozen
        ? [btn('🔥 Resume', `session:${sessionId}:unfreeze`, 'success')]
        : [btn('❄️ Freeze', `session:${sessionId}:freeze`, 'danger'), btn('🔄 Force Reconnect', `session:${sessionId}:reinit`, 'primary')],
      [btn('🗑 Purge', `session:${sessionId}:purge`, 'danger'), btn('🔄 Refresh Status', `session:${sessionId}:info`, 'primary')],
      [btn('🔗 Link Collection', `session:${sessionId}:collect`, 'primary'), btn('🚪 Join Manager', `session:${sessionId}:joinmgr`, 'primary')],
      [btn('🖼 Set PFP', `session:${sessionId}:pfp:set`, 'primary'), btn('📸 Get PFP', `session:${sessionId}:pfp:get`, 'primary'), btn('🗑 Remove PFP', `session:${sessionId}:pfp:remove`, 'danger')],
      [btn('✏️ Set Name', `session:${sessionId}:setname`, 'primary'), btn('📝 Set Bio', `session:${sessionId}:setbio`, 'primary')],
      [btn('🔍 WA Info', `session:${sessionId}:wainfo`, 'primary'), btn('👥 Create GC', `session:${sessionId}:creategc`, 'success')],
      [btn('🚪 Leave GC', `session:${sessionId}:leavegc`, 'danger'), btn('📋 My Groups', `session:${sessionId}:mygroups`, 'primary')],
      [btn('🛡 Sudo List', `session:${sessionId}:sudo`, 'primary'), btn('🌉 Bridge', `session:${sessionId}:bridge`, 'primary')],
      [btn('📅 Auto-Promote', `session:${sessionId}:autopromo`, 'primary')],
      [btn('🎮 Game API', `session:${sessionId}:gameapi`, 'primary')],
      [btn('🔙 Back', 'sessions:list', 'primary')],
    ],
  };
}

export function linkCollectionKeyboard(sessionId: string, enabled: boolean): InlineKeyboardMarkup {
  return { inline_keyboard: [
    [enabled
      ? btn('Disable Collection', `session:${sessionId}:collect:off`, 'danger')
      : btn('Enable Collection', `session:${sessionId}:collect:on`, 'success')],
    [btn('Back', `session:${sessionId}:menu`, 'primary')],
  ] };
}

export function joinManagerKeyboard(sessionId: string, status: string): InlineKeyboardMarkup {
  const controls: IKB[] = [];
  if (status === 'running') controls.push(btn('⏸ Pause', `session:${sessionId}:join:pause`, 'danger'));
  else controls.push(btn(status === 'paused' ? '▶️ Resume' : '▶️ Start', `session:${sessionId}:join:start`, 'success'));
  if (status === 'running' || status === 'paused') controls.push(btn('⏹ Stop', `session:${sessionId}:join:stop`, 'danger'));
  // When running, Back is the only navigation — all other nav is disabled to prevent re-render loops
  const navRow = status === 'running'
    ? [btn('🔙 Back (keeps running)', `session:${sessionId}:menu`, 'primary')]
    : [
        btn('🔢 Set Join Limit', `session:${sessionId}:join:setlimit`, 'primary'),
        btn('⏱ Set Delay', `session:${sessionId}:join:setdelay`, 'primary'),
      ];
  const rows: IKB[][] = [controls];
  if (status !== 'running') rows.push(navRow);
  else rows.push(navRow);
  rows.push([btn('🔄 Refresh', `session:${sessionId}:joinmgr`, 'primary')]);
  if (status !== 'running') rows.push([btn('🔙 Back', `session:${sessionId}:menu`, 'primary')]);
  return { inline_keyboard: rows };
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
      [btn('🔙 Cancel', 'sessions:list', 'danger')],
    ],
  };
}

// ── Bucket ────────────────────────────────────────────────

export function bucketMenuKeyboard(filterRunning: boolean): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('📥 Main', 'bucket:view:main'), btn('✅ Active', 'bucket:view:active'), btn('💀 Dead', 'bucket:view:dead')],
      [filterRunning ? btn('⏹ Stop Filter', 'bucket:filter:stop', 'danger') : btn('▶️ Start Filter', 'bucket:filter:start', 'success'), btn('🌐 HTTP Validate', 'bucket:filter:http', 'primary')],
      [btn('📤 Export TXT', 'bucket:export:txt', 'primary'), btn('📊 Export CSV', 'bucket:export:csv', 'primary'), btn('🌐 Export HTML', 'bucket:export:html', 'primary')],
      [btn('🗑 Purge Dead', 'bucket:purge:dead', 'danger'), btn('🔀 Merge', 'bucket:merge', 'primary')],
      [btn('🔙 Back', 'menu:main', 'primary')],
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
  if (page > 0) nav.push(btn('◀ Prev', `bucket:page:${bucket}:${page - 1}`, 'primary'));
  if ((page + 1) * pageSize < total) nav.push(btn('Next ▶', `bucket:page:${bucket}:${page + 1}`, 'primary'));

  const rows: IKB[][] = [
    ...(nav.length > 0 ? [nav] : []),
    [btn('🔙 Back', 'bucket:status', 'primary')],
  ];

  return { inline_keyboard: rows };
}

// ── Admin ─────────────────────────────────────────────────

export function adminPanelKeyboard(paused = false, maintenance = false): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('👥 Users', 'admin:users:0', 'primary'), btn('🌐 Master Bucket', 'admin:master:bucket', 'primary')],
      [btn('🔐 Force Join', 'admin:forcejoin', 'primary'), btn('📣 Broadcast', 'admin:broadcast', 'primary')],
      [
        btn('📡 Omni-Bridge', 'admin:omni', 'primary'),
        paused
          ? btn('▶️ Resume Traffic', 'admin:pause:off', 'success')
          : btn('⏸ Global Pause', 'admin:pause:on', 'danger'),
      ],
      [
        maintenance
          ? btn('✅ End Maintenance', 'admin:maintenance:off', 'success')
          : btn('🔧 Maintenance', 'admin:maintenance:on', 'danger'),
        btn('📊 Platform Stats', 'admin:stats', 'primary'),
      ],
      [btn('📋 All Sessions', 'admin:allsessions', 'primary'), btn('🔗 Menu URL', 'admin:menuurl', 'primary')],
      [btn('📢 Release Settings', 'admin:release:menu', 'primary')],
      [btn('📅 Auto-Promote (All)', 'admin:autopromo', 'primary'), btn('🔄 Update Bot', 'admin:update', 'success')],
      // Omni Owner is the BOT-WIDE platform layer — managed only here.
      // Global Sudo is per-Telegram-user and lives in each user's Settings hub.
      [btn('🛡 Omni Owner (Bot-wide)', 'admin:omniowner', 'primary')],
      [btn('💡 Idea Inbox', 'admin:ideas:0', 'primary'), btn('📋 Logs', 'admin:logs', 'primary')],
      [btn('🎬 Tutorial Content', 'admin:tutorials', 'primary')],
      [btn('🔙 Back', 'menu:main', 'primary')],
    ],
  };
}

export function adminUsersKeyboard(
  users: { telegramId: string; username?: string; isBanned: boolean; activeSessions?: number }[],
  page = 0,
  pageSize = 8
): InlineKeyboardMarkup {
  const start = page * pageSize;
  const slice = users.slice(start, start + pageSize);

  const rows: IKB[][] = slice.map((u) => {
    const status = u.isBanned ? '🚫' : '✅';
    const sessions = u.activeSessions ? ` [🟢${u.activeSessions}]` : '';
    const label = `${status} ${u.username ?? u.telegramId}${sessions}`;
    return [btn(label, `admin:user:${u.telegramId}`, u.isBanned ? 'danger' : 'primary')];
  });

  const nav: IKB[] = [];
  if (page > 0) nav.push(btn('◀ Prev', `admin:users:${page - 1}`, 'primary'));
  if (start + pageSize < users.length) nav.push(btn('Next ▶', `admin:users:${page + 1}`, 'primary'));
  if (nav.length > 0) rows.push(nav);

  rows.push([btn('🔙 Back', 'admin:panel', 'primary')]);
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
      [btn('🔙 Back', 'admin:users:0', 'primary')],
    ],
  };
}

export function adminIdeasKeyboard(
  ideas: { id: string; platform: string; username?: string; status: string }[],
  page = 0,
  pageSize = 8
): InlineKeyboardMarkup {
  const start = page * pageSize;
  const slice = ideas.slice(start, start + pageSize);

  const rows: IKB[][] = slice.map((i) => {
    const statusIcon = { open: '📩', read: '📖', completed: '✅' }[i.status] ?? '⚪';
    const label = `${statusIcon} ${i.platform === 'telegram' ? 'TG' : 'WA'}: ${i.username || 'User'}`;
    return [btn(label, `admin:idea:${i.id}`, 'primary')];
  });

  const nav: IKB[] = [];
  if (page > 0) nav.push(btn('◀ Prev', `admin:ideas:${page - 1}`, 'primary'));
  if (start + pageSize < ideas.length) nav.push(btn('Next ▶', `admin:ideas:${page + 1}`, 'primary'));
  if (nav.length > 0) rows.push(nav);

  rows.push([btn('🔙 Back', 'admin:panel', 'primary')]);
  return { inline_keyboard: rows };
}

export function adminIdeaViewKeyboard(ideaId: string, status: string): InlineKeyboardMarkup {
  const rows: IKB[][] = [
    [btn('📩 Reply', `admin:idea:${ideaId}:reply`, 'success')],
  ];

  if (status !== 'completed') {
    rows.push([btn('✅ Mark Completed', `admin:idea:${ideaId}:complete`, 'primary')]);
  }
  
  rows.push([btn('🗑 Delete', `admin:idea:${ideaId}:delete`, 'danger')]);
  rows.push([btn('🔙 Back', 'admin:ideas:0', 'primary')]);

  return { inline_keyboard: rows };
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

export function settingsKeyboard(
  config?: { notificationsEnabled?: boolean; defaultLinkCollection?: boolean; autoValidationEnabled?: boolean }
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('Change Prefix', 'settings:prefix', 'primary'), btn('Sticker Macros', 'settings:macros', 'primary')],
      // Global Sudo is a per-Telegram-user account setting — each user manages
      // their own list from their main hub (applies to every session they pair).
      [btn('👑 Global Sudo', 'settings:globalsudo', 'primary')],
      [btn(`Notifications: ${config?.notificationsEnabled === false ? 'Off' : 'On'}`, 'settings:notifications', 'primary')],
      [btn(`Default Collection: ${config?.defaultLinkCollection ? 'On' : 'Off'}`, 'settings:collection', 'primary')],
      [btn(`Auto Validation: ${config?.autoValidationEnabled ? 'On' : 'Off'}`, 'settings:validation', 'primary')],
      [btn('Back', 'menu:main', 'primary')],
    ],
  };
}

export function sleepKeyboard(sleeping: boolean): InlineKeyboardMarkup {
  return { inline_keyboard: [
    [sleeping ? btn('Resume All Sessions', 'sleep:off', 'success') : btn('Sleep All Sessions', 'sleep:on', 'danger')],
    [btn('Back', 'menu:main', 'primary')],
  ] };
}

export function supportKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[btn('Start Support Message', 'support:start', 'success')], [btn('Back', 'menu:main', 'primary')]] };
}

// ── Global Menu URL Manager ──────────────────────────────

import type { MenuButton } from '../../types/index.js';

export function permissionPanelKeyboard(
  kind: 'globalsudo' | 'omniowner',
  numbers: string[],
  backTarget = 'admin:panel'
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [btn('➕ Add Number', `${kind === 'globalsudo' ? 'settings' : 'admin'}:${kind}:add`, 'success'), btn('➖ Remove Number', `${kind === 'globalsudo' ? 'settings' : 'admin'}:${kind}:rm`, 'danger')],
      [btn('🔙 Back', backTarget, 'primary')],
    ],
  };
}

export function adminMenuUrlManagerKeyboard(buttons: MenuButton[]): InlineKeyboardMarkup {
  const rows: IKB[][] = buttons.map((b) => {
    const statusIcon = b.enabled ? '✅' : '❌';
    return [
      btn(`${statusIcon} ${b.name}`, `admin:menuurl:edit:${b.id}`, 'primary'),
      btn('⬆️', `admin:menuurl:up:${b.id}`, 'primary'),
      btn('⬇️', `admin:menuurl:down:${b.id}`, 'primary'),
    ];
  });

  rows.push([btn('➕ Add Button', 'admin:menuurl:add', 'success')]);
  rows.push([btn('🔙 Back', 'admin:panel', 'primary')]);

  return { inline_keyboard: rows };
}

export function adminMenuUrlEditKeyboard(buttonId: string, enabled: boolean): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        enabled
          ? btn('❌ Disable', `admin:menuurl:toggle:${buttonId}`, 'danger')
          : btn('✅ Enable', `admin:menuurl:toggle:${buttonId}`, 'success'),
        btn('🗑 Delete', `admin:menuurl:delete:${buttonId}`, 'danger'),
      ],
      [btn('✏️ Rename', `admin:menuurl:rename:${buttonId}`, 'primary'), btn('🔗 Change URL', `admin:menuurl:changeurl:${buttonId}`, 'primary')],
      [btn('🔙 Back', 'admin:menuurl:manage', 'primary')],
    ],
  };
}
