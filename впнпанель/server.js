'use strict';
// VPN Panel — Xray (VLESS + Reality) manager. Zero dependencies, Node >= 16.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const DIR = process.env.PANEL_DIR || __dirname;
const PORT = parseInt(process.env.PANEL_PORT || '8080', 10);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const XRAY_BIN = process.env.XRAY_BIN || '/usr/local/bin/xray';
const XRAY_CONF = process.env.XRAY_CONF || '/usr/local/etc/xray/config.json';
const XRAY_SERVICE = process.env.XRAY_SERVICE || 'xray';
const API_PORT = 10085;
const DATA = path.join(DIR, 'data');
const DBF = path.join(DATA, 'db.json');
fs.mkdirSync(DATA, { recursive: true });

const proto = (req) => (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
const rnd = (n) => crypto.randomBytes(n).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const GB = 1024 ** 3;

// ---------- DB ----------
let db;
function load() {
  if (fs.existsSync(DBF)) { db = JSON.parse(fs.readFileSync(DBF, 'utf8')); return; }
  let priv = '', pub = '';
  try {
    const out = execFileSync(XRAY_BIN, ['x25519']).toString();
    priv = (out.match(/Private\s?key:\s*(\S+)/i) || [])[1];
    pub = (out.match(/(?:Public\s?key|Password):\s*(\S+)/i) || [])[1];
  } catch (e) { console.error('x25519 failed:', e.message); }
  db = {
    settings: {
      title: 'VPN Panel', host: process.env.SERVER_HOST || '', port: 443,
      sni: 'www.microsoft.com', subBase: '', privateKey: priv, publicKey: pub, shortId: rnd(4),
    },
    users: [],
  };
  save();
}
function save() { fs.writeFileSync(DBF + '.tmp', JSON.stringify(db, null, 1)); fs.renameSync(DBF + '.tmp', DBF); }

// ---------- users ----------
function status(u) {
  if (!u.enabled) return 'disabled';
  if (u.expire && Date.now() > u.expire) return 'expired';
  if (u.limit && u.used >= u.limit) return 'limited';
  return 'active';
}
const isActive = (u) => status(u) === 'active';
const pubUser = (u) => ({ ...u, status: status(u) });

// ---------- xray ----------
function buildConfig() {
  const s = db.settings;
  return {
    log: { loglevel: 'warning' },
    stats: {},
    api: { tag: 'api', services: ['StatsService'] },
    policy: {
      levels: { 0: { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true },
    },
    inbounds: [
      {
        tag: 'vless-in', port: s.port, protocol: 'vless',
        settings: {
          decryption: 'none',
          clients: db.users.filter(isActive).map((u) => ({ id: u.uuid, email: u.id, flow: 'xtls-rprx-vision' })),
        },
        streamSettings: {
          network: 'tcp', security: 'reality',
          realitySettings: {
            show: false, dest: s.sni + ':443', xver: 0, serverNames: [s.sni],
            privateKey: s.privateKey, shortIds: [s.shortId],
          },
        },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
      },
      { tag: 'api-in', listen: '127.0.0.1', port: API_PORT, protocol: 'dokodemo-door', settings: { address: '127.0.0.1' } },
    ],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'block' }],
    routing: { rules: [{ type: 'field', inboundTag: ['api-in'], outboundTag: 'api' }] },
  };
}
let applyTimer = null;
function applyXray() {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(XRAY_CONF), { recursive: true });
      fs.writeFileSync(XRAY_CONF, JSON.stringify(buildConfig(), null, 2));
      execFile('systemctl', ['restart', XRAY_SERVICE], (e) => e && console.error('xray restart:', e.message));
    } catch (e) { console.error('apply:', e.message); }
  }, 400);
}
function pollStats() {
  execFile(XRAY_BIN, ['api', 'statsquery', `--server=127.0.0.1:${API_PORT}`, '-reset'], { timeout: 8000 }, (err, out) => {
    let changed = false;
    if (!err) {
      try {
        const j = JSON.parse(out || '{}');
        for (const st of j.stat || []) {
          const m = /^user>>>(.+?)>>>traffic>>>(uplink|downlink)$/.exec(st.name);
          if (!m) continue;
          const u = db.users.find((x) => x.id === m[1]);
          if (!u) continue;
          const v = parseInt(st.value || '0', 10);
          if (m[2] === 'uplink') u.up += v; else u.down += v;
          u.used += v; changed = true;
        }
      } catch (_) {}
    }
    if (changed) save();
    enforce();
  });
}
let lastActive = '';
function enforce() {
  const sig = db.users.filter(isActive).map((u) => u.id).join(',');
  if (sig !== lastActive) { lastActive = sig; applyXray(); }
}

// ---------- subscription ----------
function link(u) {
  const s = db.settings;
  const q = new URLSearchParams({
    encryption: 'none', flow: 'xtls-rprx-vision', security: 'reality', sni: s.sni,
    fp: 'chrome', pbk: s.publicKey, sid: s.shortId, type: 'tcp',
  });
  return `vless://${u.uuid}@${s.host}:${s.port}?${q}#${encodeURIComponent(s.title + ' - ' + u.name)}`;
}
function subPage(u, base) {
  const url = base + '/sub/' + u.token;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const left = u.limit ? Math.max(0, u.limit - u.used) : 0;
  const f = (b) => (b / GB).toFixed(2) + ' GB';
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(db.settings.title)}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07070f;color:#eef;font-family:system-ui,sans-serif;padding:16px}
.c{width:100%;max-width:440px;padding:28px;border-radius:24px;background:linear-gradient(160deg,#1a1a3a,#0e0e22);border:1px solid #ffffff22;box-shadow:0 20px 80px #6d5dfc44}
h1{margin:0 0 4px;font-size:22px}p{color:#9aa;margin:4px 0 16px}.r{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #ffffff14}
a,button{display:block;width:100%;margin-top:10px;padding:14px;border:0;border-radius:14px;background:linear-gradient(90deg,#6d5dfc,#18c7ff);color:#fff;font-weight:700;text-align:center;text-decoration:none;font-size:15px;cursor:pointer}
a.g,button.g{background:#ffffff14}code{display:block;word-break:break-all;background:#0006;padding:10px;border-radius:10px;font-size:12px;margin-top:12px;color:#9cf}</style>
<div class=c><h1>🛡 ${esc(db.settings.title)}</h1><p>Подписка: ${esc(u.name)}</p>
<div class=r><span>Статус</span><b>${status(u)}</b></div>
<div class=r><span>Использовано</span><b>${f(u.used)}${u.limit ? ' / ' + f(u.limit) : ' / ∞'}</b></div>
<div class=r><span>Действует до</span><b>${u.expire ? new Date(u.expire).toLocaleDateString('ru-RU') : 'бессрочно'}</b></div>
<a href="v2raytun://import/${url}">Открыть в v2RayTun</a><a href="happ://add/${url}">Открыть в Happ</a><a class=g href="hiddify://import/${url}">Открыть в Hiddify</a>
<button class=g onclick="navigator.clipboard.writeText('${url}');this.textContent='Скопировано ✓'">Скопировать ссылку подписки</button><code>${esc(url)}</code></div>`;
}

// ---------- http helpers ----------
const sessions = new Map();
const attempts = new Map();
function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1)); });
  return o;
}
const authed = (req) => { const t = cookies(req).vp_sid; const e = t && sessions.get(t); return !!e && e > Date.now(); };
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((ok) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (_) { ok({}); } });
  });
}
function sysInfo(cb) {
  execFile('systemctl', ['is-active', XRAY_SERVICE], (e, out) => {
    const tot = os.totalmem(), fr = os.freemem();
    cb({
      xray: (out || '').trim() === 'active', load: os.loadavg()[0], cpus: os.cpus().length,
      memUsed: tot - fr, memTotal: tot, uptime: os.uptime(),
    });
  });
}

// ---------- server ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // subscription (public)
    let m = /^\/sub\/([a-f0-9]+)$/.exec(p);
    if (m) {
      const u = db.users.find((x) => x.token === m[1]);
      if (!u) return send(res, 404, 'Not found');
      const base = db.settings.subBase || (proto(req) + '://' + req.headers.host);
      if (!url.searchParams.has('raw') && /text\/html/.test(req.headers.accept || '') && !/v2ray|happ|hiddify|clash|sing|streisand|nekobox/i.test(req.headers['user-agent'] || ''))
        return send(res, 200, subPage(u, base), { 'Content-Type': 'text/html; charset=utf-8' });
      const body = isActive(u) ? link(u) : '';
      return send(res, 200, Buffer.from(body).toString('base64'), {
        'profile-title': 'base64:' + Buffer.from(db.settings.title).toString('base64'),
        'profile-update-interval': '6',
        'subscription-userinfo': `upload=${u.up}; download=${u.down}; total=${u.limit}; expire=${Math.floor((u.expire || 0) / 1000)}`,
      });
    }
    if (p === '/' || p === '/index.html')
      return send(res, 200, fs.readFileSync(path.join(DIR, 'index.html')), { 'Content-Type': 'text/html; charset=utf-8' });

    if (p === '/api/login' && req.method === 'POST') {
      const ip = (process.env.PANEL_BIND && req.headers['x-forwarded-for']) || req.socket.remoteAddress; const a = attempts.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - a.t > 600000) { a.n = 0; a.t = Date.now(); }
      if (a.n >= 8) return send(res, 429, { error: 'Слишком много попыток, подождите 10 минут' });
      const b = await readBody(req);
      const ok = b.username === ADMIN_USER && crypto.timingSafeEqual(sha(b.password || ''), sha(ADMIN_PASS));
      if (!ok) { a.n++; attempts.set(ip, a); return send(res, 401, { error: 'Неверный логин или пароль' }); }
      const t = rnd(24); sessions.set(t, Date.now() + 7 * 864e5);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `vp_sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${proto(req) === 'https' ? '; Secure' : ''}` });
    }
    if (!p.startsWith('/api/')) return send(res, 404, 'Not found');
    if (!authed(req)) return send(res, 401, { error: 'auth' });

    if (p === '/api/logout') { sessions.delete(cookies(req).vp_sid); return send(res, 200, { ok: true }, { 'Set-Cookie': 'vp_sid=; Path=/; Max-Age=0' }); }
    if (p === '/api/state') {
      return sysInfo((sys) => send(res, 200, {
        sys, settings: { ...db.settings, privateKey: undefined }, users: db.users.map(pubUser),
        origin: db.settings.subBase || (proto(req) + '://' + req.headers.host),
      }));
    }
    if (p === '/api/users' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name) return send(res, 400, { error: 'Укажите имя' });
      const days = Number(b.days) || 0, lim = Number(b.limitGb) || 0;
      const u = {
        id: rnd(4), name, uuid: crypto.randomUUID(), token: rnd(12), created: Date.now(),
        expire: days ? Date.now() + days * 864e5 : 0, limit: Math.round(lim * GB), used: 0, up: 0, down: 0,
        enabled: true, note: String(b.note || '').slice(0, 120),
      };
      db.users.push(u); save(); enforce();
      return send(res, 200, pubUser(u));
    }
    m = /^\/api\/users\/([a-f0-9]+)$/.exec(p);
    if (m) {
      const i = db.users.findIndex((x) => x.id === m[1]);
      if (i < 0) return send(res, 404, { error: 'Нет такого пользователя' });
      const u = db.users[i];
      if (req.method === 'DELETE') { db.users.splice(i, 1); save(); lastActive = ''; enforce(); return send(res, 200, { ok: true }); }
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        if (typeof b.name === 'string' && b.name.trim()) u.name = b.name.trim().slice(0, 40);
        if (typeof b.note === 'string') u.note = b.note.slice(0, 120);
        if (typeof b.enabled === 'boolean') u.enabled = b.enabled;
        if (b.limitGb !== undefined) u.limit = Math.round((Number(b.limitGb) || 0) * GB);
        if (b.days !== undefined) { const d = Number(b.days) || 0; u.expire = d ? Date.now() + d * 864e5 : 0; }
        if (b.resetTraffic) { u.used = 0; u.up = 0; u.down = 0; }
        save(); lastActive = ''; enforce();
        return send(res, 200, pubUser(u));
      }
    }
    if (p === '/api/settings' && req.method === 'PUT') {
      const b = await readBody(req); const s = db.settings;
      if (typeof b.title === 'string' && b.title.trim()) s.title = b.title.trim().slice(0, 40);
      if (typeof b.host === 'string') s.host = b.host.trim();
      if (typeof b.sni === 'string' && b.sni.trim()) s.sni = b.sni.trim();
      if (typeof b.subBase === 'string') s.subBase = b.subBase.trim().replace(/\/+$/, '');
      if (b.port) s.port = Math.min(65535, Math.max(1, parseInt(b.port, 10) || 443));
      save(); applyXray();
      return send(res, 200, { ok: true });
    }
    if (m = /^\/api\/users\/([a-f0-9]+)\/link$/.exec(p)) {
      const u = db.users.find((x) => x.id === m[1]);
      return u ? send(res, 200, { link: link(u) }) : send(res, 404, { error: 'not found' });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); send(res, 500, { error: 'Внутренняя ошибка' }); }
}).listen(PORT, process.env.PANEL_BIND || '0.0.0.0', () => {
  load();
  applyXray();
  setInterval(pollStats, 30000);
  setInterval(enforce, 20000);
  console.log('VPN panel on :' + PORT);
});
