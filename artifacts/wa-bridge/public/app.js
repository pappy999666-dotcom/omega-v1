// ── State ─────────────────────────────────────────────────
const app = document.getElementById('app');
let state = null, evtSrc = null, liveMsg = '';

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

// ── Canvas BG ─────────────────────────────────────────────
(function initCanvas() {
  const c = document.getElementById('bg');
  if (!c) return;
  const ctx = c.getContext('2d');
  let W, H, particles = [];
  function resize() {
    W = c.width = window.innerWidth;
    H = c.height = window.innerHeight;
  }
  function mkParticle() {
    return { x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.5 + .3, vx: (Math.random() - .5) * .3, vy: (Math.random() - .5) * .3, a: Math.random() };
  }
  resize();
  for (let i = 0; i < 80; i++) particles.push(mkParticle());
  window.addEventListener('resize', resize);
  function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(176,106,255,${p.a * .6})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  draw();
})();

// ── Audio ─────────────────────────────────────────────────
(function initAudio() {
  const btn = document.getElementById('mute-btn');
  const tracks = ['/sounds/ambient1.mp3', '/sounds/ambient2.mp3', '/sounds/ambient3.mp3'];
  let idx = 0, audio = null, muted = localStorage.getItem('omega_muted_v2') === '1';

  function updateBtn() { if (btn) btn.textContent = muted ? '🔇' : '🔊'; }
  updateBtn();

  function playNext() {
    if (muted) return;
    audio = new Audio(tracks[idx % tracks.length]);
    audio.volume = 0.18;
    audio.onended = () => { idx++; playNext(); };
    audio.play().catch(() => {});
  }

  function start() {
    if (!audio && !muted) playNext();
    document.removeEventListener('click', start);
    document.removeEventListener('touchstart', start);
  }

  document.addEventListener('click', start);
  document.addEventListener('touchstart', start);

  if (btn) btn.onclick = (e) => {
    e.stopPropagation();
    muted = !muted;
    localStorage.setItem('omega_muted_v2', muted ? '1' : '0');
    updateBtn();
    if (muted && audio) { audio.pause(); audio = null; }
    else if (!muted) playNext();
  };
})();

// ── Live strip ────────────────────────────────────────────
function setLive(msg) {
  liveMsg = msg;
  let el = document.getElementById('live-strip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'live-strip';
    el.className = 'live-strip';
    document.body.appendChild(el);
  }
  el.textContent = '● ' + msg;
}

// ── Auth ──────────────────────────────────────────────────
function showAuth() {
  app.innerHTML = `
<div class="hero">
  <div class="hero-brand">Ω Omega</div>
  <div class="hero-sub">WA-Bridge Control Center — pair sessions, run outreach, design statuses</div>
  <div class="card" style="width:100%;max-width:360px">
    <h2>Sign in</h2>
    <input id="au" placeholder="Username" autocomplete="username">
    <input id="ap" type="password" placeholder="Password" autocomplete="current-password">
    <div class="btn-row">
      <button id="btn-login">Login</button>
      <button class="sec" id="btn-reg">Register</button>
    </div>
    <p id="auth-err" class="err mt8" style="font-size:12px"></p>
  </div>
</div>`;
  async function doAuth(endpoint) {
    const err = document.getElementById('auth-err');
    err.textContent = '';
    try {
      await api('/api/auth/' + endpoint, { method: 'POST', body: JSON.stringify({ username: au.value.trim(), password: ap.value }) });
      initDash();
    } catch (e) { err.textContent = e.message; }
  }
  document.getElementById('btn-login').onclick = () => doAuth('login');
  document.getElementById('btn-reg').onclick = () => doAuth('register');
  document.getElementById('ap').onkeydown = e => { if (e.key === 'Enter') doAuth('login'); };
}

// ── Nav config ────────────────────────────────────────────
const NAV = [
  { id: 'sessions', icon: '📱', label: 'Sessions' },
  { id: 'pair',     icon: '🔗', label: 'Pair' },
  { id: 'buckets',  icon: '🪣', label: 'Buckets' },
  { id: 'validator',icon: '✅', label: 'Validator' },
  { id: 'outreach', icon: '📡', label: 'Outreach' },
  { id: 'status',   icon: '🎨', label: 'Status' },
  { id: 'settings', icon: '⚙️', label: 'Settings' },
];

let activeTab = 'sessions';

function navHTML() {
  return NAV.map(n => `
    <button class="nav-item${activeTab===n.id?' active':''}" data-tab="${n.id}">
      <span class="icon">${n.icon}</span>${n.label}
    </button>`).join('');
}

function bnavHTML() {
  const visible = NAV.slice(0, 5);
  return visible.map(n => `
    <button class="bnav-item${activeTab===n.id?' active':''}" data-tab="${n.id}">
      <span class="icon">${n.icon}</span>${n.label}
    </button>`).join('');
}

// ── Dashboard shell ───────────────────────────────────────
function renderShell() {
  app.innerHTML = `
<div class="shell">
  <aside class="sidebar">
    <div class="brand">Ω Omega<small>WA-Bridge v1</small></div>
    <nav id="sidebar-nav">${navHTML()}</nav>
    <div class="sidebar-footer">
      <button class="ghost" style="width:100%" id="btn-logout">🚪 Logout</button>
    </div>
  </aside>
  <main class="main" id="main-content"></main>
</div>
<nav class="bnav"><div class="bnav-inner" id="bnav-inner">${bnavHTML()}</div></nav>`;

  document.getElementById('btn-logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    if (evtSrc) { evtSrc.close(); evtSrc = null; }
    showAuth();
  };

  bindNav();
  drawTab(activeTab);
}

function bindNav() {
  document.querySelectorAll('[data-tab]').forEach(b => {
    b.onclick = () => switchTab(b.dataset.tab);
  });
}

function switchTab(id) {
  activeTab = id;
  document.querySelectorAll('[data-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === id);
  });
  drawTab(id);
}

function drawTab(id) {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = TABS[id] ? TABS[id]() : '<p class="muted">Coming soon</p>';
  if (WIRE[id]) WIRE[id]();
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
  evtSrc.onerror = () => setTimeout(connectSSE, 4000);
}

// ── Init dashboard ────────────────────────────────────────
async function initDash() {
  try {
    state = await api('/api/dashboard');
  } catch {
    return showAuth();
  }
  renderShell();
  connectSSE();
}

// ── Helpers ───────────────────────────────────────────────
function sessOptions() {
  if (!state?.sessions?.length) return '<option value="">No sessions</option>';
  return state.sessions.map(s =>
    `<option value="${s.sessionId}">${s.label || s.phone || s.sessionId} — ${s.status}</option>`
  ).join('');
}

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 16px;font-size:12px;z-index:9999;color:var(--${type === 'err' ? 'danger' : type === 'warn' ? 'warn' : 'success'})`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── TABS ──────────────────────────────────────────────────
const TABS = {};
const WIRE = {};

// ── Sessions ──────────────────────────────────────────────
TABS.sessions = () => {
  const sessions = state?.sessions || [];
  const online = state?.activeSockets || [];
  return `
<div class="page-hdr">
  <div><div class="page-title">Sessions</div>
  <div class="page-sub">${sessions.length} configured · ${online.length} online</div></div>
</div>
<div class="stats-row">
  <div class="stat-box"><div class="stat-num">${sessions.length}</div><div class="stat-lbl">Total</div></div>
  <div class="stat-box"><div class="stat-num">${online.length}</div><div class="stat-lbl">Online</div></div>
  <div class="stat-box"><div class="stat-num">${sessions.filter(s=>s.status==='frozen').length}</div><div class="stat-lbl">Frozen</div></div>
</div>
<div class="card">
  ${sessions.length === 0 ? '<p class="muted">No sessions yet. Go to Pair to add one.</p>' :
    sessions.map(s => {
      const isOnline = online.includes(s.sessionId);
      const badge = s.status === 'frozen' ? '<span class="badge fr">frozen</span>'
        : isOnline ? '<span class="badge on">online</span>'
        : '<span class="badge off">offline</span>';
      return `
<div class="sess-item">
  <div class="sess-info">
    <div class="sess-name">${s.label || s.phone || s.sessionId}${badge}</div>
    <div class="sess-meta">${s.sessionId}</div>
  </div>
  <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
    <div class="btn-row">
      <button class="sec" data-freeze="${s.sessionId}">❄️ Freeze</button>
      <button class="sec" data-unfreeze="${s.sessionId}">▶️ Unfreeze</button>
      <button class="dan" data-purge="${s.sessionId}">🗑 Purge</button>
    </div>
    <div class="btn-row">
      <button class="ghost" data-expand="${s.sessionId}">⚙️ More</button>
    </div>
  </div>
</div>
<div class="sub-panel" id="sub-${s.sessionId}">
  <div class="grid">
    <div class="card">
      <h3>🖼 Profile Picture</h3>
      <input type="file" id="pfp-${s.sessionId}" accept="image/*" style="margin-bottom:8px">
      <div class="btn-row">
        <button class="sec" data-pfp="${s.sessionId}">Set PFP (HD)</button>
        <button class="ghost" data-rmpfp="${s.sessionId}">Remove</button>
      </div>
    </div>
    <div class="card">
      <h3>✏️ Display Name</h3>
      <input id="name-${s.sessionId}" placeholder="New display name">
      <button class="sec" data-setname="${s.sessionId}">Set Name</button>
    </div>
    <div class="card">
      <h3>🌉 Bridge Mode</h3>
      <label><input type="checkbox" id="bridge-${s.sessionId}" ${s.bridgeMode?'checked':''}> Enable bridge</label>
      <button class="sec" data-bridge="${s.sessionId}">Save</button>
    </div>
    <div class="card">
      <h3>🔗 Link Collection</h3>
      <label><input type="checkbox" id="lc-${s.sessionId}" ${s.linkCollectionEnabled?'checked':''}> Auto-collect links</label>
      <button class="sec" data-lc="${s.sessionId}">Save</button>
    </div>
    <div class="card">
      <h3>👑 Auto-Promote</h3>
      <label><input type="checkbox" id="ap-${s.sessionId}" ${s.autoPromote?'checked':''}> Auto-promote admins</label>
      <button class="sec" data-autopromote="${s.sessionId}">Save</button>
    </div>
    <div class="card">
      <h3>🔄 Reinit Session</h3>
      <p class="muted" style="margin-bottom:8px">Re-initialise the WhatsApp socket</p>
      <button class="dan" data-reinit="${s.sessionId}">Reinit</button>
    </div>
  </div>
</div>`;
    }).join('')
  }
</div>`;
};

WIRE.sessions = () => {
  document.querySelectorAll('[data-freeze]').forEach(b =>
    b.onclick = () => api(`/api/sessions/${b.dataset.freeze}/freeze`, { method: 'POST' })
      .then(() => toast('Frozen')).catch(e => toast(e.message, 'err')));
  document.querySelectorAll('[data-unfreeze]').forEach(b =>
    b.onclick = () => api(`/api/sessions/${b.dataset.unfreeze}/unfreeze`, { method: 'POST' })
      .then(() => toast('Unfrozen')).catch(e => toast(e.message, 'err')));
  document.querySelectorAll('[data-purge]').forEach(b =>
    b.onclick = () => confirm('Purge this session?') &&
      api(`/api/sessions/${b.dataset.purge}`, { method: 'DELETE' })
        .then(() => { toast('Purged'); state = null; api('/api/dashboard').then(s => { state = s; drawTab('sessions'); }); })
        .catch(e => toast(e.message, 'err')));
  document.querySelectorAll('[data-expand]').forEach(b => {
    b.onclick = () => {
      const panel = document.getElementById(`sub-${b.dataset.expand}`);
      if (panel) panel.classList.toggle('open');
    };
  });
  document.querySelectorAll('[data-pfp]').forEach(b => {
    b.onclick = async () => {
      const file = document.getElementById(`pfp-${b.dataset.pfp}`)?.files?.[0];
      if (!file) return toast('Select an image first', 'warn');
      const fd = new FormData(); fd.append('image', file);
      api(`/api/sessions/${b.dataset.pfp}/pfp`, { method: 'POST', body: fd })
        .then(() => toast('PFP updated')).catch(e => toast(e.message, 'err'));
    };
  });
  document.querySelectorAll('[data-rmpfp]').forEach(b =>
    b.onclick = () => api(`/api/sessions/${b.dataset.rmpfp}/pfp`, { method: 'DELETE' })
      .then(() => toast('PFP removed')).catch(e => toast(e.message, 'err')));
  document.querySelectorAll('[data-setname]').forEach(b =>
    b.onclick = () => {
      const name = document.getElementById(`name-${b.dataset.setname}`)?.value?.trim();
      if (!name) return toast('Enter a name', 'warn');
      api(`/api/sessions/${b.dataset.setname}/setname`, { method: 'POST', body: JSON.stringify({ name }) })
        .then(() => toast('Name updated')).catch(e => toast(e.message, 'err'));
    });
  document.querySelectorAll('[data-bridge]').forEach(b =>
    b.onclick = () => {
      const enabled = document.getElementById(`bridge-${b.dataset.bridge}`)?.checked;
      api(`/api/sessions/${b.dataset.bridge}/bridge`, { method: 'POST', body: JSON.stringify({ enabled }) })
        .then(() => toast('Bridge saved')).catch(e => toast(e.message, 'err'));
    });
  document.querySelectorAll('[data-lc]').forEach(b =>
    b.onclick = () => {
      const enabled = document.getElementById(`lc-${b.dataset.lc}`)?.checked;
      api(`/api/sessions/${b.dataset.lc}/linkcollection`, { method: 'POST', body: JSON.stringify({ enabled }) })
        .then(() => toast('Link collection saved')).catch(e => toast(e.message, 'err'));
    });
  document.querySelectorAll('[data-autopromote]').forEach(b =>
    b.onclick = () => {
      const enabled = document.getElementById(`ap-${b.dataset.autopromote}`)?.checked;
      api(`/api/sessions/${b.dataset.autopromote}/autopromote`, { method: 'POST', body: JSON.stringify({ enabled }) })
        .then(() => toast('Auto-promote saved')).catch(e => toast(e.message, 'err'));
    });
  document.querySelectorAll('[data-reinit]').forEach(b =>
    b.onclick = () => confirm('Reinit session?') &&
      api(`/api/sessions/${b.dataset.reinit}/reinit`, { method: 'POST' })
        .then(() => toast('Reinit sent')).catch(e => toast(e.message, 'err')));
};

// ── Pair ──────────────────────────────────────────────────
let pairPoll = null;

TABS.pair = () => `
<div class="page-hdr"><div class="page-title">Pair Session</div></div>
<div class="grid">
  <div class="card">
    <h2>New Session</h2>
    <input id="pair-label" placeholder="Label (e.g. Main)">
    <input id="pair-phone" placeholder="Phone with country code (e.g. +234...)">
    <select id="pair-method">
      <option value="qr">QR Code</option>
      <option value="code">Pairing Code</option>
    </select>
    <button id="pair-btn">🔗 Start Pairing</button>
    <div id="pair-out" class="mt8"></div>
  </div>
  <div class="card">
    <h2>Active Sessions</h2>
    ${(state?.sessions||[]).length === 0 ? '<p class="muted">None yet</p>' :
      (state?.sessions||[]).map(s => `
        <div style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div style="font-weight:600;font-size:13px">${s.label||s.phone||s.sessionId}</div>
          <div class="muted">${s.status}</div>
        </div>`).join('')
    }
  </div>
</div>`;

WIRE.pair = () => {
  const btn = document.getElementById('pair-btn');
  const out = document.getElementById('pair-out');
  btn.onclick = async () => {
    const label = document.getElementById('pair-label').value.trim();
    const phone = document.getElementById('pair-phone').value.trim();
    const method = document.getElementById('pair-method').value;
    if (!phone) return toast('Enter a phone number', 'warn');
    btn.disabled = true; btn.textContent = '⏳ Pairing…';
    out.innerHTML = '<p class="muted">Starting…</p>';
    try {
      const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ label, phone, method }) });
      if (pairPoll) clearInterval(pairPoll);
      pairPoll = setInterval(async () => {
        try {
          const p = await api(`/api/sessions/${r.sessionId}/pairing`);
          if (p.qr) {
            out.innerHTML = `<div class="qr-wrap"><img src="${p.qr}" alt="QR"></div><p class="muted" style="text-align:center">Scan with WhatsApp</p>`;
          } else if (p.code) {
            out.innerHTML = `<div class="pair-code">${p.code}</div><p class="muted" style="text-align:center">Enter this code in WhatsApp → Linked Devices</p>
            <button class="sec" onclick="navigator.clipboard.writeText('${p.code}').then(()=>toast('Copied!'))">📋 Copy</button>`;
          } else if (p.error) {
            out.innerHTML = `<p class="err">${p.error}</p>`;
          } else {
            out.innerHTML = `<p class="muted">Waiting for WhatsApp…</p>`;
          }
          if (!p.isPairing) {
            clearInterval(pairPoll); pairPoll = null;
            btn.disabled = false; btn.textContent = '🔗 Start Pairing';
            if (!p.error) { toast('Session paired!'); state = await api('/api/dashboard'); drawTab('pair'); }
          }
        } catch {}
      }, 2500);
    } catch (e) {
      out.innerHTML = `<p class="err">${e.message}</p>`;
      btn.disabled = false; btn.textContent = '🔗 Start Pairing';
    }
  };
};

// ── Buckets ───────────────────────────────────────────────
TABS.buckets = () => `
<div class="page-hdr"><div class="page-title">Buckets</div></div>
<div class="stats-row">
  <div class="stat-box"><div class="stat-num">${state?.buckets?.main||0}</div><div class="stat-lbl">Main</div></div>
  <div class="stat-box"><div class="stat-num">${state?.buckets?.active||0}</div><div class="stat-lbl">Active</div></div>
  <div class="stat-box"><div class="stat-num">${state?.buckets?.dead||0}</div><div class="stat-lbl">Dead</div></div>
</div>
<div class="grid">
  <div class="card">
    <h2>Add Links</h2>
    <textarea id="bk-links" placeholder="Paste WhatsApp invite links, one per line"></textarea>
    <input id="bk-file" type="file" accept=".txt,.csv,.json">
    <div class="btn-row">
      <button id="bk-add">➕ Add Links</button>
      <button class="sec" id="bk-import">📂 Import File</button>
    </div>
    <div id="bk-out" class="mt8"></div>
  </div>
  <div class="card">
    <h2>Export / Purge</h2>
    <div class="btn-row" style="flex-direction:column;gap:8px">
      <button class="sec" id="bk-exp-active">⬇️ Export Active (.txt)</button>
      <button class="sec" id="bk-exp-csv">⬇️ Export Active (.csv)</button>
      <button class="dan" id="bk-purge-dead">🗑 Purge Dead</button>
      <button class="dan" id="bk-purge-main">🗑 Purge Main</button>
    </div>
  </div>
</div>`;

WIRE.buckets = () => {
  document.getElementById('bk-add').onclick = async () => {
    const links = document.getElementById('bk-links').value.trim();
    if (!links) return toast('Paste some links first', 'warn');
    try {
      const r = await api('/api/buckets/links', { method: 'POST', body: JSON.stringify({ links }) });
      document.getElementById('bk-out').innerHTML = `<p class="ok">Added: ${r.added} · Dupes: ${r.dupes}</p>`;
      state = await api('/api/dashboard'); drawTab('buckets');
    } catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('bk-import').onclick = async () => {
    const file = document.getElementById('bk-file').files?.[0];
    if (!file) return toast('Select a file first', 'warn');
    const text = await file.text();
    try {
      const r = await api('/api/buckets/import', { method: 'POST', body: JSON.stringify({ text, name: file.name }) });
      toast(`Imported: ${r.added}`);
      state = await api('/api/dashboard'); drawTab('buckets');
    } catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('bk-exp-active').onclick = () => location.href = '/api/buckets/active/export/txt';
  document.getElementById('bk-exp-csv').onclick = () => location.href = '/api/buckets/active/export/csv';
  document.getElementById('bk-purge-dead').onclick = () => confirm('Purge dead bucket?') &&
    api('/api/buckets/dead', { method: 'DELETE' }).then(() => { toast('Dead purged'); api('/api/dashboard').then(s => { state = s; drawTab('buckets'); }); }).catch(e => toast(e.message, 'err'));
  document.getElementById('bk-purge-main').onclick = () => confirm('Purge main bucket?') &&
    api('/api/buckets/main', { method: 'DELETE' }).then(() => { toast('Main purged'); api('/api/dashboard').then(s => { state = s; drawTab('buckets'); }); }).catch(e => toast(e.message, 'err'));
};

// ── Validator ─────────────────────────────────────────────
TABS.validator = () => `
<div class="page-hdr"><div class="page-title">Validator</div></div>
<div class="grid">
  <div class="card">
    <h2>Session Validator</h2>
    <p class="muted" style="margin-bottom:10px">Validates links using a live WhatsApp session</p>
    <select id="val-sid">${sessOptions()}</select>
    <div class="btn-row">
      <button id="val-start">▶️ Start</button>
      <button class="sec" id="val-stop">⏹ Stop</button>
    </div>
    <div id="val-out" class="mt8"></div>
  </div>
  <div class="card">
    <h2>HTTP Validator</h2>
    <p class="muted" style="margin-bottom:10px">Sessionless — checks links via HTTP HEAD</p>
    <textarea id="http-links" placeholder="Paste links to validate"></textarea>
    <button id="http-val">🌐 Validate</button>
    <div id="http-out" class="log" style="display:none"></div>
  </div>
</div>`;

WIRE.validator = () => {
  document.getElementById('val-start').onclick = async () => {
    const sid = document.getElementById('val-sid').value;
    if (!sid) return toast('Select a session', 'warn');
    try {
      await api('/api/validator/start', { method: 'POST', body: JSON.stringify({ sessionId: sid }) });
      toast('Validation started');
    } catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('val-stop').onclick = () =>
    api('/api/validator/stop', { method: 'POST' }).then(() => toast('Stopped')).catch(e => toast(e.message, 'err'));
  document.getElementById('http-val').onclick = async () => {
    const raw = document.getElementById('http-links').value.trim();
    if (!raw) return toast('Paste links first', 'warn');
    const links = raw.split(/\s+/).filter(Boolean);
    const out = document.getElementById('http-out');
    out.style.display = 'block'; out.textContent = 'Checking…';
    try {
      const r = await api('/api/validator/http', { method: 'POST', body: JSON.stringify({ links }) });
      out.textContent = `Active: ${r.active?.length||0}\nDead: ${r.dead?.length||0}\n\nActive:\n${(r.active||[]).join('\n')}\n\nDead:\n${(r.dead||[]).join('\n')}`;
    } catch (e) { out.textContent = e.message; }
  };
};

// ── Outreach ──────────────────────────────────────────────
TABS.outreach = () => `
<div class="page-hdr"><div class="page-title">Outreach</div></div>
<div class="grid">
  <div class="card">
    <h2>Broadcast</h2>
    <select id="out-sid">${sessOptions()}</select>
    <select id="out-type">
      <option value="allstatus">Group Status Broadcast</option>
      <option value="allchat">Group Chat Broadcast</option>
    </select>
    <textarea id="out-msg" placeholder="Message or URL to broadcast"></textarea>
    <div class="btn-row">
      <button id="out-send">🚀 Launch</button>
      <button class="sec" id="out-stop">⏹ Stop</button>
    </div>
    <div id="out-log" class="log" style="display:none"></div>
  </div>
  <div class="card">
    <h2>Link Preview</h2>
    <p class="muted" style="margin-bottom:10px">Fetch metadata for any URL</p>
    <input id="prev-url" placeholder="https://example.com">
    <button id="prev-btn">🔍 Fetch Preview</button>
    <div id="prev-out" class="mt8"></div>
  </div>
</div>`;

WIRE.outreach = () => {
  document.getElementById('out-send').onclick = async () => {
    const sid = document.getElementById('out-sid').value;
    const type = document.getElementById('out-type').value;
    const message = document.getElementById('out-msg').value.trim();
    if (!sid || !message) return toast('Select session and enter message', 'warn');
    const log = document.getElementById('out-log');
    log.style.display = 'block'; log.textContent = 'Launching…';
    try {
      const r = await api('/api/outreach', { method: 'POST', body: JSON.stringify({ sessionId: sid, type, message }) });
      log.textContent = JSON.stringify(r, null, 2);
      toast('Outreach launched');
    } catch (e) { log.textContent = e.message; toast(e.message, 'err'); }
  };
  document.getElementById('out-stop').onclick = () => {
    const sid = document.getElementById('out-sid').value;
    api('/api/outreach/stop', { method: 'POST', body: JSON.stringify({ sessionId: sid }) })
      .then(() => toast('Stop requested')).catch(e => toast(e.message, 'err'));
  };
  document.getElementById('prev-btn').onclick = async () => {
    const url = document.getElementById('prev-url').value.trim();
    if (!url) return toast('Enter a URL', 'warn');
    const out = document.getElementById('prev-out');
    out.innerHTML = '<p class="muted">Fetching…</p>';
    try {
      const r = await api('/api/preview', { method: 'POST', body: JSON.stringify({ url }) });
      out.innerHTML = `
        <div class="card" style="margin:0">
          ${r.thumbnail ? `<img src="${r.thumbnail}" style="width:100%;border-radius:6px;margin-bottom:8px">` : ''}
          <div style="font-weight:600;font-size:13px">${r.title||'No title'}</div>
          <div class="muted">${r.description||''}</div>
          <div class="muted" style="margin-top:4px;font-size:11px">${r.url||url}</div>
        </div>`;
    } catch (e) { out.innerHTML = `<p class="err">${e.message}</p>`; }
  };
};

// ── Status Design ─────────────────────────────────────────
TABS.status = () => `
<div class="page-hdr"><div class="page-title">Status Design</div></div>
<div class="grid">
  <div class="card">
    <h2>Design Preview</h2>
    <select id="sd-theme">
      ${(state?.themes||['clean','kawaii','cyber','luxury','gothic','girly','guys','dark','prestige','stars','flower','moon','angel','minimal','japanese']).map(t=>`<option value="${t}">${t}</option>`).join('')}
    </select>
    <input id="sd-title" placeholder="Title (optional — fetched from URL if blank)">
    <input id="sd-url" placeholder="https://chat.whatsapp.com/...">
    <button id="sd-render">✨ Render</button>
    <div id="sd-out" class="log" style="display:none;margin-top:10px"></div>
    <div class="btn-row mt8" id="sd-copy-row" style="display:none">
      <button class="sec" id="sd-copy">📋 Copy</button>
    </div>
  </div>
  <div class="card">
    <h2>Set Global Theme</h2>
    <p class="muted" style="margin-bottom:10px">Applied to all .gstatus and .togstatus commands</p>
    <select id="sd-gtheme">
      ${(state?.themes||['clean','kawaii','cyber','luxury','gothic','girly','guys','dark','prestige','stars','flower','moon','angel','minimal','japanese']).map(t=>`<option value="${t}">${t}</option>`).join('')}
    </select>
    <button id="sd-save-theme">💾 Save Theme</button>
    <div id="sd-theme-out" class="mt8"></div>
  </div>
</div>`;

WIRE.status = () => {
  document.getElementById('sd-render').onclick = async () => {
    const theme = document.getElementById('sd-theme').value;
    const title = document.getElementById('sd-title').value.trim();
    const url = document.getElementById('sd-url').value.trim();
    if (!url) return toast('Enter a URL', 'warn');
    const out = document.getElementById('sd-out');
    const copyRow = document.getElementById('sd-copy-row');
    out.style.display = 'block'; out.textContent = 'Rendering…';
    try {
      const r = await api('/api/statusdesign/preview', { method: 'POST', body: JSON.stringify({ theme, title, url }) });
      out.textContent = r.text;
      copyRow.style.display = 'flex';
      document.getElementById('sd-copy').onclick = () =>
        navigator.clipboard.writeText(r.text).then(() => toast('Copied!')).catch(() => toast('Copy failed', 'err'));
    } catch (e) { out.textContent = e.message; }
  };
  document.getElementById('sd-save-theme').onclick = async () => {
    const theme = document.getElementById('sd-gtheme').value;
    const out = document.getElementById('sd-theme-out');
    try {
      await api('/api/settings', { method: 'POST', body: JSON.stringify({ statusDesignTheme: theme }) });
      out.innerHTML = `<p class="ok">Theme saved: ${theme}</p>`;
      toast('Theme saved');
    } catch (e) { out.innerHTML = `<p class="err">${e.message}</p>`; }
  };
};

// ── Settings ──────────────────────────────────────────────
TABS.settings = () => `
<div class="page-hdr"><div class="page-title">Settings</div></div>
<div class="card" style="max-width:480px">
  <h2>Global Config</h2>
  <label><input type="checkbox" id="cfg-sd" ${state?.config?.statusDesignEnabled!==false?'checked':''}> Status Design Enabled</label>
  <label><input type="checkbox" id="cfg-notify" ${state?.config?.notificationsEnabled!==false?'checked':''}> Notifications</label>
  <label><input type="checkbox" id="cfg-lc" ${state?.config?.defaultLinkCollection?'checked':''}> Default Link Collection</label>
  <hr>
  <h3>Prefix</h3>
  <input id="cfg-prefix" value="${state?.config?.prefix||'.'}">
  <div class="btn-row">
    <button id="cfg-save">💾 Save Settings</button>
  </div>
  <div id="cfg-out" class="mt8"></div>
</div>`;

WIRE.settings = () => {
  document.getElementById('cfg-save').onclick = async () => {
    const out = document.getElementById('cfg-out');
    try {
      await api('/api/settings', { method: 'POST', body: JSON.stringify({
        statusDesignEnabled: document.getElementById('cfg-sd').checked,
        notificationsEnabled: document.getElementById('cfg-notify').checked,
        defaultLinkCollection: document.getElementById('cfg-lc').checked,
        prefix: document.getElementById('cfg-prefix').value.trim() || '.',
      })});
      out.innerHTML = '<p class="ok">Saved ✓</p>';
      toast('Settings saved');
      state = await api('/api/dashboard');
    } catch (e) { out.innerHTML = `<p class="err">${e.message}</p>`; }
  };
};

// ── Boot ──────────────────────────────────────────────────
api('/api/dashboard').then(s => { state = s; initDash(); }).catch(() => showAuth());
