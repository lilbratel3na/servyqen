/**
 * TEMPORARY DIAGNOSTIC — reload root-cause investigation only.
 * Remove this file and its main.tsx call once the reload issue is resolved.
 *
 * Records lightweight interaction breadcrumbs into sessionStorage (which
 * survives document reloads), then — when the document loads as a
 * reload/back-forward navigation with prior breadcrumbs — renders a small
 * on-device panel showing the navigation type and the last events before
 * the reload. This distinguishes:
 *   A. real browser/document reload (nav type "reload")
 *   B. React remount (no nav entry — panel never appears)
 *   C. router navigation to "/" (nav type "navigate", pathname "/")
 *   D. runtime exception (error/rejection breadcrumb present)
 *   F. platform/dev-server reload (reload with no user-gesture breadcrumb)
 */

const KEY = "pf-reload-diag-v1";

type Breadcrumb = { t: number; e: string };

function read(): Breadcrumb[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as Breadcrumb[];
  } catch {
    return [];
  }
}

function push(e: string) {
  try {
    const arr = read();
    arr.push({ t: Date.now(), e });
    sessionStorage.setItem(KEY, JSON.stringify(arr.slice(-30)));
  } catch {
    /* storage unavailable — diagnostics inert */
  }
}

function showPanel(navType: string, before: Breadcrumb[]) {
  const panel = document.createElement("div");
  panel.setAttribute("data-pf-diag", "true");
  panel.style.cssText = [
    "position:fixed",
    "left:8px",
    "right:8px",
    "bottom:8px",
    "z-index:2147483000",
    "background:#111827",
    "color:#e2e8f0",
    "border:1px solid #334155",
    "border-radius:10px",
    "padding:10px 12px",
    "font:11px/1.5 ui-monospace,monospace",
    "box-shadow:0 8px 24px rgba(0,0,0,.5)",
  ].join(";");

  const lastT = before.length ? before[before.length - 1].t : Date.now();
  const lines = before
    .slice(-6)
    .map((b) => `${((lastT - b.t) / 1000).toFixed(1)}s  ${b.e}`)
    .join("<br>");

  panel.innerHTML =
    `<b style="color:#7dd3fc">Reload diagnostic</b> · nav: <b>${navType}</b>` +
    (lines ? `<br>before unload:<br>${lines}` : "<br>no breadcrumbs captured") +
    `<br><span style="color:#94a3b8">tap to dismiss</span>`;

  panel.addEventListener("click", () => panel.remove());
  document.body.appendChild(panel);
}

export function initReloadDiagnostics() {
  if (typeof window === "undefined") return;

  try {
    const nav = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming | undefined;
    const navType = nav?.type ?? "unknown";
    const before = read();

    if ((navType === "reload" || navType === "back_forward") && before.length) {
      const boot = () => showPanel(navType, before);
      if (document.body) boot();
      else document.addEventListener("DOMContentLoaded", boot, { once: true });
    }

    // Fresh breadcrumb stream for the current document lifetime.
    sessionStorage.setItem(KEY, JSON.stringify([]));
    push(`boot:${navType}:${window.location.pathname}`);
  } catch {
    return;
  }

  window.addEventListener("error", (ev) =>
    push(`error:${String(ev.message).slice(0, 120)}`),
  );
  window.addEventListener("unhandledrejection", (ev) =>
    push(`rejection:${String(ev.reason).slice(0, 120)}`),
  );
  window.addEventListener(
    "scroll",
    () => push(`scroll:${Math.round(window.scrollY)}`),
    { passive: true },
  );
  window.addEventListener(
    "pointerdown",
    (ev) => {
      const el = ev.target as HTMLElement | null;
      push(`tap:${el?.tagName ?? "?"}:${el?.textContent?.trim().slice(0, 20) ?? ""}`);
    },
    { passive: true },
  );
  window.addEventListener("visibilitychange", () =>
    push(`vis:${document.visibilityState}`),
  );
  window.addEventListener("pagehide", () => push("pagehide"));
}
