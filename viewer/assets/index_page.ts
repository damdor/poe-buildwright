// index_page.ts — landing-page builds list.
//
// Reads the localStorage build index of EVERY game namespace (each
// planner page persists under `${game}-planner:` — see wizard_chrome's
// STORE_BASE), renders the merged list (with ascendancy/class portrait
// art from each game's build_meta.json), handles delete-this-build
// clicks, and re-renders when another tab mutates localStorage.
// Loaded as a classic <script src=> tag from index.html.

import type { PlanIndexEntry } from "../../types/shared.d.ts";

// One row per game the site ships. Adding a game = adding a row; the
// storage prefix and planner URL are the only per-game facts here.
interface GameStore {
  id: string;
  label: string;           // badge on the card ('' = no badge, the default game)
  base: string;            // localStorage namespace
  planner: string;         // planner page URL
  metaUrl: string;         // build_meta.json with the portraits map
}
const GAMES: GameStore[] = [
  { id: "poe2", label: "",     base: "poe2-planner", planner: "/planner.html",
    metaUrl: "/assets/build_meta.json" },
  { id: "poe1", label: "PoE1", base: "poe1-planner", planner: "/planner-poe1.html",
    metaUrl: "/assets/poe1-agent/build_meta.json" },
];
const keyIndex  = (g: GameStore): string => `${g.base}:index`;
const keyPrefix = (g: GameStore): string => `${g.base}:plan:`;

interface IndexedBuild extends PlanIndexEntry { game: GameStore }
function load(): IndexedBuild[] {
  const all: IndexedBuild[] = [];
  for (const g of GAMES) {
    try {
      const idx: PlanIndexEntry[] = JSON.parse(localStorage.getItem(keyIndex(g)) || "[]");
      for (const b of idx) all.push({ ...b, game: g });
    } catch (e) { /* corrupt index → skip this game's list */ }
  }
  return all;
}
function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); }
  catch { return iso; }
}
function escHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c
  ));
}

// Ascendancy/class portrait art (first-party, emitted by tree_render
// into each game's build_meta.json). Loads once per game; cards render
// text-only until it lands, then re-render with art.
const portraitsByGame: Record<string, Record<string, string>> = {};
for (const g of GAMES) {
  fetch(g.metaUrl, { cache: "force-cache" })
    .then(r => (r.ok ? r.json() : null))
    .then((d: { portraits?: Record<string, string> } | null) => {
      if (d?.portraits) { portraitsByGame[g.id] = d.portraits; render(); }
    })
    .catch(() => { /* text-only cards */ });
}

function portraitFor(b: IndexedBuild): string {
  const portraits = portraitsByGame[b.game.id] ?? {};
  // Ascendancy portrait first (the iconic art), class portrait as the
  // pre-ascension fallback.
  const key = (b.ascendancy && portraits[b.ascendancy]) ? b.ascendancy
    : (b.class && portraits[b.class]) ? b.class
    : null;
  if (!key) return '<span class="portrait blank"></span>';
  return '<span class="portrait"><img src="' + escHtml(portraits[key]!) + '" alt="" loading="lazy"></span>';
}

// Game filter ("all" | game id). Session-scoped on purpose — a
// returning user starts at the full list.
let gameFilter = "all";
const filterEl = document.getElementById("game-filter");
if (filterEl) {
  filterEl.addEventListener("click", e => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-game]");
    if (!btn) return;
    gameFilter = btn.dataset.game || "all";
    filterEl.querySelectorAll("button").forEach(b =>
      b.classList.toggle("active", b === btn));
    render();
  });
}

function render(): void {
  const all = load().sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
  const idx = gameFilter === "all" ? all : all.filter(b => b.game.id === gameFilter);
  const ul = document.getElementById("build-list");
  if (!ul) return;
  if (idx.length === 0) {
    const g = GAMES.find(x => x.id === gameFilter);
    ul.innerHTML = g
      ? `<li class="empty">No ${escHtml(g.id === "poe2" ? "PoE2" : g.label)} builds yet — <a href="${g.planner}?new=1">start one</a>.</li>`
      : '<li class="empty">No saved builds yet. Start one above.</li>';
    return;
  }
  ul.innerHTML = idx.map(b => `
    <li>
      ${portraitFor(b)}
      <div class="build-main">
        <a class="name" href="${b.game.planner}?build=${encodeURIComponent(b.id)}">${escHtml(b.name || "(untitled)")}</a>
        <span class="meta">${escHtml(b.class || "—")}${b.ascendancy ? " · " + escHtml(b.ascendancy) : ""} · <b>${b.nodeCount || 0}</b> nodes · ${escHtml(fmtDate(b.savedAt))}</span>
      </div>
      <span class="game-badge ${escHtml(b.game.id)}">${escHtml(b.game.id === "poe2" ? "PoE2" : b.game.label)}</span>
      <button class="dl" data-id="${escHtml(b.id)}" data-game="${escHtml(b.game.id)}" title="Download this build as a JSON backup">⬇</button>
      <button class="rm" data-id="${escHtml(b.id)}" data-game="${escHtml(b.game.id)}" title="Delete this build">✕</button>
    </li>
  `).join("");
}

// ---- Backup: per-card download + landing-page import -----------------
// The exported file is the persisted plan verbatim (lossless
// poe2-planner-plan v2 — the planner normalizes on open, so import
// stays a shallow store-and-index here; no logic duplicated from
// build_io/wizard_chrome). The game is derived from the plan's
// game-namespaced patch ("poe1.*" → poe1), matching wizard_chrome's
// patch rules.
function gameOfPlan(plan: { patch?: string | null }): GameStore {
  const poe1 = typeof plan.patch === "string" && plan.patch.startsWith("poe1.");
  return GAMES.find(g => g.id === (poe1 ? "poe1" : "poe2"))!;
}
function downloadBuild(g: GameStore, id: string): void {
  const raw = localStorage.getItem(keyPrefix(g) + id);
  if (!raw) { alert("Build data not found in this browser."); return; }
  let name = "build";
  try { name = (JSON.parse(raw).name || "build").replace(/[^\w.-]+/g, "_"); } catch (e) { /* keep default */ }
  const blob = new Blob([raw], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.${g.id}.buildwright.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
const importBtn = document.getElementById("import-build-btn");
const importFile = document.getElementById("import-build-file") as HTMLInputElement | null;
if (importBtn && importFile) {
  importBtn.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const f = importFile.files?.[0];
    importFile.value = "";
    if (!f) return;
    void f.text().then(text => {
      let plan: { format?: string; version?: number; id?: string; name?: string;
                  class?: string | null; patch?: string | null;
                  captures?: Array<{ passives?: unknown[]; ascendancy?: string | null }> };
      try { plan = JSON.parse(text); } catch (e) { alert("Not a JSON file."); return; }
      if (plan.format !== "poe2-planner-plan" || plan.version !== 2) {
        alert("Not a buildwright backup (expected poe2-planner-plan v2). GGG .build files import inside the PoE2 planner instead.");
        return;
      }
      const g = gameOfPlan(plan);
      // Keep the original id unless it already exists here — never
      // silently overwrite a stored build on import.
      let id = typeof plan.id === "string" && plan.id ? plan.id : Math.random().toString(36).slice(2, 10);
      if (localStorage.getItem(keyPrefix(g) + id)) {
        id = Math.random().toString(36).slice(2, 10);
        plan.id = id;
      }
      localStorage.setItem(keyPrefix(g) + id, JSON.stringify(plan));
      const last = plan.captures?.[plan.captures.length - 1];
      const entry: PlanIndexEntry = {
        id, name: plan.name || "(untitled)", savedAt: new Date().toISOString(),
        class: plan.class ?? null, ascendancy: last?.ascendancy ?? null,
        nodeCount: last?.passives?.length ?? 0, captureCount: plan.captures?.length ?? 1,
      };
      try {
        const idx: PlanIndexEntry[] = JSON.parse(localStorage.getItem(keyIndex(g)) || "[]");
        localStorage.setItem(keyIndex(g), JSON.stringify([entry, ...idx.filter(b => b.id !== id)]));
      } catch (e) {
        localStorage.setItem(keyIndex(g), JSON.stringify([entry]));
      }
      render();
    });
  });
}

const buildList = document.getElementById("build-list");
if (buildList) {
  buildList.addEventListener("click", e => {
    const dl = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("button.dl");
    if (dl) {
      const g = GAMES.find(x => x.id === dl.dataset.game);
      if (g && dl.dataset.id) downloadBuild(g, dl.dataset.id);
      return;
    }
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("button.rm");
    if (!btn) return;
    const id = btn.dataset.id;
    const g = GAMES.find(x => x.id === btn.dataset.game);
    if (!id || !g) return;
    if (!confirm("Delete this build? This cannot be undone.")) return;
    localStorage.removeItem(keyPrefix(g) + id);
    try {
      const idx: PlanIndexEntry[] = JSON.parse(localStorage.getItem(keyIndex(g)) || "[]");
      localStorage.setItem(keyIndex(g), JSON.stringify(idx.filter(b => b.id !== id)));
    } catch (e) { /* corrupt index → nothing to rewrite */ }
    render();
  });
}

render();
// Re-render if localStorage changes in another tab.
window.addEventListener("storage", e => {
  if (!e.key) return;
  for (const g of GAMES) {
    if (e.key === keyIndex(g) || e.key.startsWith(keyPrefix(g))) { render(); return; }
  }
});
