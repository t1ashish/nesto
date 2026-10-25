// Nesto gathering engine — Uttarakhand tourism homestay registry adapter.
// POST /functions/v1/gather-registry
//   Headers: x-engine-secret: <NESTO_ENGINE_SECRET>
//   Body:    { "csv_text": "name,town,phone,address\n...", "region_group": "Nainital", "default_town": "" }
// The registry is the highest-trust bulk source: officially registered homestays.
// Same pipeline as gather-places: normalize -> dedup -> stage (admin-only until approved).
//
// CSV columns (header row required): name, town, phone, address, price (optional)
// Keep CSVs clean (no quoted commas) — this is a minimal parser for admin uploads.
// Price is the nightly portal price in rupees (digits only, e.g. 1200); empty or 0
// means "Price not confirmed".

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getServiceClient, requireEngineSecret, json } from "../_shared/supabase.ts";
import { normalizePhone, decideDedup, type ExistingListing } from "../_shared/dedup.ts";

interface RegistryRow {
  name: string;
  town: string;
  phone: string;
  address: string;
  price: string;
}

function parseCsv(text: string): RegistryRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (col: string) => header.indexOf(col);
  const iName = idx("name"), iTown = idx("town"), iPhone = idx("phone"), iAddr = idx("address"), iPrice = idx("price");
  if (iName < 0) throw new Error('CSV needs a header row with at least a "name" column');
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    return {
      name: cells[iName] ?? "",
      town: iTown >= 0 ? cells[iTown] ?? "" : "",
      phone: iPhone >= 0 ? cells[iPhone] ?? "" : "",
      address: iAddr >= 0 ? cells[iAddr] ?? "" : "",
      price: iPrice >= 0 ? cells[iPrice] ?? "" : "",
    };
  }).filter((r) => r.name);
}

function extractPhones(row: { contacts: unknown; owner_contact_digits: unknown }): string[] {
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
  const csv_text = String(body.csv_text ?? "");
  const region_group = String(body.region_group ?? "").trim();
  const default_town = String(body.default_town ?? "").trim();
  if (!csv_text) return json({ error: '"csv_text" is required' }, 400);
  if (!region_group) return json({ error: '"region_group" is required' }, 400);

  let rows: RegistryRow[];
  try {
    rows = parseCsv(csv_text);
  } catch (e) {
    return json({ error: "csv parse failed", detail: (e as Error).message }, 400);
  }

  const supabase = getServiceClient();
  const report = {
    parsed: rows.length,
    inserted: 0,
    skipped_exact: 0,
    queued_fuzzy: 0,
    errors: [] as string[],
  };

  const { data: existingRows, error: readErr } = await supabase
    .from("listings")
    .select("id, name, town, contacts, owner_contact_digits, ingest_source, ingest_external_id");
  if (readErr) return json({ error: "db read failed", detail: readErr.message }, 500);

  const existing: ExistingListing[] = (existingRows ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    town: r.town as string,
    phones: extractPhones(r as { contacts: unknown; owner_contact_digits: unknown }),
  }));
  // Registry rows usually have no stable external id — dedup on phone/name+town.
  const externalIds = new Set<string>();

  let legacyId = await nextLegacyFloor(supabase);

  for (const row of rows) {
    const town = row.town || default_town || region_group;
    const phone = normalizePhone(row.phone);
    // Phone-less rows MUST include town in the external id: several distinct
    // homestays share a name (e.g. four "Bisht Homestay" in different villages),
    // and a name-only id would silently drop all but the first.
    const nameSlug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const townSlug = town.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const externalId = `registry:${phone || `${nameSlug}@${townSlug}`}`;
    const priceNum = parseInt((row.price ?? "").replace(/[^0-9]/g, ""), 10);
    const hasPrice = Number.isFinite(priceNum) && priceNum > 0;
    try {
      const decision = decideDedup({ name: row.name, town, phone, externalId }, existing, externalIds);
      if (decision.kind === "exact_external_id" || decision.kind === "exact_phone") {
        report.skipped_exact++;
        continue;
      }
      if (decision.kind === "fuzzy") {
        const { error: qErr } = await supabase.from("ingest_review_queue").insert({
          ingest_source: "tourism_registry",
          ingest_external_id: externalId,
          candidate_name: row.name,
          candidate_town: town,
          candidate_phone: phone || null,
          possible_duplicate_id: decision.duplicateId,
          match_reason: decision.reason,
          ingest_raw: row,
        });
        if (qErr) report.errors.push(`${row.name}: review-queue insert failed: ${qErr.message}`);
        else report.queued_fuzzy++;
        continue;
      }
      const { data: inserted, error: insErr } = await supabase.from("listings").insert({
        legacy_id: legacyId--,
        name: row.name,
        town,
        region: region_group,
        region_group,
        price_display: hasPrice ? `₹${priceNum}` : "Price not confirmed",
        price_note: hasPrice
          ? "Nightly price as listed on the UTDB portal; the host confirms the final price."
          : "Rate to be confirmed with the host.",
        position: `A registered homestay in ${town} — details not yet confirmed by the host.`,
        description:
          `${row.name} is registered with the Uttarakhand tourism homestay registry` +
          (row.address ? ` (${row.address})` : "") +
          `. Nesto has not yet spoken to the host, so details are unconfirmed.`,
        photo_path: "assets/stay-placeholder.jpg",
        tags: ["unverified-find", "tourism-registry"],
        source_label: "Uttarakhand tourism homestay registry",
        booking_verified: false,
        photo_verified: false,
        nesto_verified: false,
        contacts: phone ? [{ display: row.phone, number: phone, type: "call" }] : [],
        owner_contact_digits: phone || null,
        pipeline_status: "not_contacted",
        ingest_source: "tourism_registry",
        ingest_external_id: externalId,
        public_visibility: false,
        ingest_raw: row,
      }).select("id").single();
      if (insErr) {
        report.errors.push(`${row.name}: insert failed: ${insErr.message}`);
        continue;
      }
      report.inserted++;
      existing.push({ id: inserted.id as string, name: row.name, town, phones: phone ? [phone] : [] });
      externalIds.add(externalId);
    } catch (e) {
      report.errors.push(`${row.name}: ${(e as Error).message}`);
    }
  }

  return json(report, 200);
});
