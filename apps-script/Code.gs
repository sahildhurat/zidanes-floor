/**
 * Murder on Zidane's Floor — club backend for the GitHub Pages site.
 *
 * Lives in a Google Sheet you own (Extensions → Apps Script) and is deployed as a web app.
 * It stores the club's GW lineups, member-list changes and votes in this spreadsheet,
 * and reads FPL team screenshots with Claude using your Anthropic API key.
 *
 * Script properties (Project Settings → Script properties):
 *   CLUB_CODE          code the boys type once per device before they can save, vote or upload (recommended)
 *   ANTHROPIC_API_KEY  your key from console.anthropic.com (needed only for screenshot reading)
 *   MODEL              optional, defaults to claude-sonnet-5-5
 *   READ_LIMIT         optional, screenshot reads allowed per day (default 60)
 */

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const TABS = {
  plans: ['manager_id', 'lineup_json', 'updated'],
  roster: ['key', 'value_json', 'updated'],
  votes: ['vote_id', 'gameweek', 'voter', 'goalkeeper', 'strikers', 'bench', 'submitted', 'vote_json']
};

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'ping') {
    return out({ ok: true, codeRequired: !!prop_('CLUB_CODE'), canRead: !!prop_('ANTHROPIC_API_KEY'), readsLeft: readsLeft_() });
  }
  return out(Object.assign({ ok: true }, state_()));
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, code: 'bad_request' }); }
  const code = prop_('CLUB_CODE');
  if (code && norm_(body.code) !== norm_(code)) return out({ ok: false, code: 'bad_code' });
  try {
    switch (body.action) {
      case 'check': return out({ ok: true, canRead: !!prop_('ANTHROPIC_API_KEY'), readsLeft: readsLeft_() });
      case 'patch': return out(patch_(body));
      case 'vote': return out(vote_(body));
      case 'read': return out(readShot_(body));
      default: return out({ ok: false, code: 'bad_request' });
    }
  } catch (err) {
    return out({ ok: false, code: 'server_error', message: String((err && err.message) || err).slice(0, 300) });
  }
}

/* ---------- state ---------- */

function state_() {
  const plans = {};
  rows_('plans').forEach(r => { if (r[0] !== '') plans[String(r[0])] = parse_(r[1]); });
  const roster = {};
  rows_('roster').forEach(r => { if (r[0] !== '') roster[String(r[0])] = parse_(r[1]); });
  const votes = rows_('votes').slice(-400).map(r => {
    const v = parse_(r[7]);
    return v && typeof v === 'object' ? Object.assign({ _id: String(r[0]) }, v) : null;
  }).filter(Boolean);
  return { rev: Number(prop_('REV') || 0), plans: plans, roster: roster, votes: votes };
}

function patch_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const plans = body.plans || {};
    Object.keys(plans).forEach(mid => {
      if (!/^\d{1,9}$/.test(mid)) throw new Error('bad manager id');
      const json = JSON.stringify(plans[mid] === undefined ? null : plans[mid]);
      if (json.length > 20000) throw new Error('lineup too large');
      upsert_('plans', mid, [mid, json, new Date()]);
    });
    const roster = body.roster || {};
    ['pending', 'hidden'].forEach(k => {
      if (roster[k] === undefined) return;
      if (!Array.isArray(roster[k]) || roster[k].length > 60) throw new Error('bad ' + k);
      const clean = roster[k].map(String).filter(x => /^\d{1,9}$/.test(x));
      upsert_('roster', k, [k, JSON.stringify(clean), new Date()]);
    });
    bump_();
  } finally { lock.releaseLock(); }
  return Object.assign({ ok: true }, state_());
}

function vote_(body) {
  const id = String(body.id || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { ok: false, code: 'bad_request' };
  const v = body.vote || {};
  const json = JSON.stringify(v);
  if (json.length > 4000) return { ok: false, code: 'bad_request' };
  const n = body.names || {};
  const list = a => (Array.isArray(a) ? a : []).join(', ');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    upsert_('votes', id, [id, v.gw || '', n.as || v.as || '', list(n.gk || v.gk), list(n.st || v.st), list(n.bench || v.bench), new Date(), json]);
    bump_();
  } finally { lock.releaseLock(); }
  return Object.assign({ ok: true }, state_());
}

/* ---------- screenshot reading ---------- */

function readShot_(body) {
  const key = prop_('ANTHROPIC_API_KEY');
  if (!key) return { ok: false, code: 'not_declared' };
  const images = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
  const prompt = String(body.prompt || '');
  if (!images.length || prompt.length < 50 || prompt.length > 80000 || prompt.indexOf('Fantasy Premier League') < 0) return { ok: false, code: 'bad_request' };
  for (const im of images) {
    if (!/^image\/(png|jpeg|webp)$/.test(im.type || '') || typeof im.data !== 'string' || im.data.length > 6.5e6) return { ok: false, code: 'image_rejected' };
  }
  if (readsLeft_() <= 0) return { ok: false, code: 'rate_limited' };
  countRead_();

  const content = images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } }));
  content.push({ type: 'text', text: prompt });
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
    payload: JSON.stringify({ model: prop_('MODEL') || DEFAULT_MODEL, max_tokens: 2000, messages: [{ role: 'user', content: content }] })
  });
  const status = res.getResponseCode();
  if (status === 429 || status === 529) return { ok: false, code: 'rate_limited' };
  if (status === 401 || status === 403) return { ok: false, code: 'bad_key' };
  if (status >= 400) return { ok: false, code: 'server_error', message: res.getContentText().slice(0, 300) };
  const data = JSON.parse(res.getContentText());
  if (data.stop_reason === 'refusal') return { ok: false, code: 'refused' };
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!text) return { ok: false, code: 'empty_completion' };
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return { ok: false, code: 'invalid_json' };
  try { return { ok: true, json: JSON.parse(text.slice(a, b + 1)) }; } catch (err) { return { ok: false, code: 'invalid_json' }; }
}

function readsLeft_() {
  const limit = Number(prop_('READ_LIMIT') || 60);
  return Math.max(0, limit - Number(prop_(dayKey_()) || 0));
}
function countRead_() {
  const k = dayKey_();
  PropertiesService.getScriptProperties().setProperty(k, String(Number(prop_(k) || 0) + 1));
}
function dayKey_() { return 'READS_' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd'); }

/* ---------- helpers ---------- */

function out(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function norm_(s) { return String(s || '').trim().toLowerCase(); }
function parse_(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function bump_() { PropertiesService.getScriptProperties().setProperty('REV', String(Number(prop_('REV') || 0) + 1)); }

function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function rows_(name) {
  const sh = sheet_(name), n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, TABS[name].length).getValues() : [];
}
function upsert_(name, key, row) {
  const sh = sheet_(name), n = sh.getLastRow() - 1;
  if (n > 0) {
    const keys = sh.getRange(2, 1, n, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0]) === String(key)) { sh.getRange(i + 2, 1, 1, row.length).setValues([row]); return; }
    }
  }
  sh.appendRow(row);
}

/** Run once from the editor (select "setup" → Run) to create the tabs and check your settings. */
function setup() {
  Object.keys(TABS).forEach(sheet_);
  Logger.log('Club code set: %s · API key set: %s · reads left today: %s', !!prop_('CLUB_CODE'), !!prop_('ANTHROPIC_API_KEY'), readsLeft_());
}
