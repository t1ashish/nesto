# Nesto Platform

Code home for Nesto Stays: the listing-gathering engine on Supabase,
the database migrations, and (soon) the frontend.

```
nesto-platform/
├── supabase/
│   ├── config.toml                  # edge function config
│   ├── migrations/
│   │   └── 20261014_add_ingest_columns.sql   # ingest columns + review queue (run in SQL editor)
│   ├── scheduled/
│   │   └── gather-weekly.sql        # optional pg_cron schedule (extensions first)
│   └── functions/
│       ├── _shared/
│       │   ├── supabase.ts          # service client + x-engine-secret auth
│       │   └── dedup.ts             # phone/name+town dedup rules (pure, testable)
│       ├── gather-places/          # Google Places town sweep -> staged listings (needs API key)
│       ├── gather-registry/        # tourism registry CSV import -> staged listings (no key)
│       └── gather-osm/             # OpenStreetMap town sweep -> staged listings (no key, free)
└── frontend/                        # guest site — LIVE, no build step (index.html + styles.css + config.js + i18n.js + app.js)
```

## How the engine works

`fetch -> normalize -> dedup -> stage -> (admin approves) -> live`

- **Dedup tier 1 (exact):** normalized phone digits match an existing row → skipped silently.
- **Dedup tier 2 (fuzzy):** name similarity ≥ 0.6 + town match → goes to the
  `ingest_review_queue` table for human review (never auto-inserted, never auto-skipped).
- **Stage:** new rows land with `pipeline_status='not_contacted'` and
  `public_visibility=false` — admin-only until approved. Engine rows use negative
  `legacy_id`s so they're clearly separated from the 28 hand-built seeds.

## Deploy

1. `supabase link --project-ref <your-project-ref>`
2. `supabase secrets set GOOGLE_PLACES_API_KEY=<key> NESTO_ENGINE_SECRET=<pick-a-long-random-string>`
3. Run `supabase/migrations/20261014_add_ingest_columns.sql` in the SQL editor.
4. `supabase functions deploy gather-places` and `supabase functions deploy gather-registry`
5. Test:
   ```bash
   curl -X POST https://<project-ref>.supabase.co/functions/v1/gather-places \
     -H "Content-Type: application/json" \
     -H "x-engine-secret: <NESTO_ENGINE_SECRET>" \
     -d '{"town":"Munsiyari","region_group":"Munsiyari / Chaukori","max_results":20}'
   ```
   Response: `{ town, fetched, inserted, skipped_exact, queued_fuzzy, errors }`.
6. Optional: schedule it with the SQL in `supabase/scheduled/gather-weekly.sql`
   (enable `pg_cron` + `pg_net` extensions first).

## Secrets

- `GOOGLE_PLACES_API_KEY` and `NESTO_ENGINE_SECRET` live in Supabase secrets only.
- The Supabase **service-role key** is injected by the platform into functions —
  it never appears in this repo, in chat, or in browser code.
