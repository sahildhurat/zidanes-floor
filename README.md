# Murder on Zidane's Floor — Squad Room

The SKLW FPL club page for all 16 managers: table, next-GW lineups with expected points, the lineup vote,
squads, head-to-heads and ownership.

**Site:** https://sahildhurat.github.io/zidanes-floor/

## How it works

| Part | Where it lives | Updates |
|---|---|---|
| Page | `site/index.html` (+ `site/backend.js`, `site/config.js`) | when this repo changes |
| FPL data (squads, points, fixtures, prices) | `site/data/fpl.json`, built by `scripts/sync.mjs` + `scripts/build.py` | automatically every 3 hours (GitHub Actions), or *Actions → Sync FPL data and publish → Run workflow* |
| Expected points | `raw/xp_solio.json` (Solio), `raw/xp.json` (FPL Copilot) | on request; FPL's own estimate fills in when a file is out of date |
| Saved lineups, member-list changes, votes | the club Google Sheet (`apps-script/Code.gs`, deployed as a web app) | live |
| Screenshot reading | the same web app, calling Claude with the API key stored in the Sheet's script properties | live, capped per day |

Anyone with the link can view. Saving a lineup, voting, uploading a screenshot or changing the member
list asks once per device for the club code (the `CLUB_CODE` script property in the Sheet).

## Members

`raw/club.json` lists the FPL IDs, Twitter handles and roles in display order. IDs added on the site's
**FPL IDs** screen are picked up by the next automatic sync.

## Changing the backend

Put the web app URL (ends in `/exec`) in `site/config.js`. To change the club code, the API key or the daily
screenshot limit (`READ_LIMIT`, default 60), edit the script properties in the Sheet's Apps Script project — no
redeploy needed. After editing `Code.gs`, use *Deploy → Manage deployments → Edit → New version* so the URL stays the same.
