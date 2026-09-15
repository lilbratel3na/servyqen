/**
 * The agent-facing API lives on the Convex deployment, not on this Vite
 * host — point machine/API links there. Convex HTTP actions are served on
 * the .convex.site host (the .convex.cloud host serves client RPC). This
 * URL is public and carries no secrets.
 *
 * Shared by Landing and Dashboard so machine/API links can never drift back
 * to relative Vite-host paths (which serve the SPA bundle, not JSON).
 */
const CONVEX_URL = (import.meta.env.VITE_CONVEX_URL as string) ?? "";

export const API_BASE = CONVEX_URL.includes(".convex.cloud")
  ? CONVEX_URL.replace(".convex.cloud", ".convex.site")
  : CONVEX_URL;
