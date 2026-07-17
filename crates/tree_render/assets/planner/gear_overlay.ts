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
import { state, viewport } from "./state.ts";
import { requestRender } from "./render.ts";
import type { Item } from "../../../../types/poe2.d.ts";

{
  interface UniqueEntry { name: string; base?: string; slot?: string; icon?: string | null; latest_stats?: string; req_level?: number; variants?: { label: string; stats: string }[]; }
  interface ItemCatalogue { uniques: UniqueEntry[]; }
  interface BaseEntry {
    name: string; slot?: string; class?: string; lvl?: number; icon?: string;
    str?: number; dex?: number; int?: number;
    ar?: number; ev?: number; es?: number; ward?: number; block?: number;
    dmg?: [number, number]; aps?: number; crit?: number;
    tags?: string[];
    /** Granted while equipped (mined ItemSpirit / ModGrantedSkills):
     *  base Spirit (sceptres carry 100) and item-granted skills. */
    spirit?: number;
    grants?: string[];
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
      // Granted-while-equipped data lives in the deploy-generated
      // agent file (bases.json won't carry spirit/grants until the
      // full bake pipeline decodes the current patch again) — merged
      // after the base map exists; absent locally → no badges.
      return fetch("/assets/agent/granted_skills.json")
        .then(r => (r.ok ? r.json() : null))
        .then((g: { bases?: Record<string, { grants?: string[]; spirit?: number }> } | null) => {
          const gb = g?.bases ?? {};
          let hit = false;
          for (const name in gb) {
            const be = baseByName.get(name.toLowerCase());
            const entry = gb[name];
            if (!be || !entry) continue;
            if (entry.grants?.length && !be.grants) be.grants = entry.grants;
            if (entry.spirit && !be.spirit) be.spirit = entry.spirit;
            hit = true;
          }
          if (hit) renderStrip();
        });
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
      // Jewels are multi-instance: "slot:jewel#<idx>" targets one.
      const hash = ref.indexOf("#");
      const it = hash >= 0
        ? shownItems().filter(x => (x.slot ?? "") === ref.slice(0, hash))[Number(ref.slice(hash + 1))]
        : shownItems().find(x => x.slot === ref);
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
    // Board order, not insertion order. Jewels are multi-instance
    // (one per tree socket) — every jewel renders its own row.
    const bySlot = new Map(items.filter(it => (it.slot ?? "") !== "jewel").map(it => [it.slot ?? "", it]));
    const jewels = items.filter(it => (it.slot ?? "") === "jewel");
    const rowPlan: { s: { key: string; label: string }; it: Item; ji: number | null }[] = [];
    for (const s of SLOTS) {
      if (s.key === "jewel") {
        jewels.forEach((it, ji) => rowPlan.push({ s, it, ji }));
        continue;
      }
      const it = bySlot.get(s.key);
      if (it) rowPlan.push({ s, it, ji: null });
    }
    for (const { s, it, ji } of rowPlan) {
      const li = document.createElement("li");
      li.className = "ss-row gs-row" + (it.note ? " has-note" : "");
      li.dataset.slot = s.key;
      if (ji !== null) li.dataset.jewelIdx = String(ji);
      const rv = resolveRow(it);
      li.dataset.itemTip = "slot:" + s.key + (ji !== null ? "#" + ji : "");
      const art = rv.icon
        ? '<img class="gs-item-ic" src="' + esc(rv.icon) + '" alt="" loading="lazy">'
        : '<span class="gs-item-ic gs-ic-blank r-' + esc(rv.rarity) + '"></span>';
      // Granted-while-equipped badge: base spirit and/or item-granted
      // skills (from the mined grants data on bases.json). The skill
      // is free — no gem slot; supports attach in-game.
      const be = it.base ? baseByName.get(it.base.toLowerCase()) : undefined;
      let grantHtml = "";
      if (be && (be.spirit || (be.grants && be.grants.length))) {
        const bits: string[] = [];
        if (be.grants && be.grants.length) bits.push("grants " + be.grants.join(", "));
        if (be.spirit) bits.push("+" + be.spirit + " spirit");
        grantHtml = '<span class="gs-grant" title="Granted while this item is equipped — the skill needs no gem slot; supports attach in-game.">' +
          esc(bits.join(" · ")) + "</span>";
      }
      // Jewel rows: socket state badge. Socketed = where + how many
      // passives its radius covers; unsocketed = the placement CTA.
      // Socketed jewels get a locate ping (pan + glow at the socket);
      // placement itself happens on the tree — click an allocated
      // jewel socket and pick from the menu, like in-game.
      let socketHtml = "";
      if (ji !== null && it.socket != null) {
        socketHtml = '<button type="button" class="gs-locate" data-jewel-locate="' + ji +
          '" title="Show on tree">◎</button>';
      } else if (ji !== null) {
        li.title = "Unsocketed — click an allocated jewel socket on the tree to place it";
        li.classList.add("jewel-unsocketed");
      }
      li.innerHTML =
        art +
        '<span class="gs-slot-label">' + esc(s.label) + "</span>" +
        '<span class="gs-item-name r-' + esc(rv.rarity) + '">' +
          esc(it.name || it.uniqueName || "—") + "</span>" +
        socketHtml +
        grantHtml +
        (it.note ? '<span class="ss-note-dot" title="has note">✎</span>' : "");
      listEl.appendChild(li);
    }
  }

  // ---------------------------------------------------------------
  // Jewels: in-game-style socketing + GGG art overlays
  // ---------------------------------------------------------------
  // Geometry + item radii from the deploy-generated agent dataset
  // (raw tree units — the same space TREE renders, so screen pos is
  // just x*scale+tx like the note badges). The art is GGG's own:
  // Jewel_<base>.png / Jewel_U_<unique>.png socket-fill sprites and
  // the PassiveSkillScreenJewelCircle1 radius ring (Jewel_ring.png).
  //
  // Rules mirrored from the game:
  //   - a jewel can only sit in an ALLOCATED socket
  //   - one jewel per socket
  //   - a socketed radius jewel always shows its (subtle) ring
  //   - clicking an allocated socket opens the jewel picker
  interface JewelSocket { id: number; x: number; y: number; name?: string; sinister?: boolean; special?: boolean; in_radius: Record<string, number[]> }
  interface JewelData {
    rings: Record<string, { outer: number; inner: number; radius: number }>;
    bases: Record<string, { radius: number }>;
    radius_rolls: Record<string, number>;
    uniques?: Record<string, { radius?: number; ring?: string }>;
    sockets: JewelSocket[];
  }
  let jewelData: JewelData | null = null;
  const socketById = new Map<number, JewelSocket>();
  fetch("/assets/agent/jewels.json")
    .then(r => (r.ok ? r.json() : null))
    .then((d: JewelData | null) => {
      if (!d) return;
      jewelData = d;
      for (const sk of d.sockets) socketById.set(sk.id, sk);
      // Warm the overlay sprites — first locate/ring paint must not
      // wait on a network fetch.
      for (const src of ["/assets/sprites/Jewel_glow.png", "/assets/sprites/Jewel_ring.png"]) {
        new Image().src = src;
      }
      renderStrip();
      syncJewelOverlays();
      publishJewelRules();
    })
    .catch(() => { /* optional */ });

  const sanitizeArt = (n: string): string => n.replace(/[^A-Za-z0-9]/g, "_");
  // Socket-fill art fallback chain: not every unique has its own
  // JewelSocketActive sprite (only 11 do) — fall back to the BASE's
  // socket art, then to the item's 2D icon.
  function jewelArtChain(it: Item): string[] {
    const chain: string[] = [];
    const uname = it.uniqueName || (it.name && !it.base ? it.name : null);
    if (uname) {
      chain.push("/assets/sprites/Jewel_U_" + sanitizeArt(uname) + ".png");
      const u = uniques.find(x => x.name === uname);
      if (u?.base) chain.push("/assets/sprites/Jewel_" + sanitizeArt(u.base) + ".png");
      if (u?.icon) chain.push(u.icon);
    } else if (it.base) {
      chain.push("/assets/sprites/Jewel_" + sanitizeArt(it.base) + ".png");
      const b = baseByName.get(it.base.toLowerCase());
      if (b?.icon) chain.push(b.icon);
    }
    return chain;
  }
  function jewelArtFor(it: Item): string {
    return jewelArtChain(it)[0] ?? "";
  }
  // Wire an <img> to walk the chain on error instead of showing the
  // broken-image glyph.
  function applyArtChain(img: HTMLImageElement, chain: string[]): void {
    let i = 0;
    img.onerror = () => {
      i++;
      if (i < chain.length) img.src = chain[i]!;
      else img.style.display = "none";
    };
    img.style.display = "";
    img.src = chain[0] ?? "";
    if (!chain.length) img.style.display = "none";
  }

  // Which ring a jewel is rolled with: the ITEM's own mod lines win
  // ("Only affects Passives in Small Ring" — Metamorphosis rolls its
  // ring per copy); the catalogue's latest-variant entry is fallback.
  function ringNameForJewel(it: Item): string | null {
    if (!jewelData) return null;
    for (const m of it.mods ?? []) {
      const mm = /in (\w+) Ring/i.exec(m);
      if (mm && jewelData.rings[mm[1]!]) return mm[1]!;
    }
    const u = it.uniqueName || it.name;
    return (u ? jewelData.uniques?.[u]?.ring : null) ?? null;
  }
  function radiusForJewel(it: Item): number {
    if (!jewelData) return 0;
    const u = it.uniqueName || it.name;
    const uq = u ? jewelData.uniques?.[u] : undefined;
    // "in <X> Ring" = the annulus band; its visual extent is OUTER.
    const rn = ringNameForJewel(it);
    if (rn) return jewelData.rings[rn]?.outer ?? 0;
    if (uq?.radius) return uq.radius;
    let r = it.base ? (jewelData.bases[it.base]?.radius ?? 0) : 0;
    if (r > 0) {
      for (const m of it.mods ?? []) {
        // GGG's rollable radius mod reads "Upgrades Radius to Medium/
        // Large/ExtraLarge" — sizes ship in jewels.json radius_rolls
        // (+150/+300/+500). "+N to Radius" accepted as freetext too.
        const up = /Upgrades\s+Radius\s+to\s+(\w+)/i.exec(m);
        if (up) {
          const add = jewelData.radius_rolls[up[1]!] ?? 0;
          if (add > 0) { r += add; continue; }
        }
        const mm = /\+\s*\(?(\d+)\)?\s*to\s+Radius/i.exec(m);
        if (mm) r += Number(mm[1]);
      }
    }
    return r;
  }
  function ringInnerForJewel(it: Item): number {
    const rn = ringNameForJewel(it);
    return rn && jewelData ? (jewelData.rings[rn]?.inner ?? 0) : 0;
  }
  function nodesInRadius(sock: JewelSocket, radius: number, inner = 0): number[] | null {
    if (inner > 0) return sock.in_radius[inner + "-" + radius] ?? null;
    const keys = Object.keys(sock.in_radius).filter(k => !k.includes("-")).map(Number).sort((a, b) => a - b);
    let best: number | null = null;
    for (const k of keys) if (k <= radius) best = k;
    const key = sock.in_radius[String(radius)] ? radius : best;
    return key != null ? (sock.in_radius[String(key)] ?? null) : null;
  }
  // A sinister socket counts as allocated while a Voices jewel sits
  // in an allocated socket ("Allocates X Sinister Jewel sockets").
  const socketAllocated = (id: number): boolean => {
    if (state.selected.has(String(id))) return true;
    const sk = socketById.get(id);
    return !!(sk?.sinister && voicesActive());
  };
  function voicesActive(): boolean {
    return shownItems().some(it => (it.slot ?? "") === "jewel"
      && (it.name || it.uniqueName) === "Voices"
      && it.socket != null && state.selected.has(String(it.socket)));
  }

  // ---------------------------------------------------------------
  // Jewel pathing rules → window.PoE2JewelRules (pathfind consumes).
  // Recomputed on every capture change; derived from the ACTIVE
  // capture's socketed jewels sitting in allocated sockets:
  //   Split Personality        → its rolled class start becomes an
  //                              extra pathing root
  //   Controlled Metamorphosis → its ring's passives allocate
  //                              without connection
  //   Voices                   → sinister sockets activate
  // ---------------------------------------------------------------
  const ALT_START_RE = /from the (\w+)'s starting point/i;
  function publishJewelRules(): void {
    const starts: string[] = [];
    const freeAlloc: string[] = [];
    for (const it of shownItems()) {
      if ((it.slot ?? "") !== "jewel" || it.socket == null) continue;
      if (!state.selected.has(String(it.socket))) continue;
      for (const m of it.mods ?? []) {
        const sm = ALT_START_RE.exec(m);
        if (sm) starts.push(sm[1]!);
      }
      // Metamorphosis: free allocation covers the full DISC of the
      // ring's Radius field ("Passives in Radius can be Allocated…"),
      // not just the drawn annulus — the ring art is where its OTHER
      // effects apply. Identified by the unique's stat text (data).
      const u = uniques.find(x => x.name === (it.uniqueName || it.name));
      if (u && /can be Allocated without being connected/i.test(u.latest_stats || "")) {
        const sock = socketById.get(it.socket);
        // The DISC follows the item's ROLLED ring (its mods), not the
        // catalogue's latest variant.
        const rn = ringNameForJewel(it);
        const disc = rn ? (jewelData?.rings[rn]?.radius ?? 0) : radiusForJewel(it);
        if (sock && disc > 0) {
          const ids = nodesInRadius(sock, disc, 0) ?? [];
          for (const id of ids) freeAlloc.push(String(id));
        }
      }
    }
    window.PoE2JewelRules = { starts, freeAlloc, voicesActive: voicesActive() };
  }
  window.addEventListener("poe2-capture-change", publishJewelRules);
  window.addEventListener("poe2-replay-scrub", publishJewelRules);

  // --- Persistent overlays: socketed-jewel art + always-on rings ---
  // GGG shows the jewel INSIDE its socket and, for radius jewels, a
  // subtle circle whenever the jewel is slotted — so do we. One img
  // per socketed jewel (+ one ring), synced to the camera every frame
  // (the note-badge pattern; ≤ 19 elements, cheap).
  const jewelOverlay = document.getElementById("jewel-overlay") as HTMLElement | null;
  const artEls = new Map<number, HTMLImageElement>();   // socket id → jewel art
  const ringEls = new Map<number, HTMLElement>();       // socket id → ring
  // Socket node visual diameter in tree units (jewel frames render at
  // roughly keystone size). Tune here if GGG resizes frames.
  const SOCKET_ART_D = 110;
  const sinisterGlowEls = new Map<number, HTMLElement>();
  function syncSinisterGlow(): void {
    if (!jewelOverlay || !jewelData) return;
    const on = voicesActive();
    for (const sk of jewelData.sockets) {
      if (!sk.sinister) continue;
      let el = sinisterGlowEls.get(sk.id);
      if (on && !el) {
        el = document.createElement("div");
        el.className = "jewel-sinister-lit";
        jewelOverlay.appendChild(el);
        sinisterGlowEls.set(sk.id, el);
      } else if (!on && el) {
        el.remove();
        sinisterGlowEls.delete(sk.id);
      }
    }
  }
  function syncJewelOverlays(): void {
    if (!jewelOverlay || !jewelData) return;
    syncSinisterGlow();
    const items = shownItems().filter(it => (it.slot ?? "") === "jewel");
    const wanted = new Map<number, Item>();
    for (const it of items) {
      if (it.socket != null && socketById.has(it.socket) && socketAllocated(it.socket)) {
        wanted.set(it.socket, it);
      }
    }
    for (const [sid, el] of artEls) {
      if (!wanted.has(sid)) { el.remove(); artEls.delete(sid); }
    }
    for (const [sid, el] of ringEls) {
      const it = wanted.get(sid);
      if (!it || radiusForJewel(it) <= 0) { el.remove(); ringEls.delete(sid); }
    }
    for (const [sid, it] of wanted) {
      let img = artEls.get(sid);
      const src = jewelArtFor(it);
      if (!img) {
        img = document.createElement("img");
        img.className = "jewel-in-socket";
        img.alt = "";
        img.addEventListener("error", () => { img!.style.display = "none"; });
        // Size + place before first paint — otherwise the sprite
        // flashes at natural size in the corner for one frame.
        const sk = socketById.get(sid)!;
        const d0 = SOCKET_ART_D * state.scale;
        img.style.width = d0 + "px";
        img.style.height = d0 + "px";
        img.style.transform = "translate3d(" + (sk.x * state.scale + state.tx - d0 / 2) + "px, " +
          (sk.y * state.scale + state.ty - d0 / 2) + "px, 0)";
        jewelOverlay.appendChild(img);
        artEls.set(sid, img);
      }
      if (!img.dataset.artFor || img.dataset.artFor !== src) {
        img.dataset.artFor = src;
        applyArtChain(img, jewelArtChain(it));
      }
      img.title = it.name || it.base || "jewel";
      const r = radiusForJewel(it);
      if (r > 0 && !ringEls.get(sid)) {
        const ring = document.createElement("div");
        ring.className = "jewel-ring-art";
        jewelOverlay.appendChild(ring);
        ringEls.set(sid, ring);
      }
    }
  }
  function tickJewelOverlays(): void {
    if (sinisterGlowEls.size) {
      const sc = state.scale;
      for (const [sid, el] of sinisterGlowEls) {
        const sk = socketById.get(sid)!;
        const d = SOCKET_ART_D * sc;
        el.style.width = d + "px";
        el.style.height = d + "px";
        el.style.transform = "translate3d(" + (sk.x * sc + state.tx - d / 2) + "px, " +
          (sk.y * sc + state.ty - d / 2) + "px, 0)";
      }
    }
    if (artEls.size || ringEls.size) {
      const sc = state.scale;
      for (const [sid, el] of artEls) {
        const sk = socketById.get(sid)!;
        const d = SOCKET_ART_D * sc;
        el.style.width = d + "px";
        el.style.height = d + "px";
        el.style.transform = "translate3d(" + (sk.x * sc + state.tx - d / 2) + "px, " +
          (sk.y * sc + state.ty - d / 2) + "px, 0)";
      }
      const items = shownItems().filter(it => (it.slot ?? "") === "jewel");
      for (const [sid, el] of ringEls) {
        const sk = socketById.get(sid)!;
        const it = items.find(i => i.socket === sid);
        if (!it) continue;
        const d = 2 * radiusForJewel(it) * sc;
        el.style.width = d + "px";
        el.style.height = d + "px";
        el.style.transform = "translate3d(" + (sk.x * sc + state.tx - d / 2) + "px, " +
          (sk.y * sc + state.ty - d / 2) + "px, 0)";
      }
    }
    requestAnimationFrame(tickJewelOverlays);
  }
  requestAnimationFrame(tickJewelOverlays);
  window.addEventListener("poe2-capture-change", syncJewelOverlays);
  window.addEventListener("poe2-replay-scrub", syncJewelOverlays);

  // Hover ring preview for UNplaced context (row hover / picker) —
  // reuses the same GGG ring art, temporary element.
  const previewRing = document.createElement("div");
  previewRing.className = "jewel-ring-art is-preview";
  previewRing.style.display = "none";
  jewelOverlay?.appendChild(previewRing);
  let previewAt: { x: number; y: number; r: number } | null = null;
  function tickPreview(): void {
    if (!previewAt) return;
    const sc = state.scale, d = 2 * previewAt.r * sc;
    previewRing.style.width = d + "px";
    previewRing.style.height = d + "px";
    previewRing.style.transform = "translate3d(" + (previewAt.x * sc + state.tx - d / 2) + "px, " +
      (previewAt.y * sc + state.ty - d / 2) + "px, 0)";
    requestAnimationFrame(tickPreview);
  }
  function showPreviewRing(x: number, y: number, r: number): void {
    if (!jewelOverlay || r <= 0) return;
    previewAt = { x, y, r };
    previewRing.style.display = "";
    requestAnimationFrame(tickPreview);
  }
  function hidePreviewRing(): void {
    previewAt = null;
    previewRing.style.display = "none";
  }

  // --- The jewel picker: click an allocated socket, pick a jewel ---
  // (the in-game flow). Also reachable from a gear row's ⬡ badge in
  // the other direction (pick a socket for THIS jewel).
  const pickerEl = document.createElement("div");
  pickerEl.id = "jewel-picker";
  pickerEl.className = "hidden";
  document.body.appendChild(pickerEl);
  let pickerSocket: number | null = null;
  function closePicker(): void {
    pickerEl.classList.add("hidden");
    pickerSocket = null;
    hidePreviewRing();
  }
  function openPicker(socketId: number, cx: number, cy: number): void {
    const sock = socketById.get(socketId);
    if (!sock) return;
    pickerSocket = socketId;
    const items = activeItems();
    const jl = items.filter(it => (it.slot ?? "") === "jewel");
    const current = jl.find(it => it.socket === socketId);
    let html = '<div class="jp-head">' + esc(sock.name || "Jewel socket") + "</div>";
    if (sock.sinister) {
      html += '<div class="jp-note">Sinister socket — only active while the Voices jewel enables it</div>';
    } else if (sock.special) {
      html += '<div class="jp-note">Special socket — has its own rules in-game</div>';
    }
    pickerEl.innerHTML = html;
    const mkRow = (it: Item, attrs: Record<string, string>, hint: string, cls = "jp-row"): void => {
      const b = document.createElement("button");
      b.className = cls;
      for (const k in attrs) b.dataset[k] = attrs[k]!;
      const img = document.createElement("img");
      img.alt = "";
      applyArtChain(img, jewelArtChain(it));
      const nameEl = document.createElement("span");
      nameEl.textContent = it.name || it.base || "jewel";
      const hintEl = document.createElement("span");
      hintEl.className = "jp-hint";
      hintEl.textContent = hint;
      b.append(img, nameEl, hintEl);
      pickerEl.appendChild(b);
    };
    if (current) mkRow(current, { unsocket: "1" }, "unsocket", "jp-row is-current");
    jl.forEach((it, ji) => {
      if (it === current) return;
      // Voices creates the sinister sockets — it can't occupy one.
      if (sock.sinister && (it.name || it.uniqueName) === "Voices") return;
      const where = it.socket != null && it.socket !== socketId
        ? (socketById.get(it.socket)?.name || "socketed elsewhere — move here")
        : "socket here";
      mkRow(it, { pick: String(ji) }, where);
    });
    const addB = document.createElement("button");
    addB.className = "jp-row jp-new";
    addB.dataset.new = "1";
    addB.textContent = "+ add a jewel…";
    pickerEl.appendChild(addB);
    pickerEl.classList.remove("hidden");
    // Position next to the socket AFTER the content has a size.
    const pad = 8;
    const place = () => {
      const r = pickerEl.getBoundingClientRect();
      pickerEl.style.left = Math.max(pad, Math.min(cx + 14, window.innerWidth - r.width - pad)) + "px";
      pickerEl.style.top = Math.max(pad, Math.min(cy - r.height / 2, window.innerHeight - r.height - pad)) + "px";
    };
    place();
    requestAnimationFrame(place);
  }
  pickerEl.addEventListener("click", e => {
    const b = (e.target as HTMLElement | null)?.closest("button") as HTMLElement | null;
    if (!b || pickerSocket === null) return;
    const items = activeItems();
    const jl = items.filter(it => (it.slot ?? "") === "jewel");
    if (b.dataset.unsocket) {
      const cur = jl.find(it => it.socket === pickerSocket);
      if (cur) { delete cur.socket; commitItems(items); }
    } else if (b.dataset.pick != null) {
      const it = jl[Number(b.dataset.pick)];
      if (it) {
        for (const o of jl) if (o !== it && o.socket === pickerSocket) delete o.socket;
        it.socket = pickerSocket!;
        commitItems(items);
      }
    } else if (b.dataset.new) {
      const sid = pickerSocket;
      closePicker();
      exitReplayForEdit();
      pendingSocketForNew = sid;
      openPopover("jewel", null);
      return;
    }
    closePicker();
    syncJewelOverlays();
  });
  pickerEl.addEventListener("mouseover", e => {
    const b = (e.target as HTMLElement | null)?.closest("[data-pick]") as HTMLElement | null;
    const sock = pickerSocket !== null ? socketById.get(pickerSocket) : undefined;
    if (!b || !sock) return;
    const it = activeItems().filter(x => (x.slot ?? "") === "jewel")[Number(b.dataset.pick)];
    if (it) showPreviewRing(sock.x, sock.y, radiusForJewel(it));
  });
  pickerEl.addEventListener("mouseout", hidePreviewRing);
  window.addEventListener("mousedown", e => {
    if (!pickerEl.classList.contains("hidden") && !pickerEl.contains(e.target as Node)) closePicker();
  });
  // A jewel created from the picker's "+ add a jewel…" lands straight
  // in the socket the picker was opened on.
  let pendingSocketForNew: number | null = null;

  // pathfind calls this before treating a click as allocate/deallocate.
  // Handled (true) = allocated jewel socket → open the picker instead.
  window.PoE2Jewels = {
    handleSocketClick: (nodeId: string, cx: number, cy: number): boolean => {
      const id = Number(nodeId);
      if (!socketById.has(id) || !socketAllocated(id)) return false;
      openPicker(id, cx, cy);
      return true;
    },
    // Tree tooltip: what's in this socket / what state is it in.
    infoForSocket: (nodeId: string): { title: string; lines: string[] } | null => {
      const id = Number(nodeId);
      const sk = socketById.get(id);
      if (!sk) return null;
      const it = shownItems().find(x => (x.slot ?? "") === "jewel" && x.socket === id);
      if (it) {
        const lines = (it.mods ?? []).slice();
        if (!lines.length) {
          const u = uniques.find(x => x.name === (it.uniqueName || it.name));
          if (u?.latest_stats) lines.push(...u.latest_stats.split(" · "));
        }
        const r = radiusForJewel(it);
        if (r > 0) lines.push("Radius: " + r);
        return { title: it.name || it.base || "jewel", lines };
      }
      if (sk.sinister) {
        return {
          title: "Sinister socket",
          lines: [voicesActive()
            ? "Active via Voices — click to socket a jewel"
            : "Only active while a Voices jewel is socketed"],
        };
      }
      if (socketAllocated(id)) return { title: "Empty jewel socket", lines: ["Click to socket a jewel"] };
      return null;
    },
  };

  // --- Locate ping: pan to a jewel's socket + one glow breath ---
  function pingSocket(socketId: number): void {
    const sk = socketById.get(socketId);
    if (!sk || !jewelOverlay) return;
    const rect = viewport.getBoundingClientRect();
    // Overview zoom: close enough to see the socket's neighborhood
    // (and a radius ring), never the deep detail zoom.
    state.scale = Math.min(Math.max(state.scale, 0.12), 0.16);
    state.tx = rect.width / 2 - sk.x * state.scale;
    state.ty = rect.height / 2 - sk.y * state.scale;
    // The tree renders on demand — without this the CANVAS keeps the
    // old camera until the next input event while the DOM overlays
    // (synced per frame off state) already sit at the new one: the
    // glow appears "wrong" at screen center until the tree catches
    // up. This was the locate-ping ghost.
    requestRender();
    const glow = document.createElement("div");
    glow.className = "jewel-socket-glow is-ping";
    const sync = () => {
      const sc = state.scale, d = SOCKET_ART_D * 1.8 * sc;
      glow.style.width = d + "px";
      glow.style.height = d + "px";
      glow.style.transform = "translate3d(" + (sk.x * sc + state.tx - d / 2) + "px, " +
        (sk.y * sc + state.ty - d / 2) + "px, 0)";
    };
    sync();                       // sized/placed BEFORE first paint
    jewelOverlay.appendChild(glow);
    const tick = () => {
      if (!glow.isConnected) return;
      sync();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(() => glow.remove(), 2600);
  }
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" && !pickerEl.classList.contains("hidden")) closePicker();
  });
  // Row hover previews the socketed jewel's radius on the tree.
  listEl.addEventListener("mouseover", e => {
    const row = (e.target as HTMLElement | null)?.closest(".gs-row") as HTMLElement | null;
    if (!row || row.dataset.jewelIdx == null) return;
    const jl = shownItems().filter(it => (it.slot ?? "") === "jewel");
    const it = jl[Number(row.dataset.jewelIdx)];
    if (it && it.socket != null) {
      const sock = socketById.get(it.socket);
      if (sock) showPreviewRing(sock.x, sock.y, radiusForJewel(it));
    }
  });
  listEl.addEventListener("mouseout", e => {
    const row = (e.target as HTMLElement | null)?.closest(".gs-row");
    if (row) hidePreviewRing();
  });

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
    syncVariantSel();
  }

  // --- Unique variants ("Split Personality: Warrior") -------------
  // Some uniques ROLL differently (which class start, which element,
  // …). The catalogue carries current-era variants; picking one
  // stores its stat lines as the item's mods, so the choice travels
  // in plans, shares, and to agents like any other mod line.
  const variantWrap = document.createElement("div");
  variantWrap.className = "gp-variant hidden";
  variantWrap.innerHTML = '<label>Variant</label>';
  const variantSel = document.createElement("select");
  variantWrap.appendChild(variantSel);
  popInput.parentElement?.insertAdjacentElement("afterend", variantWrap);
  function currentVariants(): { label: string; stats: string }[] {
    if (!draftUnique) return [];
    const u = uniques.find(x => x.name === draftUnique);
    return u?.variants ?? [];
  }
  // Uniques the data doesn't cover yet (stats pending the PoB pin —
  // e.g. From Nothing) still ROLL — a hint steers those rolls into
  // the Notes field (this is a planner, not a PoB replacement).
  const pendingNote = document.createElement("div");
  pendingNote.className = "gp-pending hidden";
  pendingNote.textContent = "Mod data for this unique is pending — describe your copy's roll in Notes below.";
  variantWrap.insertAdjacentElement("afterend", pendingNote);
  // Read-only stat lines (with roll ranges) for the drafted unique —
  // fixed rolls; the Variant select above covers the rollable part.
  const uniqueStats = document.createElement("div");
  uniqueStats.className = "gp-unique-stats hidden";
  pendingNote.insertAdjacentElement("afterend", uniqueStats);

  function syncVariantSel(preselectMods?: string[]): void {
    void preselectMods;
    const vs = currentVariants();
    const u = draftUnique ? uniques.find(x => x.name === draftUnique) : undefined;
    const dataless = !!u && !baseActive() && !vs.length && !(u.latest_stats || "").trim();
    pendingNote.classList.toggle("hidden", !dataless);
    const lines = (u && !baseActive() ? (u.latest_stats || "") : "").split(" · ").filter(Boolean);
    uniqueStats.classList.toggle("hidden", !lines.length);
    if (lines.length) {
      uniqueStats.innerHTML = '<div class="us-head">' + esc(u!.name) + " — rolls</div>" +
        lines.map(l => '<div class="us-line">' + esc(l) + "</div>").join("");
    }
    variantWrap.classList.toggle("hidden", vs.length === 0);
    if (!vs.length) return;
    variantSel.innerHTML = "";
    // GGG's roll text uses the START POSITION's name, which for four
    // starts is the PoE1 class (mined class_start pairs: Shadow|Monk,
    // Marauder|Warrior, Duelist|Mercenary, Templar|Druid) — append
    // the PoE2 class so nobody has to know tree archaeology.
    const START_POS: Record<string, string> = {
      Shadow: "Monk", Marauder: "Warrior", Duelist: "Mercenary", Templar: "Druid",
    };
    vs.forEach((v, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      const poe2 = START_POS[v.label];
      o.textContent = (poe2 ? v.label + " (" + poe2 + "'s start)" : v.label) + " — " + v.stats;
      variantSel.appendChild(o);
    });
    if (preselectMods?.length) {
      const joined = preselectMods.join(" · ");
      const i = vs.findIndex(v => v.stats === joined);
      if (i >= 0) variantSel.value = String(i);
    }
  }
  // Affix caps, like the game: rare jewels take at most 2 prefixes +
  // 2 suffixes; other rare gear 3 + 3. (Bases that bend the rule are
  // out of scope — notes cover them.)
  function affixCap(): number {
    return popSlot.value === "jewel" ? 2 : 3;
  }
  function kindOf(label: string): string {
    return modFams.find(f => (f.text || f.type) === label)?.kind ?? "";
  }
  function toggleMod(label: string): void {
    const i = selectedMods.findIndex(m => m.toLowerCase() === label.toLowerCase());
    if (i >= 0) selectedMods.splice(i, 1);
    else {
      const kind = kindOf(label);
      if (kind === "prefix" || kind === "suffix") {
        const n = selectedMods.filter(m => kindOf(m) === kind).length;
        if (n >= affixCap()) {
          window.PoE2Plan?.flash("An item takes at most " + affixCap() + " " + kind + (affixCap() > 1 ? "es" : "") + " — remove one first", true);
          return;
        }
      }
      selectedMods.push(label);
    }
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
    const isSel = (label: string): boolean =>
      selectedMods.some(m => m.toLowerCase() === label.toLowerCase());
    // Two fixed zones: the item's chosen mods as pills up top (with
    // the affix budget), and a real SCROLLABLE list for the rollable
    // pool below — one mod per row, kind-tagged, searchable.
    if (selectedMods.length) {
      const head = document.createElement("div");
      head.className = "gp-chip-head";
      const cap = affixCap();
      const np = selectedMods.filter(m => kindOf(m) === "prefix").length;
      const ns = selectedMods.filter(m => kindOf(m) === "suffix").length;
      head.textContent = "On item — " + np + "/" + cap + " prefixes · " + ns + "/" + cap + " suffixes";
      statChips.appendChild(head);
      const onItem = document.createElement("div");
      onItem.className = "gp-on-item";
      for (const m of selectedMods) {
        const k = kindOf(m);
        const cls = "gp-chip on" + (k === "suffix" ? " gp-chip-suf" : "");
        onItem.appendChild(chip(m, cls, (k || "custom") + " — click to remove"));
      }
      statChips.appendChild(onItem);
    }
    // Pool: grouped by affix kind, so prefix/suffix is structural
    // instead of a tag you squint at. A FULL kind collapses to just
    // its header — small surface stays clean, the budget stays clear.
    const poolEl = document.createElement("div");
    poolEl.className = "gp-pool";
    let shownCount = 0;
    for (const kind of ["prefix", "suffix"]) {
      const rows = pool.filter(f =>
        f.kind === kind && !isSel(f.text || f.type) &&
        (!q || (f.text || f.type).toLowerCase().includes(q) || f.type.toLowerCase().includes(q)));
      if (!rows.length) continue;
      const cap = affixCap();
      const used = selectedMods.filter(m => kindOf(m) === kind).length;
      const full = used >= cap;
      const head = document.createElement("div");
      head.className = "gp-pool-head" + (full ? " is-full" : "");
      head.textContent = kind === "prefix" ? "Prefixes" : "Suffixes";
      head.textContent += full ? " — full (" + used + "/" + cap + ")" : " (" + used + "/" + cap + " used)";
      poolEl.appendChild(head);
      if (full) { shownCount++; continue; }
      for (const f of rows) {
        const row = chip(f.text || f.type, "gp-pool-row", f.type + " (" + kind + ")");
        poolEl.appendChild(row);
        shownCount++;
      }
    }
    if (!shownCount) {
      const none = document.createElement("span");
      none.className = "gp-chip-none";
      none.textContent = "no rollable mod matches “" + statsInput.value.trim() + "”";
      poolEl.appendChild(none);
    }
    statChips.appendChild(poolEl);
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
    if (q && shown.length === 0 && bshown.length === 0) {
      // Nothing matched: offer the typed text verbatim (freetext gear
      // descriptions stay possible without cluttering real matches).
      const li = document.createElement("li");
      li.className = "gp-freetext";
      li.dataset.free = popInput.value.trim();
      li.innerHTML = 'No match — use “<b>' + esc(popInput.value.trim()) + "</b>” as written";
      popList.appendChild(li);
    }
  }

  let draftUnique: string | null = null;   // picked unique name, or null for freetext
  // Which jewel instance the popover is editing (jewels share the
  // 'jewel' slot; identity is the index within the jewel sub-list).
  // null = editing a normal slot, or adding a NEW jewel.
  let popJewelIdx: number | null = null;
  function openPopover(slotKey: string | null, jewelIdx: number | null = null): void {
    if (!popSlot.options.length) {
      for (const s of SLOTS) {
        const o = document.createElement("option");
        o.value = s.key; o.textContent = s.label;
        popSlot.appendChild(o);
      }
    }
    popJewelIdx = jewelIdx;
    const items = activeItems();
    // Default to the first EMPTY slot when adding fresh (jewels are
    // never "full" — the jewel option always means "add another").
    const firstEmpty = SLOTS.find(s => s.key !== "jewel" && !items.some(it => it.slot === s.key));
    popSlot.value = slotKey ?? (firstEmpty ? firstEmpty.key : SLOTS[0]!.key);
    const existing = popSlot.value === "jewel"
      ? (jewelIdx !== null ? items.filter(it => (it.slot ?? "") === "jewel")[jewelIdx] : undefined)
      : items.find(it => it.slot === popSlot.value);
    seedFromExisting(existing);
    popRemove.hidden = !existing;
    refreshItemList();
    popEl.classList.remove("hidden");
    popInput.focus();
  }
  function closePopover(): void { popEl.classList.add("hidden"); pendingSocketForNew = null; }

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
    syncVariantSel(existing?.mods);
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
    const isJewel = popSlot.value === "jewel";
    let keptSocket: number | undefined;
    let items: Item[];
    if (isJewel) {
      // Replace exactly the edited instance (keeping its socket);
      // popJewelIdx === null appends a new jewel.
      items = activeItems();
      if (popJewelIdx !== null) {
        const jl = items.filter(it => (it.slot ?? "") === "jewel");
        const prev = jl[popJewelIdx];
        if (prev) {
          keptSocket = prev.socket;
          items = items.filter(it => it !== prev);
        }
      }
    } else {
      items = activeItems().filter(it => it.slot !== popSlot.value);
    }
    let entry: Item = { slot: popSlot.value, name };
    if (keptSocket != null) entry.socket = keptSocket;
    let note = popNote.value.trim();
    if (draftUnique && draftUnique === name) {
      entry.uniqueName = draftUnique;
      // Rolled variant → its stat lines are the item's mods; for
      // data-pending uniques the free-typed rolled lines are.
      const vs = currentVariants();
      const v = vs[Number(variantSel.value)];
      if (vs.length && v) entry.mods = v.stats.split(" · ");
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
      if (keptSocket != null) entry.socket = keptSocket;
      if (selectedMods.length) entry.mods = selectedMods.slice();
    }
    if (note) entry.note = note;
    // A jewel added via the socket picker's "+ add a jewel…" goes
    // straight into the socket the picker was opened on.
    if (popSlot.value === "jewel" && popJewelIdx === null && pendingSocketForNew != null) {
      if ((entry.uniqueName || entry.name) === "Voices" && socketById.get(pendingSocketForNew)?.sinister) {
        window.PoE2Plan?.flash("Voices creates the sinister sockets — it can't occupy one", true);
      } else {
        for (const it of items) {
          if ((it.slot ?? "") === "jewel" && it.socket === pendingSocketForNew) delete it.socket;
        }
        entry.socket = pendingSocketForNew;
      }
      pendingSocketForNew = null;
    }
    items.push(entry);
    commitItems(items);
    closePopover();
    syncJewelOverlays();
  });
  popRemove.addEventListener("click", () => {
    if (popSlot.value === "jewel" && popJewelIdx !== null) {
      const items = activeItems();
      const jl = items.filter(it => (it.slot ?? "") === "jewel");
      const prev = jl[popJewelIdx];
      commitItems(items.filter(it => it !== prev));
    } else {
      commitItems(activeItems().filter(it => it.slot !== popSlot.value));
    }
    closePopover();
  });
  popEl.addEventListener("wheel", e => e.stopPropagation());
  popClose.addEventListener("click", closePopover);
  popCancel.addEventListener("click", closePopover);
  popSlot.addEventListener("change", () => {
    // Re-seed the fields from whatever occupies the newly-picked slot.
    // Switching TO jewel means "new jewel" (instances are edited from
    // their own rows, not via the slot dropdown).
    if (popSlot.value === "jewel") popJewelIdx = null;
    const existing = popSlot.value === "jewel"
      ? undefined
      : activeItems().find(it => it.slot === popSlot.value);
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
    const loc = (e.target as HTMLElement | null)?.closest("[data-jewel-locate]") as HTMLElement | null;
    if (loc) {
      e.stopPropagation();
      const jl = shownItems().filter(it => (it.slot ?? "") === "jewel");
      const it = jl[Number(loc.dataset.jewelLocate)];
      if (it && it.socket != null) pingSocket(it.socket);
      return;
    }
    const row = (e.target as HTMLElement | null)?.closest(".gs-row") as HTMLElement | null;
    if (row && row.dataset.slot) {
      exitReplayForEdit();
      openPopover(row.dataset.slot, row.dataset.jewelIdx != null ? Number(row.dataset.jewelIdx) : null);
    }
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
