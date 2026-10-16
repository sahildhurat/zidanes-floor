// Pull the club's FPL data from the official FPL API into raw/catalog.json and raw/managers.json.
// Runs in GitHub Actions (node scripts/sync.mjs); scripts/build.py then merges it into site/data/fpl.json.
// Member IDs come from raw/club.json plus any IDs added on the site (the backend's "pending" list).
import { readFile, writeFile } from 'node:fs/promises';

const BASE = 'https://fantasy.premierleague.com/api';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; zidanes-floor-sync/1.0; +https://github.com/sahildhurat/zidanes-floor)', Accept: 'application/json' };

async function j(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + path, { headers: HEADERS });
      if (r.ok) return r.json();
      if (r.status === 404) return { __err: 404 };
      if (i === tries - 1) return { __err: r.status };
    } catch (e) { if (i === tries - 1) return { __err: String(e.message || e) }; }
    await new Promise(res => setTimeout(res, 1500 * (i + 1)));
  }
}

async function clubIds() {
  const club = JSON.parse(await readFile('raw/club.json', 'utf8'));
  const ids = club.map(c => c.id);
  try {
    const cfg = await readFile('site/config.js', 'utf8');
    const url = (cfg.match(/backendUrl:\s*'([^']*)'/) || [])[1];
    if (url) {
      const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'action=state');
      const s = await r.json();
      const pending = ((s.roster || {}).pending || []).map(Number).filter(n => n > 0 && !ids.includes(n));
      if (pending.length) console.log('IDs added on the site:', pending.join(', '));
      ids.push(...pending);
    }
  } catch (e) { console.log('Backend not reachable, using raw/club.json only:', e.message); }
  return ids;
}

const b = await j('/bootstrap-static/');
if (b.__err || !Array.isArray(b.events)) { console.error('FPL bootstrap failed:', b.__err || 'unexpected response'); process.exit(1); }
const cur = b.events.find(e => e.is_current) || b.events.filter(e => e.finished).pop();
const nxt = b.events.find(e => e.is_next) || null;
const live = await j(`/event/${cur.id}/live/`);
const fx = await j('/fixtures/?future=1');
if (live.__err || fx.__err) { console.error('FPL live/fixtures failed:', live.__err, fx.__err); process.exit(1); }
const gw = {}; live.elements.forEach(e => { gw[e.id] = e.stats.total_points; });
const flag = p => { if (p.status === 'a') return ''; const s = p.status; return (s === 'd' || s === 'i' || s === 's') ? (s + (p.chance_of_playing_next_round ?? '') + ':' + (p.news || '')).slice(0, 48) : s; };
const players = b.elements.map(p => [p.id, p.web_name.replace(/\|/g, '/'), p.team, p.element_type, p.now_cost, p.total_points,
  Math.round(parseFloat(p.form || 0) * 10), Math.round(parseFloat(p.selected_by_percent || 0) * 10), Math.round(parseFloat(p.ep_next || 0) * 10), gw[p.id] ?? 0, flag(p)]);
const start = nxt ? nxt.id : cur.id + 1;
const fixtures = {}; b.teams.forEach(t => { fixtures[t.id] = []; });
fx.filter(f => f.event && f.event >= start && f.event < start + 5)
  .sort((a, c) => a.event - c.event || new Date(a.kickoff_time) - new Date(c.kickoff_time))
  .forEach(f => { fixtures[f.team_h].push([f.event, f.team_a, 1, f.team_h_difficulty]); fixtures[f.team_a].push([f.event, f.team_h, 0, f.team_a_difficulty]); });
const y = b.events[0].deadline_time.slice(0, 4);
const catalog = {
  v: 1,
  meta: { season: y + '/' + (parseInt(y.slice(2), 10) + 1), gw: cur.id, gwFinished: cur.finished, gwAvg: cur.average_entry_score, gwHigh: cur.highest_score, next: nxt ? nxt.id : null, deadline: nxt ? nxt.deadline_time : null, synced: new Date().toISOString() },
  teams: b.teams.map(t => [t.id, t.short_name, t.name]), fixtures, players
};

const one = async id => {
  const e = await j(`/entry/${id}/`);
  if (e.__err) return { id, err: e.__err };
  const [h, p, t] = await Promise.all([j(`/entry/${id}/history/`), j(`/entry/${id}/event/${cur.id}/picks/`), j(`/entry/${id}/transfers/`)]);
  return {
    id, mgr: `${e.player_first_name || ''} ${e.player_last_name || ''}`.trim(), team: e.name,
    ovPts: e.summary_overall_points, ovRank: e.summary_overall_rank, bank: e.last_deadline_bank, value: e.last_deadline_value, start: e.started_event,
    hist: (h.current || []).map(x => [x.event, x.points, x.total_points, x.rank, x.overall_rank, x.event_transfers, x.event_transfers_cost, x.points_on_bench, x.value, x.bank]),
    chips: (h.chips || []).map(c => [c.name, c.event]),
    picks: p.__err ? null : p.picks.map(x => [x.element, x.position, x.multiplier, x.is_captain ? 1 : 0, x.is_vice_captain ? 1 : 0]),
    chip: p.__err ? null : (p.active_chip || null),
    subs: p.__err ? [] : (p.automatic_subs || []).map(s => [s.element_in, s.element_out]),
    tr: Array.isArray(t) ? t.filter(x => x.event === cur.id).map(x => [x.element_in, x.element_out]) : []
  };
};
const ids = await clubIds();
const managers = [];
for (let i = 0; i < ids.length; i += 4) managers.push(...await Promise.all(ids.slice(i, i + 4).map(one)));
const bad = managers.filter(m => m.err);
if (bad.length === managers.length) { console.error('Every manager failed to load; keeping the old data.'); process.exit(1); }

await writeFile('raw/catalog.json', JSON.stringify(catalog));
await writeFile('raw/managers.json', JSON.stringify(managers));
console.log(`GW${cur.id}${cur.finished ? ' (finished)' : ''}, next GW${nxt ? nxt.id : '-'}; ${players.length} players; ${managers.length} managers` + (bad.length ? `; failed: ${bad.map(m => m.id + ':' + m.err).join(', ')}` : ''));
