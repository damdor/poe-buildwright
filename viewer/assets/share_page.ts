// share_page.ts — receives a share-coded plan via `#code=...` and
// installs it into the local builds list, then opens the planner.
//
// Loaded as a classic <script src=> from share.html, AFTER
// share_codec.js (which exposes window.PoE2Share). Browsers honour
// <script defer> order, so the codec is ready when this runs.

import type { Plan, PlanIndexEntry } from "../../types/poe2.d.ts";

const PLAN_FORMAT: "poe2-planner-plan" = "poe2-planner-plan";
// Captures-era plans are v2. Anything older (v1) is from the
// pre-launch prototype and gets refused with a clean error instead
// of silently corrupting state.
const PLAN_VERSION_MIN: 2 = 2;
const PLAN_VERSION_MAX: 2 = 2;
const KEY_PREFIX  = "poe2-planner:plan:";
const KEY_INDEX   = "poe2-planner:index";
const KEY_CURRENT = "poe2-planner:current";

const statusEl = document.getElementById("status");

function setStatus(text: string, cls?: string): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = "status " + (cls || "");
}

function err(msg: string, detail?: unknown): void {
  if (!statusEl) return;
  statusEl.className = "status error";
  statusEl.innerHTML = "";
  const p = document.createElement("p");
  p.textContent = msg;
  p.style.margin = "0";
  statusEl.appendChild(p);
  if (detail) {
    const pre = document.createElement("pre");
    pre.textContent = String(detail);
    statusEl.appendChild(pre);
  }
  const back = document.createElement("p");
  back.innerHTML = '<a href="/">← back to builds</a>';
  back.style.marginTop = "12px";
  statusEl.appendChild(back);
}

(async function () {
  // Belt-and-suspenders: defer order is deterministic, but yielding
  // one microtask makes the dependency explicit if browsers ever
  // change the rules.
  await new Promise(r => setTimeout(r, 0));

  if (!window.PoE2Share) {
    err("share_codec.js failed to load. Refresh the page and try again.");
    return;
  }

  const hash = location.hash || "";
  const m = hash.match(/(?:^|[?&#])code=([A-Za-z0-9_-]+)/);
  if (!m) {
    err("No share code in URL. Open a /share.html#code=… link from someone else.");
    return;
  }
  const code = m[1];
  if (!code) {
    err("Empty share code in URL.");
    return;
  }
  let plan: Plan;
  try {
    plan = await window.PoE2Share.decode(code);
  } catch (e) {
    err("Could not decode this share code — it may be truncated or corrupted.",
        (e as Error).message);
    return;
  }
  if (!plan || plan.format !== PLAN_FORMAT) {
    err("That code is not in the poe2-planner-plan format.");
    return;
  }
  if (typeof plan.version !== "number" ||
      plan.version < PLAN_VERSION_MIN || plan.version > PLAN_VERSION_MAX) {
    err("That build was made with an incompatible planner (schema v" + plan.version +
        "). Upgrade or ask the sender to re-export.");
    return;
  }

  // Mint a fresh build id so the import slots into the local builds
  // list without colliding with the recipient's existing entries.
  const chars = "abcdefghijklmnpqrstuvwxyz23456789";
  let id = "";
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  plan.savedAt = new Date().toISOString();
  localStorage.setItem(KEY_PREFIX + id, JSON.stringify(plan));
  // Keep the landing-page index up to date so the import shows up in
  // "Saved builds" without an extra round-trip through the chrome.
  let idx: PlanIndexEntry[] = [];
  try { idx = JSON.parse(localStorage.getItem(KEY_INDEX) || "[]"); } catch (e) {}
  // Pull per-capture asc + node count from the LAST capture (working
  // cap) so the landing entry matches what the planner will show.
  const active = plan.captures[plan.captures.length - 1] ?? plan.captures[0];
  idx.push({
    id,
    name: plan.name || "(imported build)",
    savedAt: plan.savedAt,
    class: plan.class || null,
    ascendancy: (active && active.ascendancy) || null,
    nodeCount: (active && active.passives ? active.passives.length : 0),
    captureCount: plan.captures.length,
  });
  localStorage.setItem(KEY_INDEX, JSON.stringify(idx));
  localStorage.setItem(KEY_CURRENT, id);

  setStatus('Imported "' + (plan.name || "untitled") + '" — opening…', "ok");
  setTimeout(() => {
    // Identity moved into the planner sidebar; share imports land
    // directly on the planner page (the old /identity.html was
    // removed in the wizard restructure).
    location.replace("/planner.html?build=" + encodeURIComponent(id));
  }, 600);
})();
