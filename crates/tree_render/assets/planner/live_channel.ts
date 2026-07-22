// ============================================================================
// === Live build channel (?live=<token>) ====================================
// ============================================================================
// Watch a build being authored in real time (docs/agent-builds.md §3):
// an agent (or a friend) PUTs plan revisions to /live/<token> — the
// Pages Function in viewer/functions/live/[token].ts — and this module
// polls GET with If-None-Match every ~2.5 s, re-importing on change.
//
// Capability-URL trust model: knowing the token IS the permission.
// While live, local edits are ephemeral (each remote rev re-imports);
// the LIVE badge's "take over" detaches into a normal editable plan by
// simply stopping the poll and dropping ?live from the URL.
// ============================================================================
import { state } from "./state.ts";
import { requestRender } from "./render.ts";
import { syncPulse } from "./overlay.ts";
import { focusNode } from "./cmdk.ts";
import { importAgentPlan } from "./agent_import.ts";
import type { AgentPlan } from "./agent_import.ts";

const token = new URL(location.href).searchParams.get("live");
if (token && /^[A-Za-z0-9_-]{16,64}$/.test(token)) {
  let etag: string | null = null;
  let rev = 0;
  let stopped = false;
  let failures = 0;

  // LIVE badge — fixed top-center (below the first-run hint's slot),
  // shows freshness + the take-over control.
  const badge = document.createElement("div");
  badge.className = "live-badge";
  badge.innerHTML =
    '<span class="live-dot"></span><span id="live-label">LIVE — waiting for first update…</span>' +
    '<button id="live-takeover" type="button" title="Stop following and keep an editable copy">take over</button>';
  document.getElementById("viewport")?.appendChild(badge);
  const label = badge.querySelector("#live-label") as HTMLElement;

  const stop = (reason: string): void => {
    stopped = true;
    badge.remove();
    const url = new URL(location.href);
    url.searchParams.delete("live");
    history.replaceState(null, "", url);
    window.PoE2Plan?.flash(reason);
  };
  badge.querySelector("#live-takeover")?.addEventListener("click", () =>
    stop("Detached from live channel — this copy is yours now"));

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const headers: Record<string, string> = {};
      if (etag) headers["If-None-Match"] = etag;
      const r = await fetch("/live/" + token, { headers });
      if (r.status === 200) {
        etag = r.headers.get("ETag");
        const body = await r.json() as { rev?: number; plan?: AgentPlan; focus?: string | number };
        if (body.plan && typeof body.rev === "number" && body.rev > rev) {
          rev = body.rev;
          if ((body.plan.format === "poe2-agent-plan" || body.plan.format === "buildwright-agent-plan") &&
              (!body.plan.game || body.plan.game === (window.PoE2Game?.id ?? "poe2"))) {
            await importAgentPlan(body.plan);
          }
          // Presence: `focus` names the node the agent is working on —
          // pan the camera there and pulse it so the watcher literally
          // sees WHERE the agent is on the tree.
          if (body.focus !== undefined) {
            let fid = String(body.focus);
            if (!TREE.nodes[fid]) {
              // Accept names too — find the first matching node.
              const want = fid.toLowerCase();
              fid = Object.keys(TREE.nodes).find(id =>
                ((TREE.nodes[id] as { n?: string } | undefined)?.n || "").toLowerCase() === want) ?? "";
            }
            if (fid && TREE.nodes[fid]) {
              focusNode(fid);
              state.searchHighlight = new Set([fid]);
              syncPulse();
              requestRender();
            }
          }
          label.textContent = "LIVE — rev " + rev + " · " + new Date().toLocaleTimeString();
        }
        failures = 0;
      } else if (r.status === 304) {
        failures = 0;
      } else if (r.status === 404) {
        label.textContent = "LIVE — channel empty (nothing written yet)";
      } else if (r.status === 503) {
        stop("Live channel isn't enabled on this deployment");
        return;
      }
    } catch {
      // Network hiccup: back off but keep trying (up to a point).
      if (++failures > 40) { stop("Live channel lost — keeping the last state"); return; }
    }
    if (!stopped) setTimeout(() => { void tick(); }, 2500);
  };

  // Wait for the app to be ready (same gate as the #agent= importer).
  const boot = (): void => {
    if (window.PoE2Plan) void tick();
    else setTimeout(boot, 150);
  };
  boot();
}
