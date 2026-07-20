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

function render(): void {
  const idx = load().sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
  const ul = document.getElementById("build-list");
  if (!ul) return;
  if (idx.length === 0) {
    ul.innerHTML = '<li class="empty">No saved builds yet. Start one above.</li>';
    return;
  }
  ul.innerHTML = idx.map(b => `
    <li>
      ${portraitFor(b)}
      <div class="build-main">
        <a class="name" href="${b.game.planner}?build=${encodeURIComponent(b.id)}">${escHtml(b.name || "(untitled)")}</a>
        <span class="meta">${b.game.label ? escHtml(b.game.label) + " · " : ""}${escHtml(b.class || "—")}${b.ascendancy ? " · " + escHtml(b.ascendancy) : ""} · <b>${b.nodeCount || 0}</b> nodes · ${escHtml(fmtDate(b.savedAt))}</span>
      </div>
      <button class="rm" data-id="${escHtml(b.id)}" data-game="${escHtml(b.game.id)}" title="Delete this build">✕</button>
    </li>
  `).join("");
}

const buildList = document.getElementById("build-list");
if (buildList) {
  buildList.addEventListener("click", e => {
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
