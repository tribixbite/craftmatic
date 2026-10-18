# Deployment

Read before changing hosting, Worker routes, or deploying the web app. Corpus publishing and freshness are in [model sources](lego-sources-guide.md).

[Project guide](../CLAUDE.md). Paths in code spans are relative to the repository root unless explicitly qualified.

## Deploy

Cloudflare: static build (`web/dist`) + Worker (`worker/ldraw-omr.js`).
**`deploy.yml` publishes to TWO hosts and they are not equivalent**: the GitHub
Pages mirror (`tribixbite.github.io/craftmatic`) has no Worker in front of it,
so `/lego-models/*`, `/lego-models-index.json`, `/ldraw-parts/*`, `/ldraw-omr/*`
and `/bff/*` all 404 there — the LEGO tab can search the bundled catalog and
then load nothing. `craftmatic.click` is the supported deployment (README says
so since 2026-09-09); always ask which host a LEGO bug came from.
`wrangler.toml` routes `/ldraw-omr/*`, `/ldraw-parts/*`, `/lego-models/*`,
`/lego-models-index.json` AND (since 2026-09-02) `/bff/*` + `/seymouria-ldr/*`
to the Worker. Those last two used to live only in the CF dashboard and were
**not in effect** — `craftmatic.click/bff/inventory/21063-1` returned GitHub
Pages' 404, so the LEGO tab's last-resort source was dead in prod while fine in
dev. Declare routes in `wrangler.toml`, never only in the dashboard. Run
`bunx wrangler deploy` after changing the Worker or routes.
**The index prod serves comes from R2, NOT from the deploy** (confirmed
2026-09-18). `wrangler.toml:61` routes `craftmatic.click/lego-models-index.json`
to the Worker and `worker/ldraw-omr.js:111` reads it from the bucket, so a green
Deploy run with a freshly committed `web/public/lego-models-index.json` changes
nothing users see. `sync_models_r2.py` uploads the index LAST, after every model
file, so the index flips only when that whole run finishes — which is also what
keeps it consistent with the bytes it points at. Symptom of forgetting this:
prod keeps answering with the previous day's `generated` date and the previous
hashes while the build and the repo both look current.

**Pending deploy (2026-09-09):** `/ldraw-parts/_rev` is a new worker route and
`ldraw/_rev.json` is written by the next full `sync-ldraw-r2.mjs` run. Until
BOTH land, prod returns 404 there and every browser keeps its part cache — the
documented "unknown revision" behaviour, not a failure. `test/prod-smoke.test.ts`
accepts 200-or-404 for exactly this window; tighten it to 200 once a stamp
exists.
