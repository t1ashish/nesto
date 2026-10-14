// Shared: Supabase service client + engine auth for Edge Functions.
// The service role key never leaves Supabase — functions read it from env.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

export function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Engine endpoints are called server-to-server (Owner Console backend, pg_cron),
 * not from browsers, so we authenticate with a shared secret header instead of
 * a user JWT. Set NESTO_ENGINE_SECRET via `supabase secrets set`.
 * Returns a 401 Response when unauthorized, null when OK.
 */
export function requireEngineSecret(req: Request): Response | null {
  const expected = Deno.env.get("NESTO_ENGINE_SECRET");
  if (!expected) throw new Error("NESTO_ENGINE_SECRET is not configured");
  if (req.headers.get("x-engine-secret") !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
