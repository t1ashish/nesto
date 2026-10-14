# Nesto Stays — customer page (GitHub Pages)

Live: https://t1ashish.github.io/nesto/

This folder is served by GitHub Pages (`main` branch → `/docs`).

- `index.html` — the full customer page. Ported from the approved portal mock design; loads live listings from Supabase when the page opens. Search, region/vibe filters, verified-first ranking, detail views, WhatsApp-first booking, EN/हिन्दी toggle.
- `config.js` — Supabase URL, anon key, and the owner WhatsApp number. Edit values in the GitHub web UI; never commit service-role keys here.
- `logo.png` — the Nesto brand mark used in the header and footer.

Data comes from the Supabase `listings` table through the public anon key (row-level security keeps writes closed). Only rows with `public_visibility != false` are shown.
