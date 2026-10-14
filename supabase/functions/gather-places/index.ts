// Nesto gathering engine — Google Places adapter.
// POST /functions/v1/gather-places
//   Headers: x-engine-secret: <NESTO_ENGINE_SECRET>
//   Body:    { "town": "Munsiyari", "region_group": "Munsiyari / Chaukori", "max_results": 20 }
// Env: GOOGLE_PLACES_API_KEY (set via `supabase secrets set`)
//
// Pipeline: fetch (Places Text Search) -> normalize -> dedup -> stage.
// New rows land with pipeline_status='not_contacted' and public_visibility=false:
// nothing reaches guests until an admin approves it in the ingestion queue.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getServiceClient, requireEngineSecret, json } from "../_shared/supabase.ts";
import { normalizePhone, decideDedup, type ExistingListing } from "../_shared/dedup.ts";

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.photos",
  "nextPageToken",
].join(",");

interface PlaceResult {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  photos?: { name: string }[];
}

async function searchPlaces(town: string, maxResults: number, apiKey: string): Promise<PlaceResult[]> {
  const out: PlaceResult[] = [];
  let pageToken: string | undefined;
  // deno-lint-ignore no-constant-condition
  while (true) {
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: `homestay in ${town}, Uttarakhand, India`,
        pageSize: Math.min(20, maxResults - out.length),
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Places API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    out.push(...(data.places ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken || out.length >= maxResults) break;
    await new Promise((r) => setTimeout(r, 2000)); // nextPageToken needs a short warm-up
  }
  return out.slice(0, maxResults);
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

  const apiKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!apiKey) return json({ error: "GOOGLE_PLACES_API_KEY is not configured" }, 500);

  const body = await req.json().catch(() => ({}));
  const town = String(body.town ?? "").trim();
  const region_group = String(body.region_group ?? "").trim() || town;
  const max_results = Math.min(Math.max(Number(body.max_results) || 20, 1), 60);
  if (!town) return json({ error: '"town" is required' }, 400);

  const supabase = getServiceClient();
  const report = {
    town,
    region_group,
    fetched: 0,
    inserted: 0,
    skipped_exact: 0,
    queued_fuzzy: 0,
    errors: [] as string[],
  };

  // 1. Fetch candidates
  let places: PlaceResult[];
  try {
    places = await searchPlaces(town, max_results, apiKey);
  } catch (e) {
    return json({ error: "places fetch failed", detail: (e as Error).message }, 502);
  }
  report.fetched = places.length;

  // 2. Load existing listings for dedup
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
      .filter((r) => r.ingest_source === "places_api" && r.ingest_external_id)
      .map((r) => r.ingest_external_id as string),
  );

  let legacyId = await nextLegacyFloor(supabase);

  // 3. Dedup + stage
  for (const p of places) {
    const name = p.displayName?.text?.trim() || "Unnamed stay";
    try {
      const phone = normalizePhone(p.nationalPhoneNumber || p.internationalPhoneNumber || "");
      const decision = decideDedup({ name, town, phone, externalId: p.id }, existing, externalIds);

      if (decision.kind === "exact_external_id" || decision.kind === "exact_phone") {
        report.skipped_exact++;
        continue;
      }

      if (decision.kind === "fuzzy") {
        const { error: qErr } = await supabase.from("ingest_review_queue").insert({
          ingest_source: "places_api",
          ingest_external_id: p.id,
          candidate_name: name,
          candidate_town: town,
          candidate_phone: phone || null,
          possible_duplicate_id: decision.duplicateId,
          match_reason: decision.reason,
          ingest_raw: p,
        });
        if (qErr) report.errors.push(`${name}: review-queue insert failed: ${qErr.message}`);
        else report.queued_fuzzy++;
        continue;
      }

      // Stage as a new unverified row. public_visibility=false: admin-only until approved.
      // NOTE (P0-3 from design review): the phone below comes from Google Places, not the
      // host — it must keep an "unconfirmed contact" caveat until the host claims/verifies.
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
          `${name} was found in ${town} via Google Places. Nesto has not yet spoken to the host, ` +
          `so details, price and availability are unconfirmed.`,
        photo_path: "assets/stay-placeholder.jpg", // frontend must handle the placeholder
        tags: ["unverified-find"],
        source_url: p.websiteUri ?? null,
        source_label: "Google Places",
        booking_verified: false,
        photo_verified: false,
        nesto_verified: false,
        contacts: phone
          ? [{ display: p.nationalPhoneNumber, number: p.internationalPhoneNumber || p.nationalPhoneNumber, type: "call" }]
          : [],
        owner_contact_digits: phone || null,
        pipeline_status: "not_contacted",
        ingest_source: "places_api",
        ingest_external_id: p.id,
        public_visibility: false,
        ingest_raw: p,
      }).select("id").single();
      if (insErr) {
        report.errors.push(`${name}: insert failed: ${insErr.message}`);
        continue;
      }
      report.inserted++;
      existing.push({ id: inserted.id as string, name, town, phones: phone ? [phone] : [] });
      externalIds.add(p.id);
    } catch (e) {
      report.errors.push(`${name}: ${(e as Error).message}`);
    }
  }

  return json(report, 200);
});
