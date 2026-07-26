// ── State ─────────────────────────────────────────────────
const app = document.getElementById('app');
let state = null, evtSrc = null, feedItems = [];

// ── API ───────────────────────────────────────────────────
async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(path, {
    headers: isForm ? {} : { 'content-type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(j.error || res.statusText);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// ── Toast ─────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast-el');
  if (!el) return;
  el.textContent = (type === 'ok' ? '✓ ' : type === 'err' ? '✕ ' : '⚠ ') + msg;
  el.className = `toast ${type} show`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Canvas BG ─────────────────────────────────────────────
(function () {
  const c = document.getElementById('bg');
  if (!c) return;
  const ctx = c.getContext('2d');
  let W, H, pts = [];
  const resize = () => { W = c.width = innerWidth; H = c.height = innerHeight; };
  resize(); addEventListener('resize', resize);
  for (let i = 0; i < 60; i++) pts.push({
    x: Math.random() * innerWidth, y: Math.random() * innerHeight,
    r: Math.random() * 1.2 + .2, vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25,
    a: Math.random() * .5 + .1, c: Math.random() > .5 ? '155,109,255' : Math.random() > .5 ? '255,106,176' : '106,180,255'
  });
  (function draw() {
    ctx.clearRect(0, 0, W, H);
    pts.forEach(p => {
      p.x = (p.x + p.vx + W) % W; p.y = (p.y + p.vy + H) % H;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.c},${p.a})`; ctx.fill();
    });
    requestAnimationFrame(draw);
  })();
})();

// ── Audio ─────────────────────────────────────────────────
(function () {
  const btn = document.getElementById('mute-btn');
  const tracks = ['/sounds/ambient1.mp3', '/sounds/ambient2.mp3', '/sounds/ambient3.mp3'];
  let idx = 0, audio = null, muted = localStorage.getItem('omega_muted_v2') === '1';
  const upd = () => btn && (btn.textContent = muted ? '🔇' : '🔊');
  upd();
  const play = () => {
    if (muted) return;
    audio = new Audio(tracks[idx++ % tracks.length]);
    audio.volume = .15; audio.onended = play;
    audio.play().catch(() => {});
  };
  const start = () => { if (!audio && !muted) play(); document.removeEventListener('click', start); document.removeEventListener('touchstart', start); };
  document.addEventListener('click', start); document.addEventListener('touchstart', start);
  if (btn) btn.onclick = e => {
    e.stopPropagation(); muted = !muted;
    localStorage.setItem('omega_muted_v2', muted ? '1' : '0'); upd();
    if (muted && audio) { audio.pause(); audio = null; } else play();
  };
})();

// ── Clock ─────────────────────────────────────────────────
function startClock(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const tick = () => { el.textContent = new Date().toLocaleTimeString(); };
  tick(); return setInterval(tick, 1000);
}

// ── Live strip ────────────────────────────────────────────
function setLive(msg, type = 'info') {
  feedItems.unshift({ msg, type, time: new Date().toLocaleTimeString() });
  if (feedItems.length > 50) feedItems.pop();
  const strip = document.getElementById('live-strip');
  if (strip) strip.querySelector('.live-text').textContent = msg;
  const feed = document.getElementById('feed-list');
  if (feed) renderFeed(feed);
}

function renderFeed(el) {
  el.innerHTML = feedItems.slice(0, 20).map(f => `
    <div class="feed-item">
      <div class="feed-dot ${f.type}"></div>
      <div class="feed-text">${f.msg}</div>
      <div class="feed-time">${f.time}</div>
    </div>`).join('') || '<div class="empty" style="padding:20px"><div class="empty-icon">📡</div><div class="muted">No activity yet</div></div>';
}

// ── Auth ──────────────────────────────────────────────────
function showAuth() {
  app.innerHTML = `
<div class="hero">
  <div class="hero-glow"></div>
  <div class="hero-brand">Ω OMEGA</div>
  <div class="hero-sub">Premium WhatsApp automation operating system</div>
  <div class="auth-card anim-scale">
    <h2 style="font-size:18px;font-weight:800;margin-bottom:4px">Welcome back</h2>
    <p class="muted" style="margin-bottom:20px">Sign in to your workspace</p>
    <input id="au" placeholder="Username" autocomplete="username">
    <input id="ap" type="password" placeholder="Password" autocomplete="current-password">
    <button class="btn-pri" id="btn-login" style="width:100%;margin-top:4px">Sign In</button>
    <div class="divider">or</div>
    <button class="btn-sec" id="btn-reg" style="width:100%">Create Account</button>
    <p id="auth-err" class="err-text mt8" style="font-size:12px;text-align:center"></p>
  </div>
</div>`;
  const err = () => document.getElementById('auth-err');
  const doAuth = async ep => {
    err().textContent = '';
    const btn = document.getElementById('btn-' + (ep === 'login' ? 'login' : 'reg'));
    btn.disabled = true; btn.textContent = '⏳';
    try {
      await api('/api/auth/' + ep, { method: 'POST', body: JSON.stringify({ username: document.getElementById('au').value.trim(), password: document.getElementById('ap').value }) });
      initDash();
    } catch (e) { err().textContent = e.message; btn.disabled = false; btn.textContent = ep === 'login' ? 'Sign In' : 'Create Account'; }
  };
  document.getElementById('btn-login').onclick = () => doAuth('login');
  document.getElementById('btn-reg').onclick = () => doAuth('register');
  document.getElementById('ap').onkeydown = e => e.key === 'Enter' && doAuth('login');
}

// ── Nav ───────────────────────────────────────────────────
const NAV = [
  { id: 'home',      icon: '⌂',  label: 'Overview' },
  { id: 'sessions',  icon: '📱', label: 'Sessions' },
  { id: 'pair',      icon: '🔗', label: 'Pair' },
  { id: 'buckets',   icon: '🪣', label: 'Buckets' },
  { id: 'validator', icon: '✅', label: 'Validator' },
  { id: 'outreach',  icon: '📡', label: 'Outreach' },
  { id: 'status',    icon: '🎨', label: 'Status' },
  { id: 'settings',  icon: '⚙️', label: 'Settings' },
];
let activeTab = 'home', clockTimer = null;

function renderShell() {
  const online = (state?.activeSockets || []).length;
  const user = state?.config?.telegramId || 'User';
  const initials = String(user).slice(0, 2).toUpperCase();
  app.innerHTML = `
<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-logo">Ω OMEGA</div>
      <div class="brand-sub">WA-Bridge OS</div>
    </div>
    <nav id="snav">${NAV.map(n => `
      <button class="nav-item${activeTab===n.id?' active':''}" data-tab="${n.id}">
        <span class="icon">${n.icon}</span>${n.label}
        ${n.id==='sessions'&&online>0?`<span class="nav-badge">${online}</span>`:''}
      </button>`).join('')}
    </nav>
    <div class="sidebar-footer">
      <div class="user-chip">
        <div class="user-avatar">${initials}</div>
        <div class="user-name">${user}</div>
        <div class="user-status"></div>
      </div>
      <button class="btn-ghost" style="width:100%;font-size:12px" id="btn-logout">🚪 Sign Out</button>
    </div>
  </aside>
  <main class="main" id="main"></main>
</div>
<nav class="bnav">
  <div class="bnav-inner">${NAV.slice(0,5).map(n=>`
    <button class="bnav-item${activeTab===n.id?' active':''}" data-tab="${n.id}">
      <span class="icon">${n.icon}</span>${n.label}
    </button>`).join('')}
  </div>
</nav>
<div id="live-strip" class="live-strip">
  <div class="live-dot"></div>
  <span class="live-text">System ready</span>
</div>`;

  document.getElementById('btn-logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    if (evtSrc) { evtSrc.close(); evtSrc = null; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    showAuth();
  };
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  drawTab(activeTab);
}

function switchTab(id) {
  activeTab = id;
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  drawTab(id);
}

function drawTab(id) {
  const el = document.getElementById('main');
  if (!el) return;
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  el.innerHTML = (TABS[id] || (() => '<div class="empty"><div class="empty-icon">🚧</div><div class="empty-title">Coming soon</div></div>'))();
  el.scrollTop = 0;
  if (WIRE[id]) WIRE[id]();
  clockTimer = startClock('hdr-clock');
}

// ── SSE ───────────────────────────────────────────────────
function connectSSE() {
  if (evtSrc) evtSrc.close();
  evtSrc = new EventSource('/api/events');
  evtSrc.onmessage = async e => {
    try {
      const d = JSON.parse(e.data);
      if (d.snapshot) { state = d.snapshot; drawTab(activeTab); }
      else if (d.message) { setLive(d.message); }
      else { state = await api('/api/dashboard'); drawTab(activeTab); }
    } catch {}
  };
  evtSrc.onerror = () => setTimeout(connectSSE, 5000);
}

async function initDash() {
  try { state = await api('/api/dashboard'); } catch { return showAuth(); }
  renderShell(); connectSSE();
}

// ── Helpers ───────────────────────────────────────────────
const sessOpts = () => (state?.sessions || []).length
  ? state.sessions.map(s => `<option value="${s.sessionId}">${s.label || s.phone || s.sessionId} — ${s.status}</option>`).join('')
  : '<option value="">No sessions</option>';

const TABS = {}, WIRE = {};

// ── Overview ──────────────────────────────────────────────
TABS.home = () => {
  const s = state || {};
  const sessions = s.sessions || [];
  const online = (s.activeSockets || []).length;
  const frozen = sessions.filter(x => x.status === 'frozen').length;
  const offline = sessions.length - online - frozen;
  const bk = s.buckets || {};
  return `
<div class="anim-up">
  <div class="page-hdr">
    <div>
      <div class="page-title">Good ${hour()} <span class="grad">Omega</span></div>
      <div class="page-sub">System operational · <span id="hdr-clock" class="clock"></span></div>
    </div>
    <div class="btn-row">
      <button class="btn-sec" onclick="switchTab('pair')">＋ New Session</button>
      <button class="btn-pri" onclick="switchTab('outreach')">🚀 Broadcast</button>
    </div>
  </div>

  <div class="stats-row">
    <div class="stat-card"><div class="stat-icon">📱</div><div class="stat-num">${sessions.length}</div><div class="stat-lbl">Sessions</div></div>
    <div class="stat-card"><div class="stat-icon">🟢</div><div class="stat-num" style="color:var(--ok)">${online}</div><div class="stat-lbl">Online</div></div>
    <div class="stat-card"><div class="stat-icon">⚫</div><div class="stat-num" style="color:var(--text3)">${offline}</div><div class="stat-lbl">Offline</div></div>
    <div class="stat-card"><div class="stat-icon">❄️</div><div class="stat-num" style="color:var(--a3)">${frozen}</div><div class="stat-lbl">Frozen</div></div>
    <div class="stat-card"><div class="stat-icon">🪣</div><div class="stat-num">${bk.main||0}</div><div class="stat-lbl">Main Bucket</div></div>
    <div class="stat-card"><div class="stat-icon">✅</div><div class="stat-num" style="color:var(--ok)">${bk.active||0}</div><div class="stat-lbl">Active</div></div>
    <div class="stat-card"><div class="stat-icon">💀</div><div class="stat-num" style="color:var(--err)">${bk.dead||0}</div><div class="stat-lbl">Dead</div></div>
  </div>

  <div class="grid2" style="margin-bottom:14px">
    <div class="card">
      <h2>⚡ Quick Actions</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button class="btn-sec" onclick="switchTab('pair')">🔗 Pair Device</button>
        <button class="btn-sec" onclick="switchTab('buckets')">🪣 Buckets</button>
        <button class="btn-sec" onclick="switchTab('validator')">✅ Validator</button>
        <button class="btn-sec" onclick="switchTab('outreach')">📡 Outreach</button>
        <button class="btn-sec" onclick="switchTab('status')">🎨 Status Design</button>
        <button class="btn-sec" onclick="switchTab('settings')">⚙️ Settings</button>
      </div>
    </div>
    <div class="card">
      <h2>📡 Live Activity</h2>
      <div class="live-feed" id="feed-list"></div>
    </div>
  </div>

  ${sessions.length > 0 ? `
  <div class="card">
    <h2>📱 Sessions Overview</h2>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${sessions.slice(0,4).map(s => miniSessCard(s, state?.activeSockets||[])).join('')}
      ${sessions.length > 4 ? `<button class="btn-ghost" style="width:100%" onclick="switchTab('sessions')">View all ${sessions.length} sessions →</button>` : ''}
    </div>
  </div>` : `
  <div class="card">
    <div class="empty">
      <div class="empty-icon">📱</div>
      <div class="empty-title">No sessions yet</div>
      <div class="empty-sub">Pair your first WhatsApp device to get started</div>
      <button class="btn-pri" onclick="switchTab('pair')" style="margin-top:8px">🔗 Pair Device</button>
    </div>
  </div>`}
</div>`;
};

WIRE.home = () => {
  const feed = document.getElementById('feed-list');
  if (feed) renderFeed(feed);
};

function hour() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

function miniSessCard(s, activeSockets) {
  const isOnline = activeSockets.includes(s.sessionId);
  const status = s.status === 'frozen' ? 'fr' : isOnline ? 'on' : 'off';
  const statusLabel = s.status === 'frozen' ? 'Frozen' : isOnline ? 'Online' : 'Offline';
  return `
<div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--glass);border:1px solid var(--border);border-radius:var(--rs)">
  <div class="sess-avatar" style="width:34px;height:34px;font-size:14px;border-radius:9px">
    ${(s.label||s.phone||'?')[0].toUpperCase()}
    <div class="pulse ${status}"></div>
  </div>
  <div style="flex:1;min-width:0">
    <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.label||s.phone||s.sessionId}</div>
    <div class="muted">${s.sessionId.slice(0,28)}…</div>
  </div>
  <span class="badge badge-${status}">${statusLabel}</span>
  <button class="btn-icon btn-sec" onclick="switchTab('sessions')" title="Manage">⚙️</button>
</div>`;
}

// ── Sessions ──────────────────────────────────────────────
TABS.sessions = () => {
  const sessions = state?.sessions || [];
  const activeSockets = state?.activeSockets || [];
  return `
<div class="anim-up">
  <div class="page-hdr">
    <div><div class="page-title">Sessions</div>
    <div class="page-sub">${sessions.length} configured · ${activeSockets.length} online · <span id="hdr-clock" class="clock"></span></div></div>
    <button class="btn-pri" onclick="switchTab('pair')">＋ Pair New</button>
  </div>
  ${sessions.length === 0 ? `
  <div class="card"><div class="empty">
    <div class="empty-icon">📱</div>
    <div class="empty-title">No sessions</div>
    <div class="empty-sub">Pair your first WhatsApp device to get started</div>
    <button class="btn-pri" onclick="switchTab('pair')" style="margin-top:8px">🔗 Pair Device</button>
  </div></div>` :
  sessions.map(s => {
    const isOnline = activeSockets.includes(s.sessionId);
    const status = s.status === 'frozen' ? 'fr' : isOnline ? 'on' : 'off';
    const statusLabel = s.status === 'frozen' ? 'Frozen' : isOnline ? 'Online' : 'Offline';
    const initial = (s.label || s.phone || s.sessionId)[0].toUpperCase();
    return `
<div class="sess-card anim-up">
  <div class="sess-top">
    <div class="sess-avatar">
      ${initial}
      <div class="pulse ${status}"></div>
    </div>
    <div class="sess-info">
      <div class="sess-name">${s.label || s.phone || s.sessionId}
        <span class="badge badge-${status}" style="margin-left:6px">${statusLabel}</span>
      </div>
      <div class="sess-id">${s.sessionId}</div>
    </div>
  </div>
  <div class="sess-meta-row">
    <div class="sess-meta-item"><div class="sess-meta-lbl">Phone</div><div class="sess-meta-val">${s.phone || '—'}</div></div>
    <div class="sess-meta-item"><div class="sess-meta-lbl">Status</div><div class="sess-meta-val">${s.status || 'unknown'}</div></div>
    <div class="sess-meta-item"><div class="sess-meta-lbl">Bridge</div><div class="sess-meta-val">${s.bridgeMode ? '✓ On' : '✗ Off'}</div></div>
    <div class="sess-meta-item"><div class="sess-meta-lbl">Links</div><div class="sess-meta-val">${s.linksCollected || 0}</div></div>
  </div>
  <div class="health-bar"><div class="health-fill" style="width:${isOnline?'100':s.status==='frozen'?'40':'10'}%"></div></div>
  <div class="sess-actions">
    <button class="btn-sec btn-icon" data-freeze="${s.sessionId}" title="Freeze">❄️</button>
    <button class="btn-sec btn-icon" data-unfreeze="${s.sessionId}" title="Unfreeze">▶️</button>
    <button class="btn-sec btn-icon" data-reinit="${s.sessionId}" title="Reinit">🔄</button>
    <button class="btn-sec btn-icon" data-expand="${s.sessionId}" title="Settings">⚙️</button>
    <button class="btn-dan btn-icon" data-purge="${s.sessionId}" title="Delete">🗑</button>
  </div>
  <div class="sess-expand" id="exp-${s.sessionId}">
    <div class="grid" style="margin-top:4px">
      <div class="card" style="padding:14px">
        <h3>Profile Picture</h3>
        <input type="file" id="pfp-${s.sessionId}" accept="image/*">
        <div class="btn-row">
          <button class="btn-sec" data-pfp="${s.sessionId}">Set HD PFP</button>
          <button class="btn-ghost" data-rmpfp="${s.sessionId}">Remove</button>
        </div>
      </div>
      <div class="card" style="padding:14px">
        <h3>Display Name</h3>
        <input id="name-${s.sessionId}" placeholder="New display name">
        <button class="btn-sec" data-setname="${s.sessionId}">Set Name</button>
      </div>
      <div class="card" style="padding:14px">
        <h3>Bridge & Collection</h3>
        <label><input type="checkbox" id="bridge-${s.sessionId}" ${s.bridgeMode?'checked':''}> Bridge mode</label>
        <label><input type="checkbox" id="lc-${s.sessionId}" ${s.linkCollectionEnabled?'checked':''}> Link collection</label>
        <label><input type="checkbox" id="ap-${s.sessionId}" ${s.autoPromote?'checked':''}> Auto-promote</label>
        <div class="btn-row">
          <button class="btn-sec" data-savesess="${s.sessionId}">Save</button>
        </div>
      </div>
    </div>
  </div>
</div>`; }).join('')}
</div>`;
};

WIRE.sessions = () => {
  const act = (sel, fn) => document.querySelectorAll(sel).forEach(b => b.onclick = () => fn(b));
  act('[data-freeze]', b => api(`/api/sessions/${b.dataset.freeze}/freeze`,{method:'POST'}).then(()=>toast('Frozen ❄️')).catch(e=>toast(e.message,'err')));
  act('[data-unfreeze]', b => api(`/api/sessions/${b.dataset.unfreeze}/unfreeze`,{method:'POST'}).then(()=>toast('Unfrozen ▶️')).catch(e=>toast(e.message,'err')));
  act('[data-reinit]', b => confirm('Reinit session?') && api(`/api/sessions/${b.dataset.reinit}/reinit`,{method:'POST'}).then(()=>toast('Reinit sent')).catch(e=>toast(e.message,'err')));
  act('[data-purge]', b => confirm('Delete this session permanently?') && api(`/api/sessions/${b.dataset.purge}`,{method:'DELETE'}).then(async()=>{toast('Deleted');state=await api('/api/dashboard');drawTab('sessions');}).catch(e=>toast(e.message,'err')));
  act('[data-expand]', b => { const p=document.getElementById(`exp-${b.dataset.expand}`); if(p) p.classList.toggle('open'); });
  act('[data-pfp]', async b => {
    const f = document.getElementById(`pfp-${b.dataset.pfp}`)?.files?.[0];
    if (!f) return toast('Select image first','warn');
    const fd = new FormData(); fd.append('image', f);
    api(`/api/sessions/${b.dataset.pfp}/pfp`,{method:'POST',body:fd}).then(()=>toast('PFP updated ✓')).catch(e=>toast(e.message,'err'));
  });
  act('[data-rmpfp]', b => api(`/api/sessions/${b.dataset.rmpfp}/pfp`,{method:'DELETE'}).then(()=>toast('PFP removed')).catch(e=>toast(e.message,'err')));
  act('[data-setname]', b => {
    const n = document.getElementById(`name-${b.dataset.setname}`)?.value?.trim();
    if (!n) return toast('Enter a name','warn');
    api(`/api/sessions/${b.dataset.setname}/setname`,{method:'POST',body:JSON.stringify({name:n})}).then(()=>toast('Name updated ✓')).catch(e=>toast(e.message,'err'));
  });
  act('[data-savesess]', b => {
    const id = b.dataset.savesess;
    const bridge = document.getElementById(`bridge-${id}`)?.checked;
    const lc = document.getElementById(`lc-${id}`)?.checked;
    const ap = document.getElementById(`ap-${id}`)?.checked;
    Promise.all([
      api(`/api/sessions/${id}/bridge`,{method:'POST',body:JSON.stringify({enabled:bridge})}),
      api(`/api/sessions/${id}/linkcollection`,{method:'POST',body:JSON.stringify({enabled:lc})}),
      api(`/api/sessions/${id}/autopromote`,{method:'POST',body:JSON.stringify({enabled:ap})}),
    ]).then(()=>toast('Saved ✓')).catch(e=>toast(e.message,'err'));
  });
};

// ── Pair ──────────────────────────────────────────────────
let pairPoll = null;
TABS.pair = () => `
<div class="anim-up">
  <div class="page-hdr"><div><div class="page-title">Pair Device</div>
  <div class="page-sub">Connect a new WhatsApp session · <span id="hdr-clock" class="clock"></span></div></div></div>
  <div class="grid2">
    <div class="card">
      <h2>New Session</h2>
      <input id="pl" placeholder="Label (e.g. Main, Bot 1)">
      <input id="pp" placeholder="Phone with country code (+234...)">
      <select id="pm"><option value="qr">QR Code</option><option value="code">Pairing Code</option></select>
      <button class="btn-pri" id="pair-btn" style="width:100%">🔗 Start Pairing</button>
      <div id="pair-out" class="mt12"></div>
    </div>
    <div class="card">
      <h2>Active Sessions</h2>
      ${(state?.sessions||[]).length===0?'<div class="empty" style="padding:20px"><div class="empty-icon">📱</div><div class="muted">No sessions yet</div></div>':
        (state?.sessions||[]).map(s=>`
        <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
          <div class="sess-avatar" style="width:30px;height:30px;font-size:12px;border-radius:8px">${(s.label||s.phone||'?')[0].toUpperCase()}</div>
          <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.label||s.phone||s.sessionId}</div>
          <div class="muted">${s.status}</div></div>
        </div>`).join('')}
    </div>
  </div>
</div>`;

WIRE.pair = () => {
  const btn = document.getElementById('pair-btn');
  const out = document.getElementById('pair-out');
  btn.onclick = async () => {
    const label=document.getElementById('pl').value.trim(), phone=document.getElementById('pp').value.trim(), method=document.getElementById('pm').value;
    if (!phone) return toast('Enter phone number','warn');
    btn.disabled=true; btn.textContent='⏳ Starting…';
    out.innerHTML='<p class="muted">Initialising…</p>';
    try {
      const r = await api('/api/sessions',{method:'POST',body:JSON.stringify({label,phone,method})});
      if (pairPoll) clearInterval(pairPoll);
      pairPoll = setInterval(async()=>{
        try {
          const p = await api(`/api/sessions/${r.sessionId}/pairing`);
          if (p.qr) out.innerHTML=`<div class="qr-wrap"><img src="${p.qr}" alt="QR"></div><p class="muted" style="text-align:center;font-size:12px">Scan with WhatsApp → Linked Devices</p>`;
          else if (p.code) out.innerHTML=`<div class="pair-code">${p.code}</div><p class="muted" style="text-align:center;font-size:12px">Enter in WhatsApp → Linked Devices</p><button class="btn-sec" style="width:100%;margin-top:8px" onclick="navigator.clipboard.writeText('${p.code}').then(()=>toast('Copied!'))">📋 Copy Code</button>`;
          else if (p.error) out.innerHTML=`<p class="err-text">${p.error}</p>`;
          else out.innerHTML='<p class="muted">Waiting for WhatsApp…</p>';
          if (!p.isPairing){clearInterval(pairPoll);pairPoll=null;btn.disabled=false;btn.textContent='🔗 Start Pairing';
            if(!p.error){toast('Session paired! ✓');state=await api('/api/dashboard');drawTab('pair');}}
        } catch {}
      }, 2500);
    } catch(e){out.innerHTML=`<p class="err-text">${e.message}</p>`;btn.disabled=false;btn.textContent='🔗 Start Pairing';}
  };
};

// ── Buckets ───────────────────────────────────────────────
TABS.buckets = () => {
  const bk = state?.buckets||{};
  return `
<div class="anim-up">
  <div class="page-hdr"><div><div class="page-title">Buckets</div>
  <div class="page-sub">Link management · <span id="hdr-clock" class="clock"></span></div></div></div>
  <div class="stats-row" style="grid-template-columns:repeat(3,1fr);max-width:400px;margin-bottom:20px">
    <div class="stat-card"><div class="stat-num">${bk.main||0}</div><div class="stat-lbl">Main</div></div>
    <div class="stat-card"><div class="stat-num" style="color:var(--ok)">${bk.active||0}</div><div class="stat-lbl">Active</div></div>
    <div class="stat-card"><div class="stat-num" style="color:var(--err)">${bk.dead||0}</div><div class="stat-lbl">Dead</div></div>
  </div>
  <div class="grid">
    <div class="card">
      <h2>Add Links</h2>
      <textarea id="bk-links" placeholder="Paste WhatsApp invite links, one per line&#10;https://chat.whatsapp.com/..."></textarea>
      <input id="bk-file" type="file" accept=".txt,.csv,.json">
      <div class="btn-row">
        <button class="btn-pri" id="bk-add">➕ Add Links</button>
        <button class="btn-sec" id="bk-import">📂 Import File</button>
      </div>
      <div id="bk-out" class="mt8"></div>
    </div>
    <div class="card">
      <h2>Export & Manage</h2>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn-sec" id="bk-exp-txt">⬇️ Export Active (.txt)</button>
        <button class="btn-sec" id="bk-exp-csv">⬇️ Export Active (.csv)</button>
        <hr>
        <button class="btn-dan" id="bk-purge-dead">🗑 Purge Dead Bucket</button>
        <button class="btn-dan" id="bk-purge-main">🗑 Purge Main Bucket</button>
      </div>
    </div>
  </div>
</div>`;
};

WIRE.buckets = () => {
  document.getElementById('bk-add').onclick = async()=>{
    const links=document.getElementById('bk-links').value.trim();
    if(!links) return toast('Paste links first','warn');
    try{const r=await api('/api/buckets/links',{method:'POST',body:JSON.stringify({links})});
      document.getElementById('bk-out').innerHTML=`<p class="ok-text">✓ Added: ${r.added} · Dupes skipped: ${r.dupes}</p>`;
      state=await api('/api/dashboard');drawTab('buckets');}catch(e){toast(e.message,'err');}
  };
  document.getElementById('bk-import').onclick = async()=>{
    const f=document.getElementById('bk-file').files?.[0];
    if(!f) return toast('Select a file','warn');
    try{const r=await api('/api/buckets/import',{method:'POST',body:JSON.stringify({text:await f.text(),name:f.name})});
      toast(`Imported ${r.added} links`);state=await api('/api/dashboard');drawTab('buckets');}catch(e){toast(e.message,'err');}
  };
  document.getElementById('bk-exp-txt').onclick=()=>location.href='/api/buckets/active/export/txt';
  document.getElementById('bk-exp-csv').onclick=()=>location.href='/api/buckets/active/export/csv';
  document.getElementById('bk-purge-dead').onclick=()=>confirm('Purge dead bucket?')&&api('/api/buckets/dead',{method:'DELETE'}).then(async()=>{toast('Dead purged');state=await api('/api/dashboard');drawTab('buckets');}).catch(e=>toast(e.message,'err'));
  document.getElementById('bk-purge-main').onclick=()=>confirm('Purge main bucket?')&&api('/api/buckets/main',{method:'DELETE'}).then(async()=>{toast('Main purged');state=await api('/api/dashboard');drawTab('buckets');}).catch(e=>toast(e.message,'err'));
};

// ── Validator ─────────────────────────────────────────────
TABS.validator = () => `
<div class="anim-up">
  <div class="page-hdr"><div><div class="page-title">Validator</div>
  <div class="page-sub">Validate WhatsApp links · <span id="hdr-clock" class="clock"></span></div></div></div>
  <div class="grid">
    <div class="card">
      <h2>Session Validator</h2>
      <p class="muted" style="margin-bottom:12px">Uses a live WhatsApp session to validate links</p>
      <select id="val-sid">${sessOpts()}</select>
      <div class="btn-row">
        <button class="btn-pri" id="val-start">▶️ Start</button>
        <button class="btn-sec" id="val-stop">⏹ Stop</button>
      </div>
    </div>
    <div class="card">
      <h2>HTTP Validator</h2>
      <p class="muted" style="margin-bottom:12px">Sessionless — checks links via HTTP (no WhatsApp needed)</p>
      <textarea id="http-links" placeholder="Paste links to validate, one per line"></textarea>
      <button class="btn-pri" id="http-val">🌐 Validate</button>
      <div id="http-out" class="log" style="display:none;margin-top:10px"></div>
    </div>
  </div>
</div>`;

WIRE.validator = () => {
  document.getElementById('val-start').onclick=async()=>{
    const sid=document.getElementById('val-sid').value;
    if(!sid) return toast('Select a session','warn');
    api('/api/validator/start',{method:'POST',body:JSON.stringify({sessionId:sid})}).then(()=>toast('Validation started')).catch(e=>toast(e.message,'err'));
  };
  document.getElementById('val-stop').onclick=()=>api('/api/validator/stop',{method:'POST'}).then(()=>toast('Stopped')).catch(e=>toast(e.message,'err'));
  document.getElementById('http-val').onclick=async()=>{
    const raw=document.getElementById('http-links').value.trim();
    if(!raw) return toast('Paste links first','warn');
    const out=document.getElementById('http-out');
    out.style.display='block';out.textContent='Checking…';
    try{const r=await api('/api/validator/http',{method:'POST',body:JSON.stringify({links:raw.split(/\s+/).filter(Boolean)})});
      out.textContent=`✓ Active (${r.active?.length||0}):\n${(r.active||[]).join('\n')}\n\n✕ Dead (${r.dead?.length||0}):\n${(r.dead||[]).join('\n')}`;}
    catch(e){out.textContent=e.message;}
  };
};

// ── Outreach ──────────────────────────────────────────────
TABS.outreach = () => `
<div class="anim-up">
  <div class="page-hdr"><div><div class="page-title">Outreach</div>
  <div class="page-sub">Broadcast to groups · <span id="hdr-clock" class="clock"></span></div></div></div>
  <div class="grid">
    <div class="card">
      <h2>Broadcast</h2>
      <select id="out-sid">${sessOpts()}</select>
      <select id="out-type">
        <option value="allstatus">Group Status Broadcast</option>
        <option value="allchat">Group Chat Broadcast</option>
      </select>
      <textarea id="out-msg" placeholder="Message or URL to broadcast to all groups…"></textarea>
      <div class="btn-row">
        <button class="btn-pri" id="out-send">🚀 Launch</button>
        <button class="btn-sec" id="out-stop">⏹ Stop</button>
      </div>
      <div id="out-log" class="log" style="display:none"></div>
    </div>
    <div class="card">
      <h2>Link Preview</h2>
      <p class="muted" style="margin-bottom:12px">Fetch metadata for any URL before broadcasting</p>
      <input id="prev-url" placeholder="https://example.com">
      <button class="btn-sec" id="prev-btn">🔍 Fetch Preview</button>
      <div id="prev-out" class="mt8"></div>
    </div>
  </div>
</div>`;

WIRE.outreach = () => {
  document.getElementById('out-send').onclick=async()=>{
    const sid=document.getElementById('out-sid').value, type=document.getElementById('out-type').value, message=document.getElementById('out-msg').value.trim();
    if(!sid||!message) return toast('Select session and enter message','warn');
    const log=document.getElementById('out-log'); log.style.display='block'; log.textContent='Launching…';
    try{const r=await api('/api/outreach',{method:'POST',body:JSON.stringify({sessionId:sid,type,message})});
      log.textContent=JSON.stringify(r,null,2); toast('Outreach launched 🚀');}
    catch(e){log.textContent=e.message; toast(e.message,'err');}
  };
  document.getElementById('out-stop').onclick=()=>{
    const sid=document.getElementById('out-sid').value;
    api('/api/outreach/stop',{method:'POST',body:JSON.stringify({sessionId:sid})}).then(()=>toast('Stop requested')).catch(e=>toast(e.message,'err'));
  };
  document.getElementById('prev-btn').onclick=async()=>{
    const url=document.getElementById('prev-url').value.trim();
    if(!url) return toast('Enter a URL','warn');
    const out=document.getElementById('prev-out'); out.innerHTML='<p class="muted">Fetching…</p>';
    try{const r=await api('/api/preview',{method:'POST',body:JSON.stringify({url})});
      out.innerHTML=`<div class="card" style="margin:0;padding:14px">
        ${r.thumbnail?`<img src="${r.thumbnail}" style="width:100%;border-radius:8px;margin-bottom:10px;max-height:120px;object-fit:cover">`:'' }
        <div style="font-weight:700;font-size:13px">${r.title||'No title'}</div>
        <div class="muted" style="margin-top:3px">${r.description||''}</div>
        <div class="muted" style="margin-top:6px;font-size:10px">${r.url||url}</div>
      </div>`;}
    catch(e){out.innerHTML=`<p class="err-text">${e.message}</p>`;}
  };
};

// ── Status Design ─────────────────────────────────────────
TABS.status = () => {
  const themes = state?.themes || ['clean','kawaii','cyber','luxury','gothic','girly','guys','dark','prestige','stars','flower','moon','angel','minimal','japanese'];
  return `
<div class="anim-up">
  <div class="page-hdr"><div><div class="page-title">Status Design</div>
  <div class="page-sub">Generate themed WhatsApp status cards · <span id="hdr-clock" class="clock"></span></div></div></div>
  <div class="grid">
    <div class="card">
      <h2>Design Preview</h2>
      <select id="sd-theme">${themes.map(t=>`<option value="${t}">${t}</option>`).join('')}</select>
      <input id="sd-title" placeholder="Title (optional — fetched from URL if blank)">
      <input id="sd-url" placeholder="https://chat.whatsapp.com/...">
      <button class="btn-pri" id="sd-render" style="width:100%">✨ Render Design</button>
      <div id="sd-out" class="log" style="display:none;margin-top:12px;color:var(--text);font-family:var(--font);font-size:13px;line-height:1.6"></div>
      <div id="sd-copy-row" style="display:none" class="btn-row mt8">
        <button class="btn-sec" id="sd-copy">📋 Copy to Clipboard</button>
      </div>
    </div>
    <div class="card">
      <h2>Global Theme</h2>
      <p class="muted" style="margin-bottom:12px">Applied automatically to all .gstatus and .togstatus commands</p>
      <select id="sd-gtheme">${themes.map(t=>`<option value="${t}">${t}</option>`).join('')}</select>
      <button class="btn-pri" id="sd-save" style="width:100%">💾 Save Global Theme</button>
      <div id="sd-theme-out" class="mt8"></div>
      <hr>
      <h3>Theme Reference</h3>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">
        ${themes.map(t=>`<span style="padding:3px 8px;background:var(--glass2);border:1px solid var(--border);border-radius:20px;font-size:10px;cursor:pointer;color:var(--text2)" onclick="document.getElementById('sd-theme').value='${t}'">${t}</span>`).join('')}
      </div>
    </div>
  </div>
</div>`;
};

WIRE.status = () => {
  document.getElementById('sd-render').onclick=async()=>{
    const theme=document.getElementById('sd-theme').value, title=document.getElementById('sd-title').value.trim(), url=document.getElementById('sd-url').value.trim();
    if(!url) return toast('Enter a URL','warn');
    const out=document.getElementById('sd-out'), cr=document.getElementById('sd-copy-row');
    out.style.display='block'; out.textContent='Rendering…';
    try{const r=await api('/api/statusdesign/preview',{method:'POST',body:JSON.stringify({theme,title,url})});
      out.textContent=r.text; cr.style.display='flex';
      document.getElementById('sd-copy').onclick=()=>navigator.clipboard.writeText(r.text).then(()=>toast('Copied! ✓')).catch(()=>toast('Copy failed','err'));}
    catch(e){out.textContent=e.message;}
  };
  document.getElementById('sd-save').onclick=async()=>{
    const theme=document.getElementById('sd-gtheme').value;
    try{await api('/api/settings',{method:'POST',body:JSON.stringify({statusDesignTheme:theme})});
      document.getElementById('sd-theme-out').innerHTML=`<p class="ok-text">✓ Global theme set to <b>${theme}</b></p>`;
      toast('Theme saved ✓');}
    catch(e){toast(e.message,'err');}
  };
};

// ── Settings ──────────────────────────────────────────────
TABS.settings = () => `
<div class="anim-up">
  <div class="page-hdr"><div><div class="page-title">Settings</div>
  <div class="page-sub">Global configuration · <span id="hdr-clock" class="clock"></span></div></div></div>
  <div style="max-width:520px">
    <div class="card">
      <h2>General</h2>
      <label><input type="checkbox" id="cfg-sd" ${state?.config?.statusDesignEnabled!==false?'checked':''}> Status Design Enabled</label>
      <label><input type="checkbox" id="cfg-notify" ${state?.config?.notificationsEnabled!==false?'checked':''}> Telegram Notifications</label>
      <label><input type="checkbox" id="cfg-lc" ${state?.config?.defaultLinkCollection?'checked':''}> Default Link Collection</label>
      <hr>
      <h3>Command Prefix</h3>
      <input id="cfg-prefix" value="${state?.config?.prefix||'.'}" style="max-width:120px">
      <div class="btn-row mt8">
        <button class="btn-pri" id="cfg-save">💾 Save Settings</button>
      </div>
      <div id="cfg-out" class="mt8"></div>
    </div>
    <div class="card">
      <h2>Danger Zone</h2>
      <p class="muted" style="margin-bottom:12px">Irreversible actions — proceed with caution</p>
      <div class="btn-row">
        <button class="btn-dan" onclick="confirm('Sign out?')&&api('/api/auth/logout',{method:'POST'}).then(()=>showAuth())">🚪 Sign Out</button>
      </div>
    </div>
  </div>
</div>`;

WIRE.settings = () => {
  document.getElementById('cfg-save').onclick=async()=>{
    const out=document.getElementById('cfg-out');
    try{await api('/api/settings',{method:'POST',body:JSON.stringify({
      statusDesignEnabled:document.getElementById('cfg-sd').checked,
      notificationsEnabled:document.getElementById('cfg-notify').checked,
      defaultLinkCollection:document.getElementById('cfg-lc').checked,
      prefix:document.getElementById('cfg-prefix').value.trim()||'.',
    })});
      out.innerHTML='<p class="ok-text">✓ Settings saved</p>'; toast('Saved ✓');
      state=await api('/api/dashboard');}
    catch(e){out.innerHTML=`<p class="err-text">${e.message}</p>`;}
  };
};

// ── Boot ──────────────────────────────────────────────────
api('/api/dashboard').then(s=>{state=s;initDash();}).catch(()=>showAuth());
