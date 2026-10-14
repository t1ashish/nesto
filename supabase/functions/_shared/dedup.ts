// Shared: dedup rules for the gathering engine. Pure functions — no I/O,
// so the same logic can be unit-tested and reused by every source adapter.
//
// Tier 1 (exact): normalized phone digits match an existing row -> SKIP silently.
// Tier 2 (fuzzy): name similarity >= 0.6 AND town match -> REVIEW QUEUE (never
// auto-insert, never auto-skip). Everything else -> INSERT as a new staged row.

const NAME_SUFFIXES = [
  "homestay", "home stay", "homestays", "resort", "resorts",
  "cottage", "cottages", "villa", "villas", "stay", "stays",
  "inn", "lodge", "retreat", "camp", "cabin", "cabins",
];

/** "+91 78951 85666" -> "7895185666". Returns "" when not a plausible 10-digit Indian mobile. */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  let d = String(raw).replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d.length === 10 ? d : "";
}

export function normalizeName(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  for (const suf of NAME_SUFFIXES) {
    s = s.replace(new RegExp(`\\b${suf}\\b`, "g"), "");
  }
  return s.replace(/\s+/g, " ").trim();
}

export function normalizeTown(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(s: string): Set<string> {
  return new Set(s.split(" ").filter(Boolean));
}

/** Token similarity of normalized names, 0..1.
 *  Uses max(Jaccard, containment): containment catches "Shivaya Homestay" vs
 *  "SHIVAYA since 1953" (one token set subsumes the other), while Jaccard
 *  keeps long-vs-short names honest. */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(normalizeName(a));
  const tb = tokens(normalizeName(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  const containment = inter / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment);
}

/**
 * Towns match when one normalized form contains the other.
 * Handles "Mukteshwar · Chauli ki Jali" (stored) vs "Mukteshwar" (candidate).
 */
export function townsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeTown(a);
  const nb = normalizeTown(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

export interface ExistingListing {
  id: string;
  name: string;
  town: string;
  phones: string[]; // normalized 10-digit strings
}

export type DedupDecision =
  | { kind: "exact_external_id" }
  | { kind: "exact_phone" }
  | { kind: "fuzzy"; duplicateId: string; reason: string }
  | { kind: "new" };

export const FUZZY_NAME_THRESHOLD = 0.6;

export function decideDedup(
  candidate: { name: string; town: string; phone: string; externalId: string },
  existing: ExistingListing[],
  externalIds: Set<string>,
): DedupDecision {
  if (candidate.externalId && externalIds.has(candidate.externalId)) {
    return { kind: "exact_external_id" };
  }
  if (candidate.phone) {
    for (const row of existing) {
      if (row.phones.includes(candidate.phone)) return { kind: "exact_phone" };
    }
  }
  let best: { row: ExistingListing; sim: number } | null = null;
  for (const row of existing) {
    if (!townsMatch(candidate.town, row.town)) continue;
    const sim = nameSimilarity(candidate.name, row.name);
    if (sim >= FUZZY_NAME_THRESHOLD && (!best || sim > best.sim)) {
      best = { row, sim };
    }
  }
  if (best) {
    return {
      kind: "fuzzy",
      duplicateId: best.row.id,
      reason:
        `name similarity ${best.sim.toFixed(2)} (threshold ${FUZZY_NAME_THRESHOLD}) + town match: ` +
        `candidate "${candidate.name}" / "${candidate.town}" vs ` +
        `existing "${best.row.name}" / "${best.row.town}"`,
    };
  }
  return { kind: "new" };
}
