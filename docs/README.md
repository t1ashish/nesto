# Nesto frontend — guest-facing site

Live customer page. No build step — pure HTML/CSS/JS, deployable to GitHub Pages,
Vercel, Netlify, or any static host.

```
frontend/
├── index.html   # page structure: header, search, filters, grid, sections, detail modal
├── styles.css   # Nesto design system (Nunito 900 italic + Manrope, ocean blue + golden yellow)
├── config.js    # <-- PUT YOUR SUPABASE ANON KEY HERE (and owner WhatsApp number)
├── i18n.js      # English + Hindi UI strings
└── app.js       # Supabase data layer, filters, detail views, WhatsApp flows
```

## Setup (2 minutes)

1. Open `config.js` and paste your Supabase **anon public** key
   (Supabase dashboard → Project Settings → API). The anon key is safe in browser code.
2. Optionally set `OWNER_WHATSAPP` (e.g. `"919876543210"`) to enable
   "Claim now", "Become a host", referrals, and partnership applications.
3. Open `index.html` — listings load live from Supabase on every visit.

## What it does

- **Live data:** fetches the `listings` table via PostgREST on every load
  (respects `public_visibility=false` — those rows never render).
- **Browse:** search, 12 region chips (derived from your data), vibe filters,
  verified-only toggle, sort (Recommended = verified-first, price ↑↓, newest).
- **Honest cards:** Nesto Verified badge with its one-line definition;
  unverified listings carry the honest label + "Are you the host? Claim now" strip.
  No invented "14% higher" claims — price notes are Echo's approved rewrites.
- **WhatsApp-first booking:** date picker → opens WhatsApp to the host with a
  prefilled request. Framed honestly ("Opening WhatsApp — send the message…"),
  never a fake "Request sent".
- **Detail views:** photo, amenities, meals, know-before-you-go, host profile,
  guest-review links, host contact buttons, claim banner on unverified rows.
- **Bilingual:** EN/हिन्दी toggle for the full UI chrome.
- **Sections:** How Nesto earns, Our Story/Vision, Become a Host, Refer a Host,
  Partner with Us, footer.

## Deploy

Push this repo to GitHub → Settings → Pages → deploy from `/frontend`
(or connect the repo to Vercel/Netlify). No build command needed.
