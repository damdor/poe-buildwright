// ============================================================================
// === Gear strip (top-right, under skills) + edit-slot popover ==============
// ============================================================================
// Per-capture equipment as author guidance, not stat math: each slot
// carries an item NAME (a unique picked from item_catalogue.json, or
// any freetext base/rare description) plus a note ("any rare with
// +life and lightning res"). Persists as Capture.items via
// window.PoE2Plan.data.commit(items, 'items') — the plan
// schema/plumbing already existed (wizard_sync round-trips it).
// Rows carry first-party inventory art (unique art via
// UniqueStashLayout, base art via BaseItemTypes→ItemVisualIdentity)
// and GGG rarity colors; hover shows the unique's stats or the note.
// ============================================================================
import { state } from "./state.ts";
import type { Item } from "../../../../types/poe2.d.ts";

{
  interface UniqueEntry { name: string; base?: string; slot?: string; icon?: string | null; latest_stats?: string; req_level?: number; }
  interface ItemCatalogue { uniques: UniqueEntry[]; }
  interface BaseEntry {
    name: string; slot?: string; class?: string; lvl?: number; icon?: string;
    str?: number; dex?: number; int?: number;
    ar?: number; ev?: number; es?: number; ward?: number; block?: number;
    dmg?: [number, number]; aps?: number; crit?: number;
    tags?: string[];
  }
  interface ModFamily { type: string; kind: string; slots: string[]; text?: string; gates?: [string, number][][]; }

  // Slot board. `cat` = item_catalogue slot families the picker offers
  // for that slot; freetext is always allowed on top.
  const WEAPON_CATS = ["bow", "crossbow", "mace", "sceptre", "spear", "staff", "wand"];
  const OFFHAND_CATS = ["shield", "focus", "quiver"];
  const SLOTS: { key: string; label: string; cat: string[] }[] = [
    { key: "weapon1",  label: "Weapon 1",    cat: WEAPON_CATS },
    { key: "offhand1", label: "Offhand 1",   cat: OFFHAND_CATS },
    { key: "weapon2",  label: "Weapon 2",    cat: WEAPON_CATS },
    { key: "offhand2", label: "Offhand 2",   cat: OFFHAND_CATS },
    { key: "helmet",   label: "Helmet",      cat: ["helmet"] },
    { key: "body",     label: "Body Armour", cat: ["body"] },
    { key: "gloves",   label: "Gloves",      cat: ["gloves"] },
    { key: "boots",    label: "Boots",       cat: ["boots"] },
    { key: "amulet",   label: "Amulet",      cat: ["amulet", "talisman"] },
    { key: "ring1",    label: "Ring 1",      cat: ["ring"] },
    { key: "ring2",    label: "Ring 2",      cat: ["ring"] },
    { key: "belt",     label: "Belt",        cat: ["belt"] },
    { key: "flask",    label: "Flask",       cat: ["flask"] },
    { key: "jewel",    label: "Jewel",       cat: ["jewel"] },
  ];
  const slotByKey = new Map(SLOTS.map(s => [s.key, s]));

  const stripEl  = document.getElementById("gear-strip")   as HTMLElement;
  const listEl   = document.getElementById("gs-list")      as HTMLElement;
  const capLabel = document.getElementById("gs-cap-label") as HTMLElement;
  const addBtn   = document.getElementById("gs-add")       as HTMLElement;
  const popEl    = document.getElementById("gear-popover") as HTMLElement;
  const popClose = document.getElementById("gp-close")     as HTMLElement;
  const popCancel = document.getElementById("gp-cancel")   as HTMLElement;
  const popApply = document.getElementById("gp-apply")     as HTMLElement;
  const popRemove = document.getElementById("gp-remove")   as HTMLElement;
  const popSlot  = document.getElementById("gp-slot")      as HTMLSelectElement;
  const popInput = document.getElementById("gp-item-input") as HTMLInputElement;
  const popList  = document.getElementById("gp-item-list") as HTMLElement;
  const popNote  = document.getElementById("gp-note")      as HTMLTextAreaElement;
  const baseOpts   = document.getElementById("gp-base-opts")   as HTMLElement;
  const rarityTabs = document.getElementById("gp-rarity")      as HTMLElement;
  const statsInput = document.getElementById("gp-stats")       as HTMLInputElement;
  const statChips  = document.getElementById("gp-stat-chips")  as HTMLElement;
  if (!stripEl || !listEl || !capLabel || !addBtn || !popEl || !popClose ||
      !popCancel || !popApply || !popRemove || !popSlot || !popInput ||
      !popList || !popNote || !baseOpts || !rarityTabs || !statsInput || !statChips) {
    throw new Error("gear overlay: missing required DOM element");
  }

  // Uniques catalogue — fetched lazily; the strip works without it
  // (freetext-only picker) if the fetch fails.
  let uniques: UniqueEntry[] = [];
  const uniqueByName = new Map<string, UniqueEntry>();
  fetch("/assets/item_catalogue.json")
    .then(r => (r.ok ? r.json() : null))
    .then((d: ItemCatalogue | null) => {
      if (d && Array.isArray(d.uniques)) {
        uniques = d.uniques;
        for (const u of uniques) uniqueByName.set(u.name.toLowerCase(), u);
        renderStrip();
      }
    })
    .catch(() => { /* freetext-only mode */ });

  // Base catalogue (the agent grounding file doubles as the player's
  // base picker + art source for composed "Rare <Base>" items).
  // Optional — rows degrade to a slot chip, picker to uniques-only.
  let bases: BaseEntry[] = [];
  const baseIconByName = new Map<string, string>();
  const baseByName = new Map<string, BaseEntry>();
  fetch("/assets/agent/bases.json")
    .then(r => (r.ok ? r.json() : null))
    .then((d: { bases?: BaseEntry[] } | null) => {
      bases = d?.bases ?? [];
      for (const b of bases) {
        const k = b.name.toLowerCase();
        if (!baseByName.has(k)) baseByName.set(k, b);
        if (b.icon && !baseIconByName.has(k)) baseIconByName.set(k, b.icon);
      }
      if (bases.length) renderStrip();
    })
    .catch(() => { /* text-only rows */ });

  // Real rollable-mod vocabulary (176 families with CSD-rendered text
  // and the spawn tags that gate where each can roll). Optional — the
  // stats input stays freetext without it.
  let modFams: ModFamily[] = [];
  fetch("/assets/agent/mods.json")
    .then(r => (r.ok ? r.json() : null))
    .then((d: { mods?: ModFamily[] } | null) => { modFams = d?.mods ?? []; })
    .catch(() => { /* freetext-only stats */ });

  const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c
  ));

  // Rarity + art resolution for a strip row. Uniques win (exact
  // catalogue name), then the item's grounded base/rarity fields, then
  // a "Rare <Base>" name-prefix parse for freetext/agent items.
  const RARITY_RE = /^(rare|magic|normal)\s+(.+)$/i;
  function resolveRow(it: Item): { rarity: string; icon: string | null; hover: string } {
    const nm = (it.name || it.uniqueName || "").trim();
    const uq = uniqueByName.get((it.uniqueName || nm).toLowerCase());
    if (uq) {
      return { rarity: "unique", icon: uq.icon ?? null, hover: uq.latest_stats || it.note || "" };
    }
    let rarity = (it.rarity || "").toLowerCase();
    let base = it.base || "";
    if (!base) {
      const m = RARITY_RE.exec(nm);
      if (m) { rarity = rarity || m[1]!.toLowerCase(); base = m[2]!; }
    }
    const icon = base ? (baseIconByName.get(base.toLowerCase()) ?? null)
                      : (baseIconByName.get(nm.toLowerCase()) ?? null);
    const hover = [it.mods?.length ? it.mods.join(" · ") : "", it.note || ""]
      .filter(Boolean).join(" — ");
    return { rarity: rarity || "normal", icon, hover };
  }

  // ---------------------------------------------------------------
  // Item preview tooltip — the brown-popup family, structured like an
  // in-game item popup: rarity-colored name, base-stat table (defences,
  // requirements, weapon numbers), the mod list in magic-blue, and the
  // author's note. Fed by the same catalogues the pickers use.
  // ---------------------------------------------------------------
  const itemTip = document.createElement("div");
  itemTip.id = "item-tooltip";
  document.body.appendChild(itemTip);

  function baseStatsHtml(b: BaseEntry | undefined, reqLevel?: number): string {
    if (!b && !reqLevel) return "";
    const rows: [string, string][] = [];
    if (b?.dmg) rows.push(["Physical Damage", b.dmg[0] + "–" + b.dmg[1]]);
    if (b?.crit) rows.push(["Critical Hit Chance", b.crit + "%"]);
    if (b?.aps) rows.push(["Attacks per Second", String(b.aps)]);
    if (b?.ar) rows.push(["Armour", String(b.ar)]);
    if (b?.ev) rows.push(["Evasion Rating", String(b.ev)]);
    if (b?.es) rows.push(["Energy Shield", String(b.es)]);
    if (b?.ward) rows.push(["Ward", String(b.ward)]);
    if (b?.block) rows.push(["Block Chance", b.block + "%"]);
    const reqs: string[] = [];
    const lvl = reqLevel ?? b?.lvl;
    if (lvl && lvl > 1) reqs.push("Level " + lvl);
    if (b?.str) reqs.push(b.str + " Str");
    if (b?.dex) reqs.push(b.dex + " Dex");
    if (b?.int) reqs.push(b.int + " Int");
    if (reqs.length) rows.push(["Requires", reqs.join(", ")]);
    if (!rows.length) return "";
    return '<div class="tt-base">' + rows.map(([l, v]) =>
      '<div class="tt-baseline"><span class="lbl">' + esc(l) + '</span><span class="val">' + esc(v) + "</span></div>"
    ).join("") + "</div>";
  }

  function itemTipHtml(
    name: string, rarity: string, icon: string | null, metaLine: string,
    base: BaseEntry | undefined, reqLevel: number | undefined,
    mods: string[], note: string,
  ): string {
    const art = icon ? '<img class="tt-gem-ic" src="' + esc(icon) + '" alt="">' : "";
    let html = '<div class="tt-head"><div class="tt-headrow">' + art +
      '<div><div class="tt-name r-' + esc(rarity) + '">' + esc(name) + "</div>" +
      '<div class="tt-meta">' + esc(metaLine) + "</div></div></div></div>";
    html += baseStatsHtml(base, reqLevel);
    if (mods.length) {
      html += '<div class="tt-modlist">' + mods.map(m =>
        '<div class="tt-modline">' + esc(m) + "</div>").join("") + "</div>";
    }
    if (note) {
      html += '<div class="tt-note-section"><div class="tt-note-head">Note</div>' +
        '<div class="ls-tt-note">' + esc(note) + "</div></div>";
    }
    return html;
  }

  // Resolve a tip key: "unique:<name>" | "base:<name>" | "slot:<slotkey>".
  function tipHtmlFor(key: string): string | null {
    const sep = key.indexOf(":");
    if (sep < 0) return null;
    const kind = key.slice(0, sep), ref = key.slice(sep + 1);
    if (kind === "unique") {
      const u = uniqueByName.get(ref.toLowerCase());
      if (!u) return null;
      const b = u.base ? baseByName.get(u.base.toLowerCase()) : undefined;
      const mods = (u.latest_stats || "").split(" · ").filter(Boolean);
      return itemTipHtml(u.name, "unique", u.icon ?? null,
        ["Unique", u.base || "", u.slot || ""].filter(Boolean).join(" · "),
        b, u.req_level, mods, "");
    }
    if (kind === "base") {
      const b = baseByName.get(ref.toLowerCase());
      if (!b) return null;
      return itemTipHtml(b.name, "normal", b.icon ?? null,
        [b.class || "", "drop level " + (b.lvl || 1)].filter(Boolean).join(" · "),
        b, undefined, [], "");
    }
    if (kind === "slot") {
      const it = shownItems().find(x => x.slot === ref);
      if (!it) return null;
      const nm = (it.name || it.uniqueName || "").trim();
      const uq = uniqueByName.get((it.uniqueName || nm).toLowerCase());
      if (uq) {
        const b = uq.base ? baseByName.get(uq.base.toLowerCase()) : undefined;
        const mods = (uq.latest_stats || "").split(" · ").filter(Boolean);
        return itemTipHtml(uq.name, "unique", uq.icon ?? null,
          ["Unique", uq.base || "", it.slot || ""].filter(Boolean).join(" · "),
          b, uq.req_level, mods, it.note || "");
      }
      const rv = resolveRow(it);
      const baseName = it.base || RARITY_RE.exec(nm)?.[2] || nm;
      const b = baseByName.get(baseName.toLowerCase());
      return itemTipHtml(nm, rv.rarity, rv.icon,
        [b?.class || "", it.slot || ""].filter(Boolean).join(" · "),
        b, undefined, it.mods ?? [], it.note || "");
    }
    return null;
  }

  function showItemTip(key: string, anchor: HTMLElement): void {
    const html = tipHtmlFor(key);
    if (!html) return;
    itemTip.innerHTML = html;
    itemTip.classList.add("show");
    const r = anchor.getBoundingClientRect();
    const tw = itemTip.offsetWidth, th = itemTip.offsetHeight;
    let x = r.right + 12;
    if (x + tw > window.innerWidth - 8) x = r.left - tw - 12;
    if (x < 8) x = 8;
    let y = Math.min(r.top, window.innerHeight - th - 8);
    if (y < 8) y = 8;
    itemTip.style.left = x + "px";
    itemTip.style.top = y + "px";
  }
  function hideItemTip(): void { itemTip.classList.remove("show"); }
  document.addEventListener("mouseover", e => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-item-tip]");
    if (el && el.dataset.itemTip) showItemTip(el.dataset.itemTip, el);
    else hideItemTip();
  });
  document.addEventListener("scroll", hideItemTip, true);

  // The strip's capture: during replay it time-travels with the
  // slider (snapshots carry items too), otherwise the active capture.
  // EDITS always target the active capture — the popover paths exit
  // replay first so what you see is what you edit.
  function shownCapIdx(): number {
    if (!window.PoE2Plan) return -1;
    return (state.replayActive && state.replayCapIdx >= 0)
      ? state.replayCapIdx
      : window.PoE2Plan.captures.activeIndex();
  }
  function shownItems(): Item[] {
    if (!window.PoE2Plan) return [];
    const cap = window.PoE2Plan.captures.list()[shownCapIdx()]
      ?? window.PoE2Plan.captures.active();
    return (cap && cap.items) ? cap.items.slice() : [];
  }
  function activeItems(): Item[] {
    if (!window.PoE2Plan) return [];
    const cap = window.PoE2Plan.captures.active();
    return (cap && cap.items) ? cap.items.slice() : [];
  }

  // ---------------------------------------------------------------
  // Strip
  // ---------------------------------------------------------------
  function renderStrip(): void {
    if (!window.PoE2Plan) return;
    stripEl.hidden = false;
    const list = window.PoE2Plan.captures.list();
    const idx  = shownCapIdx();
    const replaying = state.replayActive && state.replayCapIdx >= 0;
    capLabel.textContent = list.length > 1
      ? (replaying ? "replay · " : "") + "snap " + (idx + 1) + "/" + list.length
      : "";
    const items = shownItems();
    listEl.innerHTML = "";
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "ss-empty";
      li.textContent = "No gear in this snapshot yet.";
      listEl.appendChild(li);
      return;
    }
    // Board order, not insertion order.
    const bySlot = new Map(items.map(it => [it.slot ?? "", it]));
    for (const s of SLOTS) {
      const it = bySlot.get(s.key);
      if (!it) continue;
      const li = document.createElement("li");
      li.className = "ss-row gs-row" + (it.note ? " has-note" : "");
      li.dataset.slot = s.key;
      const rv = resolveRow(it);
      li.dataset.itemTip = "slot:" + s.key;
      const art = rv.icon
        ? '<img class="gs-item-ic" src="' + esc(rv.icon) + '" alt="" loading="lazy">'
        : '<span class="gs-item-ic gs-ic-blank r-' + esc(rv.rarity) + '"></span>';
      li.innerHTML =
        art +
        '<span class="gs-slot-label">' + esc(s.label) + "</span>" +
        '<span class="gs-item-name r-' + esc(rv.rarity) + '">' +
          esc(it.name || it.uniqueName || "—") + "</span>" +
        (it.note ? '<span class="ss-note-dot" title="has note">✎</span>' : "");
      listEl.appendChild(li);
    }
  }

  // ---------------------------------------------------------------
  // Popover
  // ---------------------------------------------------------------
  // What guides actually write for non-unique slots: a base, a rarity
  // (usually rare), and the 1-3 mods that matter. Picking a base from
  // the list reveals the rarity toggle + priority-stats input; the
  // result persists exactly like agent-composed gear ({base, rarity,
  // mods-in-note}) so the strip renders art + rarity color for both.
  const canonSlot = (k: string): string => k.replace(/[12]$/, "");
  // bases.json slot vocabulary uses the "first" slot of each pair.
  const baseSlotOf = (k: string): string => {
    const c = canonSlot(k);
    return c === "weapon" || c === "offhand" || c === "ring" ? c + "1" : c;
  };

  // The base side of the spawn-weight gate: the base's real GGG tags
  // (int_armour, ezomyte_basetype, …) plus the class-level tags the
  // game attaches via item class (body_armour, ring, mace, armour…).
  const CLASS_TAGS: Record<string, string[]> = {
    "Body Armour": ["body_armour", "armour"],
    "Helmet": ["helmet", "armour"],
    "Gloves": ["gloves", "armour"],
    "Boots": ["boots", "armour"],
    "Shield": ["shield", "armour"], "Buckler": ["shield", "armour"],
    "Focus": ["focus"], "Quiver": ["quiver"],
    "Amulet": ["amulet"], "Talisman": ["amulet"],
    "Ring": ["ring"], "Belt": ["belt"],
    "One Hand Mace": ["mace", "weapon"], "Two Hand Mace": ["mace", "weapon"],
    "Sceptre": ["sceptre"],
    "Spear": ["spear", "weapon"], "Bow": ["bow", "weapon"],
    "Crossbow": ["crossbow", "weapon"], "Wand": ["wand", "weapon"],
    "Staff": ["staff", "weapon"], "Warstaff": ["staff", "weapon"],
  };
  function baseTags(b: BaseEntry): Set<string> {
    const t = new Set<string>(b.tags ?? []);
    for (const ct of CLASS_TAGS[b.class ?? ""] ?? []) t.add(ct);
    return t;
  }
  // Game-faithful gating: walk a gate list in order; the FIRST tag the
  // base carries ("default" matches everything) decides — weight 0 is
  // an exclusion even if a later tag is positive. A family rolls if
  // any of its gate lists says yes.
  function canRoll(fam: ModFamily, tags: Set<string>): boolean {
    if (!fam.gates?.length) return fam.slots.some(s => tags.has(s));
    return fam.gates.some(gl => {
      for (const [tag, w] of gl) {
        if (tag === "default" || tags.has(tag)) return w > 0;
      }
      return false;
    });
  }

  let draftBase: BaseEntry | null = null;  // picked base, or null
  let draftRarity = "rare";
  const RARITY_ORDER = ["normal", "magic", "rare"];
  function setRarity(r: string): void {
    draftRarity = r;
    for (const b of Array.from(rarityTabs.querySelectorAll("button"))) {
      b.classList.toggle("is-active", b.dataset.rarity === r);
    }
  }
  // Mod-count rule: no mods = normal is possible; 1-2 mods = at least
  // magic; more than two = the item is rare, period. Rarity can always
  // be chosen ABOVE the floor ("any rare of this base, mods up to you"
  // is a legitimate guide instruction), never below it.
  // Selected mods are an ordered list; the input is a SEARCH over the
  // pool, and chips toggle in/out (click again to deselect).
  let selectedMods: string[] = [];
  function enforceRarity(): void {
    const n = selectedMods.length;
    const floor = n > 2 ? "rare" : n > 0 ? "magic" : "normal";
    const fi = RARITY_ORDER.indexOf(floor);
    for (const b of Array.from(rarityTabs.querySelectorAll("button"))) {
      b.disabled = RARITY_ORDER.indexOf(b.dataset.rarity ?? "") < fi;
    }
    if (RARITY_ORDER.indexOf(draftRarity) < fi) setRarity(floor);
  }
  // The composition controls exist only while the input names the
  // picked base EXACTLY — deriving visibility on every refresh means
  // no interaction path can leave them up for a unique or freetext.
  function baseActive(): boolean {
    return !!draftBase
      && popInput.value.trim().toLowerCase() === draftBase.name.toLowerCase();
  }
  function syncBaseOpts(): void {
    const on = baseActive();
    baseOpts.classList.toggle("hidden", !on);
    if (on) { refreshChips(); enforceRarity(); }
  }
  function toggleMod(label: string): void {
    const i = selectedMods.findIndex(m => m.toLowerCase() === label.toLowerCase());
    if (i >= 0) selectedMods.splice(i, 1);
    else selectedMods.push(label);
    refreshChips();
    enforceRarity();
  }
  function chip(label: string, cls: string, title: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", () => toggleMod(label));
    return b;
  }
  function refreshChips(): void {
    statChips.innerHTML = "";
    if (!draftBase) return;
    const q = statsInput.value.trim().toLowerCase();
    const tags = baseTags(draftBase);
    const pool = modFams
      .filter(f => canRoll(f, tags))
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "prefix" ? -1 : 1));
    const poolLabels = new Set(pool.map(f => (f.text || f.type).toLowerCase()));
    const isSel = (label: string): boolean =>
      selectedMods.some(m => m.toLowerCase() === label.toLowerCase());
    // Selected-but-not-in-pool first (agent freeform mods survive the
    // round-trip as toggleable chips too).
    for (const m of selectedMods) {
      if (!poolLabels.has(m.toLowerCase())) {
        statChips.appendChild(chip(m, "gp-chip on", "custom mod — click to remove"));
      }
    }
    for (const f of pool) {
      const label = f.text || f.type;
      const sel = isSel(label);
      if (q && !sel && !label.toLowerCase().includes(q) && !f.type.toLowerCase().includes(q)) {
        continue;   // search filters the pool; selections always stay visible
      }
      const cls = "gp-chip" + (f.kind === "suffix" ? " gp-chip-suf" : "") + (sel ? " on" : "");
      statChips.appendChild(chip(label, cls, f.type + " (" + f.kind + ")"));
    }
    if (!statChips.childElementCount) {
      const none = document.createElement("span");
      none.className = "gp-chip-none";
      none.textContent = "no rollable mod matches “" + statsInput.value.trim() + "”";
      statChips.appendChild(none);
    }
  }

  let comboFocusIdx = -1;
  function refreshItemList(): void {
    const slot = slotByKey.get(popSlot.value);
    const q = (popInput.value || "").toLowerCase().trim();
    const cats = new Set(slot ? slot.cat : []);
    let pool = uniques.filter(u => !u.slot || cats.size === 0 || cats.has(u.slot));
    if (q) pool = pool.filter(u => u.name.toLowerCase().includes(q) || (u.base || "").toLowerCase().includes(q));
    const shown = pool.slice(0, q ? 8 : 12);
    popList.innerHTML = "";
    comboFocusIdx = -1;
    if (q) {
      // Freetext escape hatch first — an agent- and author-friendly
      // "use exactly what I typed" row (rare/base descriptions).
      const li = document.createElement("li");
      li.className = "gp-freetext";
      li.dataset.free = popInput.value.trim();
      li.innerHTML = 'Use “<b>' + esc(popInput.value.trim()) + "</b>” as written";
      popList.appendChild(li);
    }
    for (const u of shown) {
      const li = document.createElement("li");
      li.dataset.unique = u.name;
      li.dataset.itemTip = "unique:" + u.name;
      const art = u.icon
        ? '<img class="gp-item-ic" src="' + esc(u.icon) + '" alt="" loading="lazy">'
        : '<span class="gp-item-ic gs-ic-blank r-unique"></span>';
      li.innerHTML =
        art +
        '<span class="sp-combo-name r-unique">' + esc(u.name) + "</span>" +
        (u.base ? '<span class="sp-combo-tag">' + esc(u.base) + "</span>" : "");
      popList.appendChild(li);
    }
    // Base rows: endgame tiers first (highest drop level), filtered to
    // the slot; picking one opens the rarity + priority-stats controls.
    const bslot = baseSlotOf(popSlot.value);
    let bpool = bases.filter(b => b.slot === bslot);
    if (q) bpool = bpool.filter(b => b.name.toLowerCase().includes(q));
    bpool = bpool.slice().sort((a, b2) => (b2.lvl ?? 0) - (a.lvl ?? 0));
    const bshown = bpool.slice(0, q ? 8 : 6);
    if (bshown.length) {
      const head = document.createElement("li");
      head.className = "gp-sect";
      head.textContent = "Bases — pick one, then set rarity + stats";
      popList.appendChild(head);
      for (const b of bshown) {
        const li = document.createElement("li");
        li.dataset.base = b.name;
        li.dataset.itemTip = "base:" + b.name;
        const art = b.icon
          ? '<img class="gp-item-ic" src="' + esc(b.icon) + '" alt="" loading="lazy">'
          : '<span class="gp-item-ic gs-ic-blank r-normal"></span>';
        li.innerHTML =
          art +
          '<span class="sp-combo-name">' + esc(b.name) + "</span>" +
          '<span class="sp-combo-tag">' + esc(b.class ?? "") + (b.lvl ? " · lvl " + b.lvl : "") + "</span>";
        popList.appendChild(li);
      }
    }
    const hidden = (pool.length - shown.length) + (bpool.length - bshown.length);
    if (hidden > 0) {
      const more = document.createElement("li");
      more.className = "sp-combo-more";
      more.textContent = "+" + hidden + " more — type to refine";
      popList.appendChild(more);
    }
    if (!q && shown.length === 0 && bshown.length === 0) {
      const li = document.createElement("li");
      li.className = "sp-combo-empty";
      li.textContent = uniques.length
        ? "Nothing catalogued for this slot — type any item name."
        : "Catalogue unavailable — type any item name.";
      popList.appendChild(li);
    }
  }

  let draftUnique: string | null = null;   // picked unique name, or null for freetext
  function openPopover(slotKey: string | null): void {
    if (!popSlot.options.length) {
      for (const s of SLOTS) {
        const o = document.createElement("option");
        o.value = s.key; o.textContent = s.label;
        popSlot.appendChild(o);
      }
    }
    const items = activeItems();
    // Default to the first EMPTY slot when adding fresh.
    const firstEmpty = SLOTS.find(s => !items.some(it => it.slot === s.key));
    popSlot.value = slotKey ?? (firstEmpty ? firstEmpty.key : SLOTS[0]!.key);
    const existing = items.find(it => it.slot === popSlot.value);
    seedFromExisting(existing);
    popRemove.hidden = !existing;
    refreshItemList();
    popEl.classList.remove("hidden");
    popInput.focus();
  }
  function closePopover(): void { popEl.classList.add("hidden"); }

  // Seed the form from whatever occupies a slot (also used on slot
  // change). A composed base item re-opens with its rarity selected;
  // its stats live in the note, so the stats input starts empty.
  function seedFromExisting(existing: Item | undefined): void {
    // Composed items re-seed with their BASE name — Apply recomposes
    // "<Rarity> <Base>" from the tabs, so the round-trip is lossless.
    popInput.value = existing ? (existing.base || existing.name || existing.uniqueName || "") : "";
    popNote.value  = existing ? (existing.note || "") : "";
    draftUnique    = existing?.uniqueName || null;
    statsInput.value = "";
    selectedMods = (existing?.mods ?? []).slice();
    if (existing?.base) {
      draftBase = bases.find(b => b.name.toLowerCase() === existing.base!.toLowerCase())
        ?? { name: existing.base };
      setRarity((existing.rarity || "rare").toLowerCase());
    } else {
      draftBase = null;
      setRarity("rare");
    }
    syncBaseOpts();
  }

  function commitItems(next: Item[]): void {
    if (!window.PoE2Plan) return;
    window.PoE2Plan.data.commit(next, "items");
    window.dispatchEvent(new CustomEvent("poe2-capture-change", { detail: { reason: "items-commit" } }));
  }

  popApply.addEventListener("click", () => {
    const name = popInput.value.trim();
    if (!name) { window.PoE2Plan?.flash("Pick a unique, a base, or type an item name first", true); return; }
    const items = activeItems().filter(it => it.slot !== popSlot.value);
    let entry: Item = { slot: popSlot.value, name };
    let note = popNote.value.trim();
    if (draftUnique && draftUnique === name) {
      entry.uniqueName = draftUnique;
    } else if (baseActive()) {
      // Composed base item — same shape the agent importer produces, so
      // the strip renders identically: "Rare Hexer's Robe" + base art.
      // A normal item is just its base name, like in-game.
      enforceRarity();
      const rar = draftRarity;
      const b = draftBase!;
      entry = {
        slot: popSlot.value,
        name: rar === "normal"
          ? b.name
          : rar.charAt(0).toUpperCase() + rar.slice(1) + " " + b.name,
        base: b.name,
        rarity: rar,
      };
      if (selectedMods.length) entry.mods = selectedMods.slice();
    }
    if (note) entry.note = note;
    items.push(entry);
    commitItems(items);
    closePopover();
  });
  popRemove.addEventListener("click", () => {
    commitItems(activeItems().filter(it => it.slot !== popSlot.value));
    closePopover();
  });
  popClose.addEventListener("click", closePopover);
  popCancel.addEventListener("click", closePopover);
  popSlot.addEventListener("change", () => {
    // Re-seed the fields from whatever occupies the newly-picked slot.
    const existing = activeItems().find(it => it.slot === popSlot.value);
    seedFromExisting(existing);
    popRemove.hidden = !existing;
    refreshItemList();
  });
  popInput.addEventListener("input", () => {
    draftUnique = null;
    refreshItemList();
    syncBaseOpts();   // typing past a picked base hides the controls
  });
  rarityTabs.addEventListener("click", e => {
    const b = (e.target as HTMLElement | null)?.closest("button");
    if (b?.dataset.rarity && !b.disabled) setRarity(b.dataset.rarity);
  });
  statsInput.addEventListener("input", refreshChips);
  popList.addEventListener("click", e => {
    const li = (e.target as HTMLElement | null)?.closest("li");
    if (!li) return;
    if (li.dataset.unique) {
      popInput.value = li.dataset.unique; draftUnique = li.dataset.unique;
      draftBase = null;
    } else if (li.dataset.base) {
      const b = bases.find(x => x.name === li.dataset.base) ?? { name: li.dataset.base };
      popInput.value = b.name; draftBase = b; draftUnique = null;
    } else if (li.dataset.free) {
      popInput.value = li.dataset.free; draftUnique = null;
      draftBase = null;
    }
    refreshItemList();
    syncBaseOpts();
  });
  function exitReplayForEdit(): void {
    if (state.replayActive && typeof window.PoE2SliderExitRestore === "function") {
      window.PoE2SliderExitRestore();
    }
  }
  addBtn.addEventListener("click", () => { exitReplayForEdit(); openPopover(null); });
  listEl.addEventListener("click", e => {
    const row = (e.target as HTMLElement | null)?.closest(".gs-row") as HTMLElement | null;
    if (row && row.dataset.slot) { exitReplayForEdit(); openPopover(row.dataset.slot); }
  });
  // Esc closes (popover is modal-lite; backdrop-less like the skill one).
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" && !popEl.classList.contains("hidden")) closePopover();
  });

  window.addEventListener("poe2-capture-change", renderStrip);
  window.addEventListener("poe2-replay-scrub", renderStrip);
  function init(): void {
    if (window.PoE2Plan) renderStrip();
    else setTimeout(init, 120);
  }
  init();
}
