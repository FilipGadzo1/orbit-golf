/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL — powers multiplayer via Realtime. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase publishable (anon) key. Safe to ship in the client. */
  readonly VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
