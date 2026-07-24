/**
 * Multiplayer runs entirely on Supabase Realtime (Presence + Broadcast) — no game server.
 * These are the same public env vars the rest of the user's Supabase apps use; the
 * publishable/anon key is safe to ship in the client.
 */
// `import.meta.env` is injected by Vite in the browser build, but is undefined under the
// plain-Node esbuild bundle the tests use — hence the optional chaining.
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
export const SUPABASE_URL = (env.VITE_SUPABASE_URL ?? '').trim();
export const SUPABASE_KEY = (env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY ?? '').trim();

/** True when both env vars are present, so the UI can explain why multiplayer is off. */
export function isMultiplayerConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_KEY.length > 0 && !SUPABASE_URL.includes('localhost');
}
