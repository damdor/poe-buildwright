// ============================================================================
// === Build guide view (📖) =================================================
// ============================================================================
// The written-guide surface: the full plan — captures, passives, skills,
// gear, notes — typeset as a readable guide in a FLOATING window over
// the live tree. This replaced the separate Summary page.
//
// - Drag by the title bar; the tree stays interactive around it.
// - Every tagged element previews: node chips pulse their node on the
//   tree behind the window and show the brown stat tooltip; gem and
//   item references reuse the planner's gem/item preview popups
//   (data-gem-tip / data-item-tip delegates in 15/16).
// - ✎ Edit toggles inline editing of the intro + chapter prose,
//   persisted straight into the plan (agents read the same fields).
// - "Copy for agent" serializes the whole story as chronological JSON
//   with writing hints — the hand-off for a full written guide.
// ============================================================================
import { featureOn, SOCKET_MODEL } from "./game.ts";
import { loadGameAsset } from "./asset_loader.ts";
import { state, tooltip } from "./state.ts";
import { focusNode } from "./cmdk.ts";
import { requestRender } from "./render.ts";
import type { Allocation, Capture, Item, Skill } from "../../../../types/shared.d.ts";

// The guide typesets the whole PoE2 plan (captures, skills, gear) and
// its open button lives inside the gear strip — on tree-only games
// both are gone, so the module must not initialize at all.
// Rides the gear gate deliberately: the guide narrates gear swaps.
const GUIDE_ON = featureOn("gear");
if (GUIDE_ON) {
  interface GuideGem {
    id: string; name: string; gem_type?: string; icon?: string | null;
    description?: string; parts?: string[]; tag_string?: string;
    granted_effect_id?: string;
  }
  interface GuideUnique { name: string; base?: string; slot?: string; icon?: string | null; latest_stats?: string; }
  interface GuideBase { name: string; icon?: string; }
  interface GuideStatPart { label?: string; levels?: Record<string, string[]>; }
  interface GuideEffectStats { parts: GuideStatPart[]; cost?: Record<string, number>; reservation?: Record<string, number>; }

  const openBtn  = document.getElementById("guide-open")  as HTMLElement | null;
  const viewEl   = document.getElementById("guide-view")  as HTMLElement | null;
  const frameEl  = document.getElementById("gv-frame")    as HTMLElement | null;
  const barEl    = document.getElementById("gv-bar")      as HTMLElement | null;
  const bodyEl   = document.getElementById("guide-body")  as HTMLElement | null;
  const closeBtn = document.getElementById("guide-close") as HTMLElement | null;
  const editBtn  = document.getElementById("gv-edit")     as HTMLElement | null;
  const agentBtn = document.getElementById("gv-agent")    as HTMLElement | null;
  if (!openBtn || !viewEl || !frameEl || !barEl || !bodyEl || !closeBtn || !editBtn || !agentBtn) {
    throw new Error("guide view: missing required DOM element");
  }

  const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c
  ));
  const deMarkup = (s: string): string => s
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, "$2")
    .replace(/\[([^\]|]+)\]/g, "$1");

  // ---- lazily-fetched catalogues (browser-cached; tiny cost) ----
  let gems: Map<string, GuideGem> | null = null;
  let uniques: Map<string, GuideUnique> | null = null;
  let baseIcons: Map<string, string> | null = null;
  let effStats: Record<string, GuideEffectStats> | null = null;
  async function loadData(): Promise<void> {
    if (!gems) {
      try {
        const d = await loadGameAsset<{ gems?: GuideGem[] }>("skillCatalogue");
        gems = new Map((d?.gems ?? []).map(g => [g.id, g]));
      } catch { gems = new Map(); }
    }
    if (!uniques) {
      try {
        const d = await loadGameAsset<{ uniques?: GuideUnique[] }>("itemCatalogue");
        uniques = new Map((d?.uniques ?? []).map(u => [u.name.toLowerCase(), u]));
      } catch { uniques = new Map(); }
    }
    if (!baseIcons) {
      try {
        const d = await loadGameAsset<{ bases?: GuideBase[] }>("bases");
        baseIcons = new Map();
        for (const b of d?.bases ?? []) {
          if (b.icon && !baseIcons.has(b.name.toLowerCase())) baseIcons.set(b.name.toLowerCase(), b.icon);
        }
      } catch { baseIcons = new Map(); }
    }
    if (!effStats) {
      try {
        const d = await loadGameAsset<{ effects?: Record<string, GuideEffectStats> }>("skillStats");
        effStats = d?.effects ?? {};
      } catch { effStats = {}; }
    }
  }

  function atLevel<T>(m: Record<string, T> | undefined, L: number): T | null {
    if (!m) return null;
    if (m[String(L)] != null) return m[String(L)]!;
    let best = -1;
    for (const k in m) { const n = +k; if (n <= L && n > best) best = n; }
    return best > 0 ? (m[String(best)] ?? null) : null;
  }
  // First damage-ish line + cost of the skill at gem level L.
  function mainLineAt(g: GuideGem, L: number): string {
    const st = g.granted_effect_id && effStats ? effStats[g.granted_effect_id] : null;
    if (!st) return "";
    for (const p of st.parts) {
      const lines = atLevel(p.levels, L);
      if (lines?.length) {
        const cost = atLevel(st.cost, L);
        return lines[0]! + (cost ? " · costs " + cost : "");
      }
    }
    const resv = atLevel(st.reservation, L);
    return resv
      ? "reserves " + resv + (SOCKET_MODEL === "spirit" ? " Spirit" : "% Mana")
      : "";
  }

  // ---- fragment renderers ----
  function nodeChip(id: string, note?: string): string {
    const n = TREE.nodes[id];
    if (!n) return "";
    const icon = n.i ? '<img class="gv-ic" src="' + esc(n.i) + '" alt="" loading="lazy">' : "";
    const kindCls = n.k === "keystone" ? " keystone" : n.k === "notable" ? " notable" : "";
    return '<span class="gv-node' + kindCls + '" data-node="' + esc(id) + '">' + icon +
      '<span class="gv-node-name">' + esc(n.n || id) + "</span></span>" +
      (note ? '<blockquote class="gv-note">' + esc(note) + "</blockquote>" : "");
  }

  function gemChip(id: string, lvl: number, extra?: string): string {
    const g = gems?.get(id);
    if (!g) return '<span class="gv-gem-name">' + esc(id) + "</span>";
    const icon = g.icon ? '<img class="gv-ic" src="' + esc(g.icon) + '" alt="" loading="lazy">' : "";
    return '<span class="gv-gem" data-gem-tip="' + esc(g.id) + '" data-gem-lvl="' + lvl + '">' + icon +
      '<span class="gv-gem-name">' + esc(g.name) + "</span>" +
      (extra ? '<span class="gv-meta">' + esc(extra) + "</span>" : "") + "</span>";
  }

  function skillBlock(s: Skill, isNew: boolean): string {
    const sups = (s.supports || []).filter(x => x && x.id);
    const g = gems?.get(s.id);
    const numbers = g ? mainLineAt(g, s.level || 1) : "";
    return '<div class="gv-skill' + (isNew ? " is-new" : "") + '">' +
      gemChip(s.id, s.level || 1, (s.level ? "lvl " + s.level : "") + (numbers ? " — " + numbers : "")) +
      (sups.length
        ? '<span class="gv-links">' + sups.map(x => gemChip(x.id, x.level || s.level || 1)).join("") + "</span>"
        : "") +
      (s.note ? '<blockquote class="gv-note">' + esc(s.note) + "</blockquote>" : "") +
      sups.filter(x => x.note).map(x =>
        '<blockquote class="gv-note">' + esc((gems?.get(x.id)?.name ?? x.id) + ": " + x.note) + "</blockquote>").join("") +
      "</div>";
  }

  const RARITY_RE = /^(rare|magic|normal)\s+(.+)$/i;
  function itemBlock(it: Item, isNew: boolean): string {
    const nm = (it.name || it.uniqueName || "").trim();
    const uq = uniques?.get((it.uniqueName || nm).toLowerCase());
    let rarity = "normal", icon: string | null = null, tip = "";
    let base = it.base || RARITY_RE.exec(nm)?.[2] || "";
    if (uq) {
      rarity = "unique"; icon = uq.icon ?? null;
      tip = ' data-item-tip="unique:' + esc(uq.name) + '"';
    } else {
      rarity = (it.rarity || RARITY_RE.exec(nm)?.[1] || "normal").toLowerCase();
      icon = baseIcons?.get((base || nm).toLowerCase()) ?? null;
      if (base) tip = ' data-item-tip="base:' + esc(base) + '"';
    }
    return '<div class="gv-item' + (isNew ? " is-new" : "") + '"' + tip + ">" +
      (icon ? '<img class="gv-item-ic" src="' + esc(icon) + '" alt="" loading="lazy">' : '<span class="gv-item-ic gv-ic-blank"></span>') +
      '<div class="gv-item-main">' +
        '<span class="gv-item-name r-' + esc(rarity) + '">' + esc(nm) + "</span>" +
        '<span class="gv-meta">' + esc(it.slot || "") + "</span>" +
        (it.mods?.length ? '<div class="gv-mods">' + it.mods.map(m => "<span>" + esc(m) + "</span>").join("") + "</div>" : "") +
        (it.note ? '<blockquote class="gv-note">' + esc(it.note) + "</blockquote>" : "") +
      "</div></div>";
  }

  // ---- render ----
  let editing = false;
  function descHtml(text: string, key: string, placeholder: string): string {
    if (editing) {
      return '<textarea class="gv-edit-ta" data-desc="' + esc(key) + '" placeholder="' + esc(placeholder) + '">' +
        esc(text) + "</textarea>";
    }
    return text ? '<p class="gv-desc">' + esc(text) + "</p>" : "";
  }

  function render(): void {
    if (!window.BuildwrightPlan || !bodyEl) return;
    const plan = window.BuildwrightPlan;
    const caps: Capture[] = plan.captures.list();
    const p = plan.get();
    const name = (document.getElementById("build-name") as HTMLInputElement | null)?.value
      || p?.name || "Untitled build";
    const desc = p?.description || "";
    const klass = state.klass || "";
    const asc = (document.getElementById("asc") as HTMLSelectElement | null)?.value
      || state.ascVariant || state.asc || "";

    let html = '<header class="gv-head">' +
      "<h1>" + esc(name) + "</h1>" +
      '<div class="gv-sub">' + esc(klass) + (asc ? " · " + esc(asc) : "") + "</div>" +
      descHtml(desc, "build", "Write the build's introduction — what it does, its playstyle, the defence plan…") +
      "</header>";

    let prevPassives = new Set<string>();
    let prevSkills = new Set<string>();
    let prevItems = new Set<string>();
    for (let i = 0; i < caps.length; i++) {
      const c = caps[i]!;
      const lo = c.levelRange[0], hi = c.levelRange[1];
      const isLast = i === caps.length - 1;
      const title = c.name
        ? c.name
        : isLast ? "Current state" : "Levels " + lo + "–" + hi;
      html += '<section class="gv-chapter"><h2><span class="gv-chnum">' + (i + 1) +
        "</span>" + esc(title) +
        (c.name ? ' <span class="gv-meta">· levels ' + lo + "–" + hi + "</span>" : "") + "</h2>";
      html += descHtml(c.description || "", "cap:" + i, "Add this chapter's story — what to focus on in these levels…");

      const newAllocs = c.passives.filter(a => !prevPassives.has(String(a.id)));
      const highlights = newAllocs.filter(a => {
        const n = TREE.nodes[String(a.id)];
        return n && (n.k === "notable" || n.k === "keystone" || a.note);
      });
      const travel = newAllocs.length - highlights.length;
      if (highlights.length || travel > 0) {
        html += '<h3>Passive tree</h3><div class="gv-nodes">' +
          highlights.map(a => nodeChip(String(a.id), a.note)).join("") +
          (travel > 0 ? '<span class="gv-meta gv-travel">+ ' + travel + " travel/small passives</span>" : "") +
          "</div>";
      }
      const skills = (c.skills || []).filter(s => s && s.id);
      if (skills.length) {
        html += "<h3>Skills</h3>" + skills.map(s => skillBlock(s, !prevSkills.has(s.id))).join("");
      }
      const items = (c.items || []).filter(it => it && (it.name || it.uniqueName));
      if (items.length) {
        html += "<h3>Gear</h3>" +
          items.map(it => itemBlock(it, !prevItems.has((it.slot || "") + "|" + (it.name || "")))).join("");
      }
      html += "</section>";
      prevPassives = new Set(c.passives.map(a => String(a.id)));
      prevSkills = new Set(skills.map(s => s.id));
      prevItems = new Set(items.map(it => (it.slot || "") + "|" + (it.name || "")));
    }
    bodyEl.innerHTML = html;
  }

  // ---- inline editing (persists into the plan the agents also read) ----
  editBtn.addEventListener("click", () => {
    editing = !editing;
    editBtn.classList.toggle("is-active", editing);
    editBtn.innerHTML = editing ? "&#10003; Done" : "&#9998; Edit";
    render();
  });
  bodyEl.addEventListener("input", e => {
    const ta = (e.target as HTMLElement | null)?.closest<HTMLTextAreaElement>(".gv-edit-ta");
    if (!ta || !window.BuildwrightPlan) return;
    const key = ta.dataset.desc || "";
    if (key === "build") {
      window.BuildwrightPlan.get().description = ta.value;
      // Mirror into the sidebar field so the planner's own autosave
      // hash sees the change too.
      const sideEl = document.getElementById("build-description") as HTMLTextAreaElement | null;
      if (sideEl) sideEl.value = ta.value;
      window.BuildwrightPlan.save();
    } else if (key.startsWith("cap:")) {
      window.BuildwrightPlan.captures.setDescription(+key.slice(4), ta.value);
      window.BuildwrightPlan.save();
    }
  });

  // ---- agent handoff: the whole story as chronological JSON ----
  function buildAgentSummary(): object {
    const plan = window.BuildwrightPlan!;
    const p = plan.get();
    const caps = plan.captures.list();
    let prevPassives = new Set<string>();
    let prevSkills = new Set<string>();
    let prevItems = new Set<string>();
    const chapters = caps.map((c, i) => {
      const lo = c.levelRange[0];
      const added = c.passives.filter(a => !prevPassives.has(String(a.id)));
      const removed = [...prevPassives].filter(id => !c.passives.some(a => String(a.id) === id));
      let cursor = lo === 1 ? 2 : lo;
      const picks = added.map((a: Allocation) => {
        const n = TREE.nodes[String(a.id)];
        const isAsc = !!n?.a;
        const isSet = a.set === "set1" || a.set === "set2";
        const entry: Record<string, unknown> = {
          level: isAsc || isSet
            ? (typeof a.level === "number" ? a.level : lo)
            : Math.min(cursor, c.levelRange[1]),
          name: n?.n || String(a.id),
          kind: isAsc ? "ascendancy" : isSet ? "weapon_set" : (n?.k || "small"),
        };
        if (!isAsc && !isSet) cursor += 1;
        if (n?.s) entry.stats = n.s;
        if (a.note) entry.note = a.note;
        if (isSet) entry.set = a.set;
        return entry;
      });
      const skills = (c.skills || []).filter(sk => sk && sk.id).map(sk => {
        const g = gems?.get(sk.id);
        const nums = g ? mainLineAt(g, sk.level || 1) : "";
        return {
          gem: g?.name || sk.id,
          level: sk.level || 1,
          is_new: !prevSkills.has(sk.id),
          ...(nums ? { at_this_level: nums } : {}),
          supports: (sk.supports || []).filter(x => x.id).map(x => gems?.get(x.id)?.name || x.id),
          ...(sk.note ? { note: sk.note } : {}),
        };
      });
      const gear = (c.items || []).filter(it => it && (it.name || it.uniqueName)).map(it => {
        const nm = (it.name || it.uniqueName || "").trim();
        const uq = uniques?.get((it.uniqueName || nm).toLowerCase());
        return {
          slot: it.slot || "",
          name: nm,
          rarity: uq ? "unique" : (it.rarity || RARITY_RE.exec(nm)?.[1] || "normal").toLowerCase(),
          is_new: !prevItems.has((it.slot || "") + "|" + (it.name || "")),
          ...(it.base ? { base: it.base } : {}),
          ...(uq?.latest_stats ? { unique_mods: uq.latest_stats.split(" · ") } : {}),
          ...(it.mods?.length ? { mods: it.mods } : {}),
          ...(it.note ? { note: it.note } : {}),
        };
      });
      prevPassives = new Set(c.passives.map(a => String(a.id)));
      prevSkills = new Set((c.skills || []).filter(sk => sk && sk.id).map(sk => sk.id));
      prevItems = new Set((c.items || []).map(it => (it.slot || "") + "|" + (it.name || "")));
      return {
        chapter: i + 1,
        levels: [c.levelRange[0], c.levelRange[1]],
        ...(c.name ? { name: c.name } : {}),
        ...(c.description ? { description: c.description } : {}),
        ...(c.ascendancy ? { ascendancy: c.ascendancy } : {}),
        is_final: i === caps.length - 1,
        tree: {
          new_picks: picks,
          ...(removed.length ? { respec_removed: removed.map(id => TREE.nodes[id]?.n || id) } : {}),
          total_passives: c.passives.length,
        },
        skills,
        gear,
      };
    });
    return {
      format: "poe2-agent-build-summary",
      version: 1,
      build: {
        name: p?.name || "",
        class: state.klass || "",
        ascendancy: state.ascVariant || state.asc || "",
        description: p?.description || "",
      },
      chapters,
      writing_hints: {
        goal: "Write a chronological leveling guide a player can follow act by act, in the style of Mobalytics/Maxroll build guides.",
        structure: [
          "Intro: what the build does, its main skill, playstyle, pros/cons, and the defence plan (layers + which attributes/gear that implies).",
          "One section per chapter, titled by its level range (and name if present): what to level WITH (skills at their listed levels, using at_this_level numbers to ground claims), which tree picks to take in the listed order and WHY (use stats + note fields), and what gear to look for (exact bases/uniques with their mods).",
          "Call out respec_removed moments explicitly — tell the player what to refund and what replaces it.",
          "Endgame: the final chapter is the destination — summarize the finished loadout and priorities.",
        ],
        style: [
          "Cite character levels explicitly (tree picks carry a per-pick level).",
          "Reference nodes, gems and items by their exact names.",
          "notes are the author's own hints — weave them in, do not drop them.",
          "Numbers in at_this_level are real game values at that gem level; use them to justify pacing (e.g. rising mana costs).",
        ],
      },
    };
  }
  agentBtn.addEventListener("click", () => {
    if (!window.BuildwrightPlan) return;
    const text = JSON.stringify(buildAgentSummary(), null, 1);
    navigator.clipboard?.writeText(text).then(
      () => { agentBtn.textContent = "Copied ✓"; setTimeout(() => { agentBtn.textContent = "Copy for agent"; }, 1600); },
      () => { agentBtn.textContent = "Copy failed"; },
    );
  });

  // ---- floating window: open / close / drag ----
  function openGuide(): void {
    loadData().then(() => {
      render();
      viewEl!.classList.remove("hidden");
    });
  }
  function closeGuide(): void {
    viewEl!.classList.add("hidden");
    clearNodeGlow();
  }
  openBtn.addEventListener("click", openGuide);
  closeBtn.addEventListener("click", closeGuide);
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" && !viewEl!.classList.contains("hidden")) closeGuide();
  });
  // The frame lives INSIDE #viewport, whose handlers pan/zoom the tree
  // on mouse + wheel. Stop everything at the frame so reading the
  // guide never moves the canvas — the article's own wheel-scroll
  // keeps working because we only stop PROPAGATION, not the default.
  {
    const stop = (e: Event) => e.stopPropagation();
    for (const evt of ["mousedown", "mousemove", "mouseup", "wheel",
                       "touchstart", "touchmove", "touchend",
                       "pointerdown", "pointermove", "pointerup",
                       "click", "dblclick", "contextmenu"]) {
      frameEl.addEventListener(evt, stop);
    }
  }

  // Drag by the title bar. First drag converts the CSS-centered
  // position to explicit left/top, then it's simple offset tracking.
  // The move/up listeners run in CAPTURE phase so the frame's own
  // stopPropagation (above) can't starve them mid-drag.
  let dragOff: { x: number; y: number } | null = null;
  barEl.addEventListener("mousedown", e => {
    if ((e.target as HTMLElement).closest("button")) return;
    const r = frameEl!.getBoundingClientRect();
    frameEl!.style.left = r.left + "px";
    frameEl!.style.top = r.top + "px";
    frameEl!.style.transform = "none";
    dragOff = { x: e.clientX - r.left, y: e.clientY - r.top };
    e.preventDefault();
  });
  window.addEventListener("mousemove", e => {
    if (!dragOff) return;
    const x = Math.min(Math.max(e.clientX - dragOff.x, 120 - frameEl!.offsetWidth), window.innerWidth - 120);
    const y = Math.min(Math.max(e.clientY - dragOff.y, 0), window.innerHeight - 48);
    frameEl!.style.left = x + "px";
    frameEl!.style.top = y + "px";
  }, { capture: true });
  window.addEventListener("mouseup", () => { dragOff = null; resizeOff = null; }, { capture: true });

  // Custom resize handle — the native corner resizer is tiny and easy
  // to miss on a dark UI; this is a 22px gold-gripped hotspot that
  // resizes via the same capture-phase tracking as the drag.
  const resizeEl = document.getElementById("gv-resize");
  let resizeOff: { w: number; h: number; x: number; y: number } | null = null;
  resizeEl?.addEventListener("mousedown", e => {
    const r = frameEl!.getBoundingClientRect();
    // Pin the frame's position so growth goes right/down predictably.
    frameEl!.style.left = r.left + "px";
    frameEl!.style.top = r.top + "px";
    frameEl!.style.transform = "none";
    resizeOff = { w: r.width, h: r.height, x: e.clientX, y: e.clientY };
    e.preventDefault();
    e.stopPropagation();
  });
  window.addEventListener("mousemove", e => {
    if (!resizeOff) return;
    frameEl!.style.width = Math.max(380, resizeOff.w + (e.clientX - resizeOff.x)) + "px";
    frameEl!.style.height = Math.max(300, resizeOff.h + (e.clientY - resizeOff.y)) + "px";
  }, { capture: true });

  // ---- node chip interactions: live tree highlight + brown tooltip ----
  function clearNodeGlow(): void {
    if (state.searchHighlight.size) {
      state.searchHighlight = new Set();
      requestRender();
    }
    tooltip.classList.remove("show");
  }
  bodyEl.addEventListener("mouseover", e => {
    const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>(".gv-node");
    if (!chip || !chip.dataset.node) return;
    const id = chip.dataset.node;
    const n = TREE.nodes[id];
    if (!n) return;
    // Pulse the node on the live tree behind the window…
    state.searchHighlight = new Set([id]);
    requestRender();
    // …and show the tree's own brown tooltip next to the chip.
    tooltip.innerHTML = '<div class="tt-head"><div class="tt-name">' + esc(n.n || id) + "</div></div>" +
      (n.s ? '<div class="tt-stats">' + esc(n.s.replace(/; /g, "\n")) + "</div>" : "");
    tooltip.classList.add("show");
    const r = chip.getBoundingClientRect();
    const tw = tooltip.offsetWidth;
    let x = r.right + 10;
    if (x + tw > window.innerWidth - 8) x = r.left - tw - 10;
    tooltip.style.left = Math.max(8, x) + "px";
    tooltip.style.top = Math.max(8, Math.min(r.top, window.innerHeight - tooltip.offsetHeight - 8)) + "px";
  });
  bodyEl.addEventListener("mouseout", e => {
    const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>(".gv-node");
    if (chip) clearNodeGlow();
  });
  // Click a node chip → pan/zoom the tree to it (window stays open —
  // it floats, so the journey is visible right behind it).
  bodyEl.addEventListener("click", e => {
    const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>(".gv-node");
    if (!chip || !chip.dataset.node) return;
    const id = chip.dataset.node;
    focusNode(id);
    state.searchHighlight = new Set([id]);
    requestRender();
    setTimeout(() => { state.searchHighlight = new Set(); requestRender(); }, 2600);
  });
}
