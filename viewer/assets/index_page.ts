// index_page.ts — landing-page builds list.
//
// Reads the localStorage build index, renders the list (with the
// build's ascendancy/class portrait art from build_meta.json), handles
// delete-this-build clicks, and re-renders when another tab mutates
// localStorage. Loaded as a classic <script src=> tag from index.html.

import type { PlanIndexEntry } from "../../types/shared.d.ts";

const KEY_INDEX  = "poe2-planner:index";
const KEY_PREFIX = "poe2-planner:plan:";

function load(): PlanIndexEntry[] {
  try { return JSON.parse(localStorage.getItem(KEY_INDEX) || "[]"); }
  catch (e) { return []; }
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
// into build_meta.json). Loads once; cards render text-only until it
// lands, then re-render with art.
let portraits: Record<string, string> = {};
fetch("/assets/build_meta.json", { cache: "force-cache" })
  .then(r => (r.ok ? r.json() : null))
  .then((d: { portraits?: Record<string, string> } | null) => {
    if (d?.portraits) { portraits = d.portraits; render(); }
  })
  .catch(() => { /* text-only cards */ });

function portraitFor(b: PlanIndexEntry): string {
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
        <a class="name" href="/planner.html?build=${encodeURIComponent(b.id)}">${escHtml(b.name || "(untitled)")}</a>
        <span class="meta">${escHtml(b.class || "—")}${b.ascendancy ? " · " + escHtml(b.ascendancy) : ""} · <b>${b.nodeCount || 0}</b> nodes · ${escHtml(fmtDate(b.savedAt))}</span>
      </div>
      <button class="rm" data-id="${escHtml(b.id)}" title="Delete this build">✕</button>
    </li>
  `).join("");
}

const buildList = document.getElementById("build-list");
if (buildList) {
  buildList.addEventListener("click", e => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("button.rm");
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;
    if (!confirm("Delete this build? This cannot be undone.")) return;
    localStorage.removeItem(KEY_PREFIX + id);
    const idx = load().filter(b => b.id !== id);
    localStorage.setItem(KEY_INDEX, JSON.stringify(idx));
    render();
  });
}

render();
// Re-render if localStorage changes in another tab.
window.addEventListener("storage", e => {
  if (e.key === KEY_INDEX || (e.key && e.key.startsWith(KEY_PREFIX))) render();
});
