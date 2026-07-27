// share_page.ts — receives a share-coded plan via `#code=...` and
// installs it into the local builds list, then opens the planner.
//
// Loaded as a classic <script src=> from share.html, AFTER
// share_codec.js (which exposes window.BuildwrightShare). Browsers honour
// <script defer> order, so the codec is ready when this runs.

import type {
  AnyPersistedPlan, Plan, PlanIndexEntry, PlanV3,
} from "../../types/shared.d.ts";
import { gameDefinitionForPlan } from "../../crates/tree_render/assets/planner/game_profile.ts";
import {
  migratePlanV2ToV3, projectPlanV3ToV2, validatePlanV3,
} from "./plan_v3.ts";
import { saveNativePlan } from "./plan_storage.ts";

const PLAN_FORMAT = "buildwright-planner-plan" as const;
const LEGACY_PLAN_FORMAT = "poe2-planner-plan" as const;
// Captures-era plans are v2. Anything older (v1) is from the
// pre-launch prototype and gets refused with a clean error instead
// of silently corrupting state.
const PLAN_VERSION_MIN: 2 = 2;
const PLAN_VERSION_MAX: 3 = 3;
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

  if (!window.BuildwrightShare) {
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
  let decoded: AnyPersistedPlan;
  try {
    decoded = await window.BuildwrightShare.decode(code);
  } catch (e) {
    err("Could not decode this share code — it may be truncated or corrupted.",
        (e as Error).message);
    return;
  }
  if (!decoded || (decoded.format !== PLAN_FORMAT && decoded.format !== LEGACY_PLAN_FORMAT)) {
    err("That code is not in a supported Buildwright planner format.");
    return;
  }
  if (typeof decoded.version !== "number" ||
      decoded.version < PLAN_VERSION_MIN || decoded.version > PLAN_VERSION_MAX) {
    err("That build was made with an incompatible planner (schema v" + decoded.version +
        "). Upgrade or ask the sender to re-export.");
    return;
  }
  let game;
  try {
    game = gameDefinitionForPlan(decoded);
  } catch {
    err("That share code belongs to an unsupported game: " + decoded.game + ".");
    return;
  }
  if (!game.integrations.nativeShare) {
    err(game.shortLabel + " builds cannot currently be imported from share links.");
    return;
  }
  let nativePlan: PlanV3;
  if (decoded.version === 2) {
    const legacy = structuredClone(decoded as Plan);
    legacy.game = game.id;
    nativePlan = migratePlanV2ToV3(legacy);
  } else {
    nativePlan = structuredClone(decoded as PlanV3);
    const validation = validatePlanV3(nativePlan);
    if (validation.length) {
      err("That state graph is invalid.", validation.join("; "));
      return;
    }
  }
  const keyPrefix = game.storageNamespace + ":plan:";
  const keyIndex = game.storageNamespace + ":index";
  const keyCurrent = game.storageNamespace + ":current";

  // Mint a fresh build id so the import slots into the local builds
  // list without colliding with the recipient's existing entries.
  const chars = "abcdefghijklmnpqrstuvwxyz23456789";
  let id = "";
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  nativePlan.id = id;
  const saved = saveNativePlan(
    localStorage,
    keyPrefix + id,
    nativePlan,
    game.id,
  ).plan;
  const plan = projectPlanV3ToV2(saved);
  // Keep the landing-page index up to date so the import shows up in
  // "Saved builds" without an extra round-trip through the chrome.
  let idx: PlanIndexEntry[] = [];
  try { idx = JSON.parse(localStorage.getItem(keyIndex) || "[]"); } catch (e) {}
  // Pull per-capture asc + node count from the LAST capture (working
  // cap) so the landing entry matches what the planner will show.
  const active = plan.captures[plan.captures.length - 1] ?? plan.captures[0];
  idx.push({
    id,
    name: plan.name || "(imported build)",
    savedAt: saved.savedAt!,
    class: plan.class || null,
    ascendancy: (active && active.ascendancy) || null,
    nodeCount: (active && active.passives ? active.passives.length : 0),
    captureCount: saved.states.length,
  });
  localStorage.setItem(keyIndex, JSON.stringify(idx));
  localStorage.setItem(keyCurrent, id);

  setStatus('Imported "' + (plan.name || "untitled") + '" for ' +
    game.shortLabel + " — opening…", "ok");
  setTimeout(() => {
    // Identity moved into the planner sidebar; share imports land
    // directly on the planner page (the old /identity.html was
    // removed in the wizard restructure).
    // Keep the share code in the URL: the address bar stays a
    // canonical, copy-pasteable share link (PoB-style) — the planner
    // ALSO imports #code= itself for recipients who land there.
    location.replace(game.plannerPath + "?build=" + encodeURIComponent(id) + "#code=" + m[1]);
  }, 600);
})();
