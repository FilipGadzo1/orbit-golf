/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional WebSocket/HTTP server URL for split static-client + server deployments. */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
