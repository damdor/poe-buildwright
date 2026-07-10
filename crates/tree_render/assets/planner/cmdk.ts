// ============================================================================
// === Command palette (Cmd+K / Ctrl+K) ====================================
// ============================================================================
// Modal overlay with a search bar. Two kinds of items:
//   * Actions — switch allocation mode (Main / Set 1 / Set 2), clear
//     selection, fit view. Always shown at the top when the query
//     matches.
//   * Nodes — match against name / stats text. Click pans the camera
//     to centre the node and briefly hovers it for visual feedback.

// Result items are either an Action (a labelled callback) or a Node
// (a tree node we'll focus on). Discriminated by `type` so the
// keydown handler can branch on it without losing type information.

import { allocModeSel, isLocked, isMcOption, state, viewport } from "./state.ts";
import { fitToView } from "./viewport.ts";
import { syncPulse } from "./overlay.ts";
import { requestRender } from "./render.ts";
import { updatePreview } from "./pathfind.ts";
import { doShareLink, syncModeBadge } from "./sidebar.ts";
import { GGG_BUILD_SCHEMA, PLAN_VERSION, doExportBuild, doExportPlan, doImportBuild, doImportPlan } from "./build_io.ts";
import { copyAgentLink } from "./agent_import.ts";
import type { Allocation, TreeData, TreeNode } from "../../../../types/poe2.d.ts";

export interface CmdkActionItem {
  type: "action";
  key: string;
  label: string;
  sub: string;
  tag: string;
  match: string;
  run: () => void;
}
export interface CmdkNodeItem {
  type: "node";
  key: string;
  id: string;
  /** All node ids this row represents. Identical name+stats travel
   *  smalls collapse into one row (label suffixed "×N"); repeated
   *  Enter/click cycles the camera through them. */
  ids: string[];
  label: string;
  sub: string;
  tag: string;
  run: () => void;
}
export type CmdkItem = CmdkActionItem | CmdkNodeItem;

export const cmdk        = document.getElementById("cmdk") as HTMLElement;
export const cmdkInput   = document.getElementById("cmdk-input") as HTMLInputElement;
export const cmdkResults = document.getElementById("cmdk-results") as HTMLElement;
export let cmdkItems: CmdkItem[] = [];
export let cmdkActiveIdx = 0;
// Per-group cycle position for ×N deduped node rows (key → next index).
// Reset whenever the result set is rebuilt so stale offsets don't skip.
const cmdkCycle = new Map<string, number>();

export function setAllocationMode(set: "main" | "set1" | "set2"): void {
  state.activeSet = set;
  if (allocModeSel) allocModeSel.value = set;
  syncModeBadge();
  updatePreview();
  requestRender();
}
export function focusNode(id: string): void {
  const n = TREE.nodes[id];
  if (!n) return;
  // Refuse to focus on a node in an ascendancy the user hasn't picked.
  // Previously this silently switched state.asc to the target's asc,
  // which let cmd+K search results end up showing (e.g.) a Sorceress
  // asc panel inside a Huntress build — wrong portrait, wrong
  // connectors, broken state. Search filtering already drops these
  // from results; this is the defensive layer in case anything else
  // routes here with an off-asc id.
  // The `a` field is the asc-name in the source JSON but typed as
  // truthy-flag in TreeData; access via index since this layer
  // pre-dates a typed asc-name field.
  const ascName = (n as unknown as { a?: string }).a;
  if (ascName && ascName !== state.asc) return;
  const rect = viewport.getBoundingClientRect();
  let tx = n.x, ty = n.y;
  if (ascName) {
    const p = TREE.asc_panels[ascName];
    if (p) {
      // asc_panels entries carry their own x/y offset on the source
      // JSON; the typed TreeData only exposes the panel sprite path.
      const panel = p as unknown as { x?: number; y?: number; p: string };
      if (typeof panel.x === "number" && typeof panel.y === "number") {
        tx = n.x - panel.x;
        ty = n.y - panel.y;
      }
    }
  }
  // Use a moderately-zoomed view so the user can see surrounding nodes.
  const targetScale = Math.max(state.scale, 0.6);
  state.scale = targetScale;
  state.tx = rect.width  / 2 - tx * state.scale;
  state.ty = rect.height / 2 - ty * state.scale;
  state.hoverId = id;
  updatePreview();
  requestRender();
}

export function openCmdk(): void {
  cmdk.classList.remove("hidden");
  cmdkInput.focus();
  // Preserve the previous query so the user can keep their highlights
  // visible between opens; selecting the text lets them just start
  // typing if they want to replace it.
  cmdkInput.select();
  cmdkActiveIdx = 0;
  refreshCmdkResults(cmdkInput.value);
}
export function closeCmdk(): void { cmdk.classList.add("hidden"); }

export function escHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c
  ));
}

export function refreshCmdkResults(q: string): void {
  q = (q || "").toLowerCase().trim();
  cmdkItems = [];
  cmdkCycle.clear();
  // ----- Actions section -----
  const actions: CmdkActionItem[] = [
    { type: "action", key: "mode-main", label: "Allocation mode → Main (regular passive)",
      sub: "New clicks land in the regular passive budget", tag: "main",
      match: "main regular passive switch mode",
      run: () => setAllocationMode("main") },
    { type: "action", key: "mode-set1", label: "Allocation mode → Weapon Set 1",
      sub: "New clicks consume a weapon-swap point (set 1, pink)", tag: "set1",
      match: "set 1 set1 weapon swap pink",
      run: () => setAllocationMode("set1") },
    { type: "action", key: "mode-set2", label: "Allocation mode → Weapon Set 2",
      sub: "New clicks consume a weapon-swap point (set 2, green)", tag: "set2",
      match: "set 2 set2 weapon swap green",
      run: () => setAllocationMode("set2") },
    { type: "action", key: "fit", label: "Fit view to the whole tree",
      sub: "Reset zoom to show every node", tag: "view",
      match: "fit view zoom reset",
      run: () => { fitToView(); closeCmdk(); } },
    { type: "action", key: "add-skill", label: "Add skill to this snapshot…",
      sub: "Open the skill-gem socket editor (active + supports + notes)", tag: "skills",
      match: "add skill gem socket support new",
      run: () => { closeCmdk(); document.getElementById("ss-add")?.click(); } },
    { type: "action", key: "snapshot", label: "Snapshot current state",
      sub: "Freeze the current passives/skills as a leveling capture", tag: "timeline",
      match: "snapshot capture freeze timeline level save state",
      run: () => {
        closeCmdk();
        const btn = document.getElementById("cap-snapshot") as HTMLButtonElement | null;
        if (!btn) return;
        // The button gates itself (disabled + a reasoned title). Surface
        // that reason instead of swallowing the click silently.
        if (btn.disabled) window.PoE2Plan?.flash(btn.title || "Snapshot unavailable right now", true);
        else btn.click();
      } },
    { type: "action", key: "go-summary", label: "Go to Summary",
      sub: "Leveling guide + export page for this build", tag: "nav",
      match: "summary go guide page step navigate",
      run: () => {
        closeCmdk();
        const li = document.querySelector<HTMLElement>('#wizard-chrome li[data-step="summary"]');
        li?.click(); // chrome guards unnamed builds with a flash
      } },
    { type: "action", key: "go-builds", label: "Go to Builds index",
      sub: "Back to the saved-builds list", tag: "nav",
      match: "builds index home list back navigate",
      run: () => { location.href = "/"; } },
    { type: "action", key: "toggle-panel", label: "Toggle sidebar panel",
      sub: "Show/hide identity, ascendancy and stat totals", tag: "view",
      match: "sidebar panel toggle show hide identity collapse expand",
      run: () => { closeCmdk(); document.getElementById("panel-toggle")?.click(); } },
    { type: "action", key: "help", label: "Open help",
      sub: "Controls, shortcuts, and planner concepts", tag: "view",
      match: "help shortcuts controls keys how what",
      run: () => { closeCmdk(); document.getElementById("help-badge")?.click(); } },
    { type: "action", key: "export-build", label: "Export .build (for in-game Build Planner)",
      sub: "GGG schema v" + GGG_BUILD_SCHEMA + " — passive tree slice (passives + ascendancy + weapon_set)",
      tag: "export",
      match: "export build file ggg in-game planner share download",
      run: () => { closeCmdk(); doExportBuild(); } },
    { type: "action", key: "share-link", label: "Copy share link",
      sub: "Compress + encode the current plan into a URL fragment; pastes anywhere",
      tag: "export",
      match: "share link url copy code pob clipboard",
      run: () => { closeCmdk(); doShareLink(); } },
    { type: "action", key: "agent-link", label: "Copy agent link",
      sub: "Goal-oriented plan URL any AI assistant can read or remix (see /llms.txt)",
      tag: "export",
      match: "agent link ai llm assistant copy url export claude gpt",
      run: () => { closeCmdk(); void copyAgentLink(); } },
    { type: "action", key: "export-plan", label: "Export plan (internal JSON, lossless)",
      sub: "poe2-planner-plan v" + PLAN_VERSION + " — round-trips everything our planner tracks",
      tag: "export",
      match: "export plan save internal backup",
      run: () => { closeCmdk(); doExportPlan(); } },
    { type: "action", key: "import-build", label: "Import .build file…",
      sub: "Load a GGG-format build into the planner",
      tag: "import",
      match: "import build load file open",
      run: () => { closeCmdk(); doImportBuild(); } },
    { type: "action", key: "import-plan", label: "Import plan (internal JSON)…",
      sub: "Load a poe2-planner-plan file",
      tag: "import",
      match: "import plan load file",
      run: () => { closeCmdk(); doImportPlan(); } },
  ];
  for (const a of actions) {
    if (!q || a.match.includes(q) || a.label.toLowerCase().includes(q)) {
      cmdkItems.push(a);
    }
  }
  // ----- Node search -----
  if (q) {
    interface RankedNode { score: number; id: string; n: TreeNode; }
    const ranked: RankedNode[] = [];
    let scanned = 0;
    for (const id in TREE.nodes) {
      const n = TREE.nodes[id];
      if (!n || !n.n) continue;
      if (n.k === "class_start" || n.k === "asc_start" || n.k === "mastery") continue;
      // Hide ascendancy nodes that belong to an asc the user hasn't
      // picked. Clicking such a result would otherwise focusNode →
      // forcibly switch state.asc, ending up with (e.g.) a Huntress
      // build showing the Sorceress portrait + connectors. Even when
      // we one day support cross-asc unlocks via items, the search
      // result list should never be the gateway to that.
      const ascName = (n as unknown as { a?: string }).a;
      if (ascName && ascName !== state.asc) continue;
      // Same gating for main-tree nodes locked behind an asc-specific
      // unlock (Oracle's Unseen Path adds ~197 such nodes; they
      // should never appear in search for non-Oracle builds).
      if (isLocked(id)) continue;
      // Multi-choice options are interaction-only via popouts; never
      // searchable directly (the parent notable carries the search hit).
      if (isMcOption(id)) continue;
      const name = n.n.toLowerCase();
      const stats = (n.s || "").toLowerCase();
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.includes(q)) score = 60;
      else if (stats.includes(q)) score = 30;
      if (score > 0) {
        // Prefer keystones / notables over small travel nodes.
        if (n.k === "keystone") score += 8;
        else if (n.k === "notable" || n.k === "asc_notable") score += 5;
        ranked.push({ score, id, n });
      }
      if (++scanned > 6000) break;
    }
    ranked.sort((a, b) => b.score - a.score);
    // Collapse identical name+stats rows (the tree repeats travel smalls
    // like "Lightning Damage · 12%" many times) into one entry carrying
    // every id. Groups keep ranked order; cap applies to GROUPS so the
    // visible variety stays at ~40.
    const groups = new Map<string, { ids: string[]; n: TreeNode }>();
    for (const r of ranked) {
      const gk = (r.n.n ?? "") + " " + (r.n.s ?? "") + " " + r.n.k;
      const g = groups.get(gk);
      if (g) g.ids.push(r.id);
      else groups.set(gk, { ids: [r.id], n: r.n });
      if (groups.size >= 40 && !g) { groups.delete(gk); break; }
    }
    for (const g of groups.values()) {
      const n = g.n;
      const ascName = (n as unknown as { a?: string }).a;
      const tag = ascName ? "asc" : n.k;
      const ids = g.ids;
      const key = "node-" + ids[0];
      cmdkItems.push({
        type: "node", key, id: ids[0]!, ids,
        label: (n.n ?? "") + (ids.length > 1 ? "  ×" + ids.length : ""),
        sub: (n.s || "").split(/;\s*/).slice(0, 2).join(" · ") +
             (ids.length > 1 ? "  ·  ⏎ again for the next one" : ""),
        tag,
        run: () => {
          // Cycle through the group's copies on repeated activation, so
          // "×3" is explorable — the palette stays open for node jumps.
          const idx = cmdkCycle.get(key) ?? 0;
          focusNode(ids[idx % ids.length]!);
          cmdkCycle.set(key, idx + 1);
          if (ids.length === 1) closeCmdk();
        },
      });
    }
  }
  cmdkActiveIdx = Math.min(cmdkActiveIdx, Math.max(0, cmdkItems.length - 1));
  // Sync the on-tree highlight set. The pulse animation runs only
  // while this set is non-empty (syncPulse starts/stops the rAF loop).
  state.searchHighlight = new Set();
  for (const it of cmdkItems) {
    if (it.type === "node") for (const id of it.ids) state.searchHighlight.add(id);
  }
  syncPulse();
  renderCmdkResults();
  requestRender();
}

export function renderCmdkResults(): void {
  // Footer count: actions + node groups (a ×N row counts its copies).
  const countEl = document.getElementById("cmdk-count");
  if (countEl) {
    let nodes = 0, copies = 0, actions = 0;
    for (const it of cmdkItems) {
      if (it.type === "node") { nodes++; copies += it.ids.length; }
      else actions++;
    }
    const parts: string[] = [];
    if (actions) parts.push(actions + " action" + (actions === 1 ? "" : "s"));
    if (nodes) parts.push(nodes + " node" + (nodes === 1 ? "" : "s") + (copies > nodes ? " (" + copies + " incl. copies)" : ""));
    countEl.textContent = parts.join(" · ");
  }
  if (cmdkItems.length === 0) {
    cmdkResults.innerHTML = '<div class="cmdk-empty">No matches. Try a notable name, stat keyword, or "set 1".</div>';
    return;
  }
  let html = "";
  let lastType: CmdkItem["type"] | null = null;
  cmdkItems.forEach((it, i) => {
    if (it.type !== lastType) {
      html += '<div class="cmdk-section-label">' + (it.type === "action" ? "Actions" : "Nodes") + "</div>";
      lastType = it.type;
    }
    const tagClass = it.tag === "set1"     ? "t-set1"
                   : it.tag === "set2"     ? "t-set2"
                   : it.tag === "asc"      ? "t-asc"
                   : it.tag === "export"   ? "t-export"
                   : it.tag === "import"   ? "t-import"
                   : it.tag === "view"     ? "t-view"
                   : it.tag === "skills"   ? "t-skills"
                   : it.tag === "timeline" ? "t-timeline"
                   : it.tag === "nav"      ? "t-nav"  : "";
    html += '<div class="cmdk-item' + (i === cmdkActiveIdx ? " active" : "") + '" data-idx="' + i + '">' +
            '<div class="cmdk-item-main">' +
              '<div class="cmdk-item-title">' + escHtml(it.label) + "</div>" +
              (it.sub ? '<div class="cmdk-item-sub">' + escHtml(it.sub) + "</div>" : "") +
            "</div>" +
            (it.tag ? '<span class="cmdk-tag ' + tagClass + '">' + escHtml(it.tag) + "</span>" : "") +
            "</div>";
  });
  cmdkResults.innerHTML = html;
}

cmdkInput.addEventListener("input", () => { cmdkActiveIdx = 0; refreshCmdkResults(cmdkInput.value); });
cmdkInput.addEventListener("keydown", e => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    cmdkActiveIdx = Math.min(cmdkItems.length - 1, cmdkActiveIdx + 1);
    renderCmdkResults();
    const el = cmdkResults.querySelector(".cmdk-item.active");
    if (el) el.scrollIntoView({ block: "nearest" });
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    cmdkActiveIdx = Math.max(0, cmdkActiveIdx - 1);
    renderCmdkResults();
    const el = cmdkResults.querySelector(".cmdk-item.active");
    if (el) el.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    const it = cmdkItems[cmdkActiveIdx];
    if (it) { it.run(); if (it.type === "action" && it.key.startsWith("mode-")) closeCmdk(); }
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeCmdk();
  }
});
cmdkResults.addEventListener("click", e => {
  const item = (e.target as HTMLElement | null)?.closest(".cmdk-item");
  if (!item) return;
  const idx = Number(item.getAttribute("data-idx"));
  const it = cmdkItems[idx];
  if (it) { it.run(); if (it.type === "action" && it.key.startsWith("mode-")) closeCmdk(); }
});
cmdk.addEventListener("click", e => {
  // Click on the dark backdrop (outside the modal) closes.
  if (e.target === cmdk) closeCmdk();
});

// Global hotkey: Cmd+K (Mac) / Ctrl+K (Linux/Win) toggles the palette.
// ⊿: matches what most modern web apps use; we intercept before the
// browser's "focus address bar" so the user gets the palette.
window.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    if (cmdk.classList.contains("hidden")) openCmdk();
    else closeCmdk();
  }
});
