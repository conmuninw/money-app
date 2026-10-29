// Money app API: Express + Google Sheets (central DB), runs as a Netlify Function.
const express = require('express');
const serverless = require('serverless-http');
const crypto = require('crypto');

const COLS = {
  Users: ['uid', 'email', 'created', 'consent_at', 'plan', 'plan_until'],
  Groups: ['id', 'owner', 'name', 'created'],
  Members: ['gid', 'uid', 'email', 'role'],
  Pots: ['id', 'uid', 'gid', 'name', 'target', 'created'],
  Tx: ['id', 'uid', 'gid', 'pot', 'date', 'type', 'amount', 'category', 'note', 'ref', 'created'],
  Budgets: ['uid', 'category', 'limit'],
  Debts: ['id', 'uid', 'name', 'balance', 'monthly', 'due']
};
// PLACEHOLDER limits: change these numbers after you decide what Pro includes.
const LIMITS = { free: { groups: 1, members: 3 }, pro: { groups: 5, members: 20 } };
const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const env = process.env;

class E extends Error { constructor(m, s) { super(m); this.s = s || 400; } }
let tok = null, tokExp = 0, cache = null, cacheAt = 0;
const idc = new Map();

// ---------- Data layer (Google Sheets). Replace this section to change database. ----------
async function gToken() {
  if (tok && tokExp > Date.now() + 60000) return tok;
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const pay = enc({ iss: env.SA_EMAIL, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + pay).sign(String(env.SA_KEY).replace(/\\n/g, '\n')).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + head + '.' + pay + '.' + sig
  });
  if (!r.ok) { console.error('token', r.status, await r.text()); throw new E('ฐานข้อมูลขัดข้อง', 502); }
  const j = await r.json();
  tok = j.access_token; tokExp = Date.now() + j.expires_in * 1000;
  return tok;
}

async function sf(path, opt) {
  const r = await fetch(API + env.SHEET_ID + path, Object.assign({}, opt, {
    headers: { authorization: 'Bearer ' + await gToken(), 'content-type': 'application/json' }
  }));
  if (!r.ok) { console.error('sheets', r.status, await r.text()); throw new E('ฐานข้อมูลขัดข้อง', 502); }
  return r.json();
}

const L = (t) => String.fromCharCode(64 + COLS[t].length);

async function readAll(force) {
  if (!force && cache && Date.now() - cacheAt < 8000) return cache;
  const q = Object.keys(COLS).map((t) => 'ranges=' + t + '!A2:' + L(t)).join('&');
  const d = await sf('/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&' + q);
  const o = {};
  Object.keys(COLS).forEach((t, i) => {
    o[t] = (d.valueRanges[i].values || []).map((r, j) => {
      const x = { _r: j + 2 };
      COLS[t].forEach((k, n) => { x[k] = r[n] === undefined ? '' : r[n]; });
      return x;
    });
  });
  cache = o; cacheAt = Date.now();
  return o;
}

async function append(tab, row) {
  cache = null;
  await sf('/values/' + tab + '!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { method: 'POST', body: JSON.stringify({ values: [row] }) });
}

async function setCell(a1, v) {
  cache = null;
  await sf('/values/' + a1 + '?valueInputOption=RAW', { method: 'PUT', body: JSON.stringify({ values: [[v]] }) });
}

async function init() {
  const m = await sf('?fields=sheets.properties.title');
  const have = m.sheets.map((s) => s.properties.title);
  const add = Object.keys(COLS).filter((t) => have.indexOf(t) < 0).map((t) => ({ addSheet: { properties: { title: t } } }));
  if (add.length) await sf(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: add }) });
  await sf('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data: Object.keys(COLS).map((t) => ({ range: t + '!A1', values: [COLS[t]] })) })
  });
  return { ok: true, created: add.length };
}

async function wipe(u, d) {
  const owned = d.Groups.filter((g) => g.owner === u.uid).map((g) => g.id);
  const mine = (r) => r.uid === u.uid && !r.gid;
  const rule = {
    Users: (r) => r.uid === u.uid, Groups: (r) => owned.indexOf(r.id) > -1,
    Members: (r) => r.uid === u.uid || owned.indexOf(r.gid) > -1,
    Pots: (r) => mine(r) || owned.indexOf(r.gid) > -1, Tx: (r) => mine(r) || owned.indexOf(r.gid) > -1,
    Budgets: (r) => r.uid === u.uid, Debts: (r) => r.uid === u.uid
  };
  const m = await sf('?fields=sheets.properties(sheetId,title)');
  const reqs = [];
  m.sheets.forEach((s) => {
    const t = s.properties.title;
    if (!rule[t]) return;
    d[t].filter(rule[t]).map((r) => r._r).sort((a, b) => b - a).forEach((r) => {
      reqs.push({ deleteDimension: { range: { sheetId: s.properties.sheetId, dimension: 'ROWS', startIndex: r - 1, endIndex: r } } });
    });
  });
  cache = null;
  if (reqs.length) await sf(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: reqs }) });
}

// ---------- Auth, validation, helpers ----------
async function auth(req) {
  const t = (req.get('authorization') || '').replace(/^Bearer /, '');
  if (!t) throw new E('กรุณาเข้าสู่ระบบ', 401);
  let c = idc.get(t);
  if (!c || c.exp < Date.now() / 1000) {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(t));
    if (!r.ok) throw new E('เซสชันหมดอายุ ให้เข้าสู่ระบบใหม่', 401);
    const j = await r.json();
    if (j.aud !== env.GOOGLE_CLIENT_ID || String(j.email_verified) !== 'true' || !j.sub || +j.exp < Date.now() / 1000) throw new E('เข้าสู่ระบบไม่ได้', 401);
    c = { uid: j.sub, email: String(j.email).toLowerCase(), exp: +j.exp };
    if (idc.size > 500) idc.clear();
    idc.set(t, c);
  }
  return c;
}

// Plan: manual list (PRO_EMAILS) OR Users.plan='pro' with plan_until in the future (set by billing later).
function isPro(row, email) {
  const manual = String(env.PRO_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).indexOf(email) > -1;
  return manual || (!!row && row.plan === 'pro' && String(row.plan_until) > new Date().toISOString());
}
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 60);
function num(v) {
  v = Number(v);
  if (!isFinite(v) || v < 0 || v > 1e9) throw new E('จำนวนเงินไม่ถูกต้อง');
  return v;
}
const id8 = () => 'p' + crypto.randomUUID().replace(/-/g, '').slice(0, 7);
const iso = () => new Date().toISOString();
const clean = (a) => a.map((r) => { const x = Object.assign({}, r); delete x._r; delete x.uid; return x; });

function role(d, u, gid) {
  const m = d.Members.find((x) => x.gid === gid && x.uid === u.uid);
  if (!m) throw new E('ไม่พบกองกลางนี้', 404);
  return m.role;
}
function canWrite(d, u, gid) { if (role(d, u, gid) === 'view') throw new E('คุณมีสิทธิ์ดูอย่างเดียว', 403); }

function view(u, d) {
  const me = d.Users.find((x) => x.uid === u.uid);
  const mine = (r) => r.uid === u.uid && !r.gid;
  return {
    email: u.email, pro: isPro(me, u.email), limits: LIMITS[isPro(me, u.email) ? 'pro' : 'free'],
    me: {
      Pots: clean(d.Pots.filter(mine)), Tx: clean(d.Tx.filter(mine).slice(-300)),
      Budgets: clean(d.Budgets.filter((r) => r.uid === u.uid)), Debts: clean(d.Debts.filter((r) => r.uid === u.uid))
    },
    groups: d.Members.filter((m) => m.uid === u.uid).map((m) => {
      const g = d.Groups.find((x) => x.id === m.gid);
      if (!g) return null;
      return {
        id: g.id, name: g.name, role: m.role, Pots: clean(d.Pots.filter((p) => p.gid === g.id)),
        Tx: clean(d.Tx.filter((t) => t.gid === g.id).slice(-300)),
        members: m.role === 'owner' ? d.Members.filter((x) => x.gid === g.id).map((x) => ({ email: x.email, role: x.role })) : undefined
      };
    }).filter(Boolean)
  };
}

// ---------- Express ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => { res.set({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); next(); });
const r = express.Router();
const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).then((o) => res.json(o)).catch((e) => {
  if (!(e instanceof E)) console.error(e);
  res.status(e instanceof E ? e.s : 500).json({ error: e instanceof E ? e.message : 'เกิดข้อผิดพลาด' });
});

// Authenticated + consented context for every route below
const ctx = (opts) => async (req, res, next) => {
  try {
    req.u = await auth(req);
    req.d = await readAll();
    req.me = req.d.Users.find((x) => x.uid === req.u.uid);
    if (!req.me && !(opts && opts.noConsent)) {
      if (req.path === '/load') return res.json({ needsConsent: true, email: req.u.email });
      throw new E('ต้องยอมรับนโยบายความเป็นส่วนตัวก่อน', 403);
    }
    if (req.me) { // auto-link pending family invites by verified email
      const pend = req.d.Members.filter((m) => !m.uid && String(m.email).toLowerCase() === req.u.email);
      for (const m of pend) { await setCell('Members!B' + m._r, req.u.uid); m.uid = req.u.uid; }
    }
    req.fresh = async () => { cache = null; return view(req.u, await readAll(true)); };
    next();
  } catch (e) {
    res.status(e instanceof E ? e.s : 500).json({ error: e instanceof E ? e.message : 'เกิดข้อผิดพลาด' });
  }
};

r.post('/init', h(async (req) => {
  if (!env.ADMIN_KEY || req.get('x-admin-key') !== env.ADMIN_KEY) throw new E('ไม่อนุญาต', 403);
  return init();
}));
r.get('/load', ctx(), h((req) => view(req.u, req.d)));
r.post('/consent', ctx({ noConsent: true }), h(async (req) => {
  if (!req.me) await append('Users', [req.u.uid, req.u.email, iso(), iso(), '', '']);
  return req.fresh();
}));

r.post('/tx', ctx(), h(async (req) => {
  const { u, d } = req, b = req.body;
  const gid = str(b.gid, 8), pot = str(b.pot, 8), ref = str(b.ref, 40);
  if (gid) canWrite(d, u, gid);
  if (pot) {
    const pt = d.Pots.find((x) => x.id === pot);
    if (!pt || pt.gid !== gid || (!gid && pt.uid !== u.uid)) throw new E('ไม่พบกระเป๋า');
  }
  if (['in', 'out'].indexOf(b.type) < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || isNaN(Date.parse(b.date)) || !num(b.amount)) throw new E('ข้อมูลไม่ครบ');
  if (ref && d.Tx.some((t) => String(t.ref) === ref && (gid ? t.gid === gid : t.uid === u.uid && !t.gid))) throw new E('สลิปนี้เคยบันทึกแล้ว', 409);
  await append('Tx', [id8(), u.uid, gid, pot, b.date, b.type, num(b.amount), str(b.category, 40), str(b.note, 100), ref, iso()]);
  return req.fresh();
}));

r.post('/pot', ctx(), h(async (req) => {
  const b = req.body, gid = str(b.gid, 8);
  if (gid) canWrite(req.d, req.u, gid);
  if (!str(b.name)) throw new E('ใส่ชื่อกระเป๋า');
  await append('Pots', [id8(), req.u.uid, gid, str(b.name, 40), num(b.target || 0), iso()]);
  return req.fresh();
}));

r.post('/budget', ctx(), h(async (req) => {
  const cat = str(req.body.category, 40), lim = num(req.body.limit);
  if (!cat) throw new E('ใส่ชื่อหมวด');
  const row = req.d.Budgets.find((x) => x.uid === req.u.uid && x.category === cat);
  if (row) await setCell('Budgets!C' + row._r, lim); else await append('Budgets', [req.u.uid, cat, lim]);
  return req.fresh();
}));

r.post('/debt', ctx(), h(async (req) => {
  const b = req.body;
  if (!str(b.name)) throw new E('ใส่ชื่อรายการ');
  await append('Debts', [id8(), req.u.uid, str(b.name, 40), num(b.balance), num(b.monthly), Math.min(31, Math.max(1, parseInt(b.due, 10) || 1))]);
  return req.fresh();
}));

r.post('/group/create', ctx(), h(async (req) => {
  const lim = LIMITS[isPro(req.me, req.u.email) ? 'pro' : 'free'];
  if (!str(req.body.name)) throw new E('ใส่ชื่อกองกลาง');
  if (req.d.Groups.filter((g) => g.owner === req.u.uid).length >= lim.groups) throw new E('สร้างกองกลางได้สูงสุด ' + lim.groups + ' กองในแพ็กเกจของคุณ', 403);
  const gid = id8();
  await append('Groups', [gid, req.u.uid, str(req.body.name, 40), iso()]);
  await append('Members', [gid, req.u.uid, req.u.email, 'owner']);
  return req.fresh();
}));

r.post('/group/invite', ctx(), h(async (req) => {
  const { u, d } = req, gid = str(req.body.gid, 8), mail = str(req.body.email, 100).toLowerCase();
  if (role(d, u, gid) !== 'owner') throw new E('เฉพาะเจ้าของเชิญได้', 403);
  const lim = LIMITS[isPro(req.me, u.email) ? 'pro' : 'free'];
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new E('อีเมลไม่ถูกต้อง');
  if (['edit', 'view'].indexOf(req.body.role) < 0) throw new E('สิทธิ์ไม่ถูกต้อง');
  if (d.Members.filter((m) => m.gid === gid).length >= lim.members) throw new E('สมาชิกเต็มตามแพ็กเกจของคุณ (' + lim.members + ' คน)', 403);
  if (d.Members.some((m) => m.gid === gid && String(m.email).toLowerCase() === mail)) throw new E('เชิญคนนี้แล้ว');
  await append('Members', [gid, '', mail, req.body.role]);
  return req.fresh();
}));

r.post('/account/delete', ctx(), h(async (req) => {
  if (req.body.confirm !== true) throw new E('ต้องยืนยันการลบ');
  await wipe(req.u, req.d);
  return { deleted: true };
}));

app.use(['/api', '/.netlify/functions/api'], r);
app.use((req, res) => res.status(404).json({ error: 'ไม่พบเส้นทาง' }));

module.exports.handler = serverless(app);
module.exports.app = app; // for local testing
