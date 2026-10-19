// Nesto gathering engine — OpenStreetMap adapter (no API key needed).
// POST /functions/v1/gather-osm
//   Headers: x-engine-secret: <NESTO_ENGINE_SECRET>
//   Body:    { "town": "Mussoorie", "region_group": "Mussoorie", "radius_m": 10000, "max_results": 50 }
// Env: none. Uses the free Nominatim geocoder (1 req/call, proper User-Agent)
//   and the Overpass API (tries 3 public mirrors in order).
//
// Pipeline: geocode -> Overpass tourism POIs -> normalize -> dedup -> stage.
// New rows land with pipeline_status='not_contacted' and public_visibility=false:
// nothing reaches guests until an admin approves it in the ingestion queue.
//
// Honest caveat: OSM is crowd-sourced. Coverage in the hills is thinner than
// Google Places and phone numbers are rare — treat every OSM find as a lead,
// not a listing.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getServiceClient, requireEngineSecret, json } from "../_shared/supabase.ts";
import { normalizePhone, decideDedup, type ExistingListing } from "../_shared/dedup.ts";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];
const USER_AGENT = "NestoStays/1.0 (Uttarakhand homestay discovery)";

const TOURISM_VALUES = [
  "guest_house",
  "hostel",
  "hotel",
  "apartment",
  "chalet",
  "motel",
  "bed_and_breakfast",
];

// Single generic words that would pollute staging — skipped, not even queued.
const GENERIC_NAMES = new Set([
  "hotel",
  "guest house",
  "guesthouse",
  "homestay",
  "home stay",
  "lodge",
  "resort",
  "motel",
  "hostel",
]);

interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
}

async function geocodeTown(town: string): Promise<{ lat: string; lon: string } | null> {
  const url =
    `${NOMINATIM_URL}?` +
    new URLSearchParams({ q: `${town}, Uttarakhand, India`, format: "json", limit: "1" });
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();
  if (!data?.length) return null;
  return { lat: String(data[0].lat), lon: String(data[0].lon) };
}

async function fetchOsmPois(lat: string, lon: string, radiusM: number): Promise<OsmElement[]> {
  const values = TOURISM_VALUES.join("|");
  const ql =
    `[out:json][timeout:25];` +
    `(node["tourism"~"${values}"](around:${radiusM},${lat},${lon});` +
    `way["tourism"~"${values}"](around:${radiusM},${lat},${lon}););` +
    `out center tags;`;
  let lastErr = "no mirrors attempted";
  for (const base of OVERPASS_URLS) {
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: new URLSearchParams({ data: ql }).toString(),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status} at ${base}`;
        continue;
      }
      const data = await res.json();
      return (data.elements ?? []) as OsmElement[];
    } catch (e) {
      lastErr = `${(e as Error).message} at ${base}`;
    }
  }
  throw new Error(`Overpass failed on all mirrors: ${lastErr}`);
}

function extractPhones(row: {
  contacts: unknown;
  owner_contact_digits: unknown;
}): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const n = normalizePhone(typeof v === "string" ? v : "");
    if (n) out.add(n);
  };
  add(row.owner_contact_digits);
  const contacts = Array.isArray(row.contacts) ? row.contacts : [];
  for (const c of contacts) add((c as { number?: unknown })?.number);
  return [...out];
}

/** Engine-inserted rows live on negative legacy_ids, clearly separated from hand seeds. */
async function nextLegacyFloor(supabase: ReturnType<typeof getServiceClient>): Promise<number> {
  const { data } = await supabase
    .from("listings")
    .select("legacy_id")
    .order("legacy_id", { ascending: true })
    .limit(1);
  const min = typeof data?.[0]?.legacy_id === "number" ? data[0].legacy_id : 0;
  return Math.min(min, 0) - 1;
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const auth = requireEngineSecret(req);
  if (auth) return auth;

  const body = await req.json().catch(() => ({}));
  const town = String(body.town ?? "").trim();
  const region_group = String(body.region_group ?? "").trim() || town;
  const radius_m = Math.min(Math.max(Number(body.radius_m) || 10000, 1000), 50000);
  const max_results = Math.min(Math.max(Number(body.max_results) || 50, 1), 200);
  if (!town) return json({ error: '"town" is required' }, 400);

  const supabase = getServiceClient();
  const report = {
    town,
    region_group,
    radius_m,
    fetched: 0,
    skipped_generic: 0,
    skipped_no_name: 0,
    inserted: 0,
    skipped_exact: 0,
    queued_fuzzy: 0,
    errors: [] as string[],
  };

  // 1. Geocode the town (Nominatim, 1 request)
  let geo: { lat: string; lon: string } | null;
  try {
    geo = await geocodeTown(town);
  } catch (e) {
    return json({ error: "geocode failed", detail: (e as Error).message }, 502);
  }
  if (!geo) return json({ error: `town not found: ${town}` }, 400);

  // 2. Fetch tourism POIs (Overpass, with mirror fallback)
  let elements: OsmElement[];
  try {
    elements = await fetchOsmPois(geo.lat, geo.lon, radius_m);
  } catch (e) {
    return json({ error: "overpass fetch failed", detail: (e as Error).message }, 502);
  }
  report.fetched = elements.length;

  // 3. Load existing listings for dedup
  const { data: rows, error: readErr } = await supabase
    .from("listings")
    .select("id, name, town, contacts, owner_contact_digits, ingest_source, ingest_external_id");
  if (readErr) return json({ error: "db read failed", detail: readErr.message }, 500);

  const existing: ExistingListing[] = (rows ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    town: r.town as string,
    phones: extractPhones(r as { contacts: unknown; owner_contact_digits: unknown }),
  }));
  const externalIds = new Set(
    (rows ?? [])
      .filter((r) => r.ingest_source === "osm" && r.ingest_external_id)
      .map((r) => r.ingest_external_id as string),
  );

  let legacyId = await nextLegacyFloor(supabase);

  // 4. Dedup + stage
  for (const el of elements.slice(0, max_results)) {
    const tags = el.tags ?? {};
    const name = (tags.name ?? "").trim();
    if (!name) {
      report.skipped_no_name++;
      continue;
    }
    if (GENERIC_NAMES.has(name.toLowerCase())) {
      report.skipped_generic++;
      continue;
    }
    const externalId = `osm:${el.type}/${el.id}`;
    try {
      const phone = normalizePhone(tags.phone || tags["contact:phone"] || "");
      const website = tags.website || tags["contact:website"] || "";
      const decision = decideDedup({ name, town, phone, externalId }, existing, externalIds);

      if (decision.kind === "exact_external_id" || decision.kind === "exact_phone") {
        report.skipped_exact++;
        continue;
      }

      if (decision.kind === "fuzzy") {
        const { error: qErr } = await supabase.from("ingest_review_queue").insert({
          ingest_source: "osm",
          ingest_external_id: externalId,
          candidate_name: name,
          candidate_town: town,
          candidate_phone: phone || null,
          possible_duplicate_id: decision.duplicateId,
          match_reason: decision.reason,
          ingest_raw: el,
        });
        if (qErr) report.errors.push(`${name}: review-queue insert failed: ${qErr.message}`);
        else report.queued_fuzzy++;
        continue;
      }

      // Stage as a new unverified row. public_visibility=false: admin-only until approved.
      // NOTE: OSM data is crowd-sourced — the phone below (when present) is not
      // host-confirmed and must keep an "unconfirmed contact" caveat until verified.
      const { data: inserted, error: insErr } = await supabase.from("listings").insert({
        legacy_id: legacyId--,
        name,
        town,
        region: region_group,
        region_group,
        price_display: "Price not confirmed",
        price_note: "Rate to be confirmed with the host.",
        position: `A stay found in ${town} — details not yet confirmed by the host.`,
        description:
          `${name} was found in ${town} via OpenStreetMap. Nesto has not yet spoken to the host, ` +
          `so details, price and availability are unconfirmed.`,
        photo_path: "assets/stay-placeholder.jpg", // frontend must handle the placeholder
        tags: ["unverified-find", "osm"],
        source_url: website || null,
        source_label: "OpenStreetMap",
        booking_verified: false,
        photo_verified: false,
        nesto_verified: false,
        contacts: phone
          ? [{ display: tags.phone || tags["contact:phone"], number: phone, type: "call" }]
          : [],
        owner_contact_digits: phone || null,
        pipeline_status: "not_contacted",
        ingest_source: "osm",
        ingest_external_id: externalId,
        public_visibility: false,
        ingest_raw: el,
      }).select("id").single();
      if (insErr) {
        report.errors.push(`${name}: insert failed: ${insErr.message}`);
        continue;
      }
      report.inserted++;
      existing.push({ id: inserted.id as string, name, town, phones: phone ? [phone] : [] });
      externalIds.add(externalId);
    } catch (e) {
      report.errors.push(`${name}: ${(e as Error).message}`);
    }
  }

  return json(report, 200);
});
