// ============================================================================
// === Gear + flask strips (top-right, under skills) + shared item editor ====
// ============================================================================
// Per-capture equipment as author guidance, not stat math: each slot
// carries an item NAME (a unique picked from item_catalogue.json, or
// any freetext base/rare description) plus a note ("any rare with
// +life and lightning res"). Persists as Capture.items via
// window.BuildwrightPlan.data.commit(items, 'items') — the plan
// schema/plumbing already existed (wizard_sync round-trips it).
// Rows carry first-party inventory art (unique art via
// UniqueStashLayout, base art via BaseItemTypes→ItemVisualIdentity)
// and GGG rarity colors; hover shows the unique's stats or the note.
// ============================================================================
import {
  baseAllowedForPlannerSlot,
  CHARM_SLOTS,
  featureOn,
  FLASK_SLOTS,
  GAME,
  GEAR_SLOTS,
  groundingSlot,
  ITEM_SLOTS,
  jewelAllowedInSocket,
  jewelLocateArtFor,
  jewelRadiusArtFor,
  jewelSocketArtForBase,
  plannerSlot,
  PROFILE,
} from "./game.ts";
import { loadGameAsset } from "./asset_loader.ts";
import { canRollFamily, itemDomain } from "./item_rules.ts";
import { state, viewport } from "./state.ts";
import { requestRender } from "./render.ts";
import { cascadeJewelOrphans } from "./pathfind.ts";
import { flushPersistNow } from "./wizard_sync.ts";
import { emitStateChange, PLANNER_EVENTS } from "./runtime_contract.ts";
import {
  clusterSizeForItem,
  clusterSkillsForSize,
  clusterTemplateForSize,
  configureClusterJewels,
  defaultClusterConfig,
  syncClusterJewelTrees,
} from "./cluster_jewels.ts";
import {
  migrateItemV2ToV3,
  projectEquippedItemV3ToV2,
} from "../../../../viewer/assets/plan_v3.ts";
import type { ClusterData } from "./cluster_jewels.ts";
import type {
  ActorLoadoutV3,
  InventoryOwnerV3,
  Item,
  ItemSocketV3,
} from "../../../../types/shared.d.ts";

// Games may independently gate gear and jewels. Pull the gear UI out
// only when gear itself is disabled. Jewel behavior is independently
// selected by the embedded game profile and game-owned datasets.
const GEAR_ON = featureOn("gear");
const JEWELS_ON = featureOn("jewels");
if (!GEAR_ON) {
  document.getElementById("gear-strip")?.remove();
  document.getElementById("flask-strip")?.remove();
  document.getElementById("charm-strip")?.remove();
  document.getElementById("actors-strip")?.remove();
  document.getElementById("guide-open")?.remove();
  document.getElementById("gear-popover")?.remove();
  document.getElementById("actor-popover")?.remove();
}
if (GEAR_ON) {
  interface UniqueEntry {
    name: string;
    /** Exact GGG Words.Text entry; absent for unresolved/fuzzy PoB names. */
    official_name?: string;
    base?: string;
    slot?: string;
    allowed_slots?: string[];
    icon?: string | null;
    latest_stats?: string;
    radius?: string;
    req_level?: number;
    variants?: { label: string; stats: string }[];
  }
  interface ItemCatalogue {
    uniques: UniqueEntry[];
  }
  interface BaseEntry {
    name: string;
    slot?: string;
    class?: string;
    lvl?: number;
    icon?: string;
    str?: number;
    dex?: number;
    int?: number;
    ar?: number;
    ev?: number;
    es?: number;
    ward?: number;
    block?: number;
    ar_range?: [number, number];
    ev_range?: [number, number];
    es_range?: [number, number];
    ward_range?: [number, number];
    dmg?: [number, number];
    aps?: number;
    crit?: number;
    life_recovery?: number;
    mana_recovery?: number;
    recovery_seconds?: number;
    implicits?: string[];
    allowed_slots?: string[];
    tags?: string[];
    /** Granted while equipped (mined ItemSpirit / ModGrantedSkills):
     *  base Spirit (sceptres carry 100) and item-granted skills. */
    spirit?: number;
    grants?: string[];
  }
  interface ModFamily {
    type: string;
    kind: string;
    domains?: string[];
    slots: string[];
    text?: string;
    stats?: string[];
    gates?: [string, number][][];
  }

  // Slot board. `cat` = item_catalogue slot families the picker offers
  // for that slot; freetext is always allowed on top.
  const SLOTS = ITEM_SLOTS;
  const slotByKey = new Map(SLOTS.map((s) => [s.key, s]));
  const flaskKeys = new Set(FLASK_SLOTS.map((s) => s.key));
  const charmKeys = new Set(CHARM_SLOTS.map((s) => s.key));
  const isFlaskSlot = (slot: string): boolean =>
    flaskKeys.has(plannerSlot(slot));
  const isCharmSlot = (slot: string): boolean =>
    charmKeys.has(plannerSlot(slot));

  const stripEl = document.getElementById("gear-strip") as HTMLElement;
  const listEl = document.getElementById("gs-list") as HTMLElement;
  const capLabel = document.getElementById("gs-cap-label") as HTMLElement;
  const addBtn = document.getElementById("gs-add") as HTMLElement;
  const flaskStripEl = document.getElementById("flask-strip") as HTMLElement;
  const flaskListEl = document.getElementById("fs-list") as HTMLElement;
  const flaskCapLabel = document.getElementById("fs-cap-label") as HTMLElement;
  const flaskAddBtn = document.getElementById("fs-add") as HTMLElement;
  const charmStripEl = document.getElementById("charm-strip") as HTMLElement;
  const charmListEl = document.getElementById("cs-list") as HTMLElement;
  const charmCapLabel = document.getElementById("cs-cap-label") as HTMLElement;
  const charmAddBtn = document.getElementById("cs-add") as HTMLElement;
  const actorStripEl = document.getElementById("actors-strip") as HTMLElement;
  const actorListEl = document.getElementById("as-list") as HTMLElement;
  const actorCapLabel = document.getElementById("as-cap-label") as HTMLElement;
  const actorAddBtn = document.getElementById("as-add") as HTMLButtonElement;
  const popEl = document.getElementById("gear-popover") as HTMLElement;
  const popTitle = document.getElementById("gp-title") as HTMLElement;
  const popClose = document.getElementById("gp-close") as HTMLElement;
  const popCancel = document.getElementById("gp-cancel") as HTMLElement;
  const popApply = document.getElementById("gp-apply") as HTMLElement;
  const popRemove = document.getElementById("gp-remove") as HTMLElement;
  const popSlot = document.getElementById("gp-slot") as HTMLSelectElement;
  const popInput = document.getElementById("gp-item-input") as HTMLInputElement;
  const popList = document.getElementById("gp-item-list") as HTMLElement;
  const popNote = document.getElementById("gp-note") as HTMLTextAreaElement;
  const baseOpts = document.getElementById("gp-base-opts") as HTMLElement;
  const rarityTabs = document.getElementById("gp-rarity") as HTMLElement;
  const statsInput = document.getElementById("gp-stats") as HTMLInputElement;
  const statChips = document.getElementById("gp-stat-chips") as HTMLElement;
  const itemLevelInput = document.getElementById(
    "gp-item-level",
  ) as HTMLInputElement;
  const qualityInput = document.getElementById(
    "gp-quality",
  ) as HTMLInputElement;
  const corruptedInput = document.getElementById(
    "gp-corrupted",
  ) as HTMLInputElement;
  const socketAdd = document.getElementById(
    "gp-socket-add",
  ) as HTMLButtonElement;
  const socketList = document.getElementById("gp-socket-list") as HTMLElement;
  const sourceTextInput = document.getElementById(
    "gp-source-text",
  ) as HTMLTextAreaElement;
  const actorPopEl = document.getElementById("actor-popover") as HTMLElement;
  const actorPopTitle = document.getElementById("ap-title") as HTMLElement;
  const actorPopClose = document.getElementById(
    "ap-close",
  ) as HTMLButtonElement;
  const actorKindInput = document.getElementById(
    "ap-kind",
  ) as HTMLSelectElement;
  const actorNameInput = document.getElementById("ap-name") as HTMLInputElement;
  const actorInventoryHelp = document.getElementById(
    "ap-inventory-help",
  ) as HTMLElement;
  const actorInventoryEl = document.getElementById(
    "ap-inventory",
  ) as HTMLElement;
  const actorNotesInput = document.getElementById(
    "ap-notes",
  ) as HTMLTextAreaElement;
  const actorRemove = document.getElementById("ap-remove") as HTMLButtonElement;
  const actorCancel = document.getElementById("ap-cancel") as HTMLButtonElement;
  const actorApply = document.getElementById("ap-apply") as HTMLButtonElement;
  if (
    !stripEl || !listEl || !capLabel || !addBtn || !flaskStripEl ||
    !flaskListEl || !flaskCapLabel || !flaskAddBtn || !charmStripEl ||
    !charmListEl ||
    !charmCapLabel || !charmAddBtn || !actorStripEl || !actorListEl ||
    !actorCapLabel || !actorAddBtn || !popEl || !popTitle || !popClose ||
    !popCancel || !popApply || !popRemove || !popSlot || !popInput ||
    !popList || !popNote || !baseOpts || !rarityTabs || !statsInput ||
    !statChips ||
    !itemLevelInput || !qualityInput || !corruptedInput || !socketAdd ||
    !socketList || !sourceTextInput || !actorPopEl || !actorPopTitle ||
    !actorPopClose || !actorKindInput || !actorNameInput ||
    !actorInventoryHelp || !actorInventoryEl || !actorNotesInput ||
    !actorRemove || !actorCancel || !actorApply
  ) {
    throw new Error("gear overlay: missing required DOM element");
  }
  if (!CHARM_SLOTS.length) charmStripEl.remove();

  // Uniques catalogue — fetched lazily; the strip works without it
  // (freetext-only picker) if the fetch fails.
  let uniques: UniqueEntry[] = [];
  const uniqueByName = new Map<string, UniqueEntry>();
  loadGameAsset<ItemCatalogue>("itemCatalogue")
    .then((d: ItemCatalogue | null) => {
      if (d && Array.isArray(d.uniques)) {
        uniques = d.uniques;
        for (const u of uniques) uniqueByName.set(u.name.toLowerCase(), u);
        renderStrip();
      }
    })
    .catch(() => {/* freetext-only mode */});

  // Base catalogue (the agent grounding file doubles as the player's
  // base picker + art source for composed "Rare <Base>" items).
  // Optional — rows degrade to a slot chip, picker to uniques-only.
  let bases: BaseEntry[] = [];
  const baseIconByName = new Map<string, string>();
  const baseByName = new Map<string, BaseEntry>();
  loadGameAsset<{ bases?: BaseEntry[] }>("bases")
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
      return loadGameAsset<
        { bases?: Record<string, { grants?: string[]; spirit?: number }> }
      >("grantedSkills")
        .then(
          (
            g: {
              bases?: Record<string, { grants?: string[]; spirit?: number }>;
            } | null,
          ) => {
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
          },
        );
    })
    .catch(() => {/* text-only rows */});

  // Real rollable-mod vocabulary (176 families with CSD-rendered text
  // and the spawn tags that gate where each can roll). Optional — the
  // stats input stays freetext without it.
  let modFams: ModFamily[] = [];
  loadGameAsset<{ mods?: ModFamily[] }>("mods")
    .then((d: { mods?: ModFamily[] } | null) => {
      modFams = d?.mods ?? [];
      if (PROFILE.definition.jewels.clusterExpansion) {
        syncClusterJewelTrees(shownItems(), modFams);
      }
    })
    .catch(() => {/* freetext-only stats */});

  const esc = (s: unknown): string =>
    String(s ?? "").replace(/[&<>"']/g, (c) => (
      {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c] ?? c
    ));

  // Rarity + art resolution for a strip row. Uniques win (exact
  // catalogue name), then the item's grounded base/rarity fields, then
  // a "Rare <Base>" name-prefix parse for freetext/agent items.
  const RARITY_RE = /^(rare|magic|normal)\s+(.+)$/i;
  const uniqueIcon = (u: UniqueEntry): string | null =>
    u.icon ??
      (u.base ? (baseIconByName.get(u.base.toLowerCase()) ?? null) : null);
  const itemDisplayName = (it: Item): string =>
    (it.name || it.uniqueName || it.base || "").trim();
  function displayMods(it: Item): string[] {
    const lines: string[] = [];
    if (it.cluster) {
      lines.push("Adds " + it.cluster.nodeCount + " Passive Skills");
      const skill = clusterSkillsForSize(it.cluster.size).find((s) =>
        s.id === it.cluster!.skill
      );
      if (skill) lines.push("Added Small Passive Skills grant: " + skill.stats);
      if (it.cluster.sockets > 0) {
        lines.push(
          it.cluster.sockets === 1
            ? "1 Added Passive Skill is a Jewel Socket"
            : it.cluster.sockets + " Added Passive Skills are Jewel Sockets",
        );
      }
    }
    lines.push(...(it.mods ?? []));
    return lines;
  }
  function richItemMeta(it: Item): string[] {
    const meta: string[] = [];
    if (it.itemLevel != null) meta.push("Item level " + it.itemLevel);
    if (it.quality != null) meta.push("Quality " + it.quality + "%");
    if (it.sockets?.length) {
      const linked = new Map<number, number>();
      for (const socket of it.sockets) {
        linked.set(socket.group, (linked.get(socket.group) ?? 0) + 1);
      }
      const largestLink = Math.max(...linked.values());
      meta.push(
        it.sockets.length + (it.sockets.length === 1 ? " socket" : " sockets") +
          (largestLink > 1 ? " · " + largestLink + "-linked" : ""),
      );
    }
    if (it.corrupted) meta.push("Corrupted");
    return meta;
  }
  function resolveRow(
    it: Item,
  ): { rarity: string; icon: string | null; hover: string } {
    const nm = itemDisplayName(it);
    const uq = uniqueByName.get((it.uniqueName || nm).toLowerCase());
    if (uq) {
      return {
        rarity: "unique",
        icon: uniqueIcon(uq),
        hover: uq.latest_stats || it.note || "",
      };
    }
    let rarity = (it.rarity || "").toLowerCase();
    let base = it.base || "";
    if (!base) {
      const m = RARITY_RE.exec(nm);
      if (m) {
        rarity = rarity || m[1]!.toLowerCase();
        base = m[2]!;
      }
    }
    const icon = base
      ? (baseIconByName.get(base.toLowerCase()) ?? null)
      : (baseIconByName.get(nm.toLowerCase()) ?? null);
    const shownMods = displayMods(it);
    const hover = [shownMods.length ? shownMods.join(" · ") : "", it.note || ""]
      .filter(Boolean).join(" — ");
    return { rarity: rarity || "normal", icon, hover };
  }

  // The old PoE2 picker persisted both recovery flasks and Charms as
  // `slot: "flask"`. Use the item's grounded base to display legacy
  // Charms in Charm 1; editing naturally rewrites the explicit slot.
  function itemPlannerSlot(it: Item): string {
    const nm = itemDisplayName(it);
    const uq = uniqueByName.get((it.uniqueName || nm).toLowerCase());
    const baseName = it.base || uq?.base || nm;
    return plannerSlot(it.slot ?? "", GAME.id, baseName);
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
    const ranged = (
      range: [number, number] | undefined,
      scalar: number | undefined,
    ): string => {
      if (range && range[1] > 0) {
        return range[0] === range[1]
          ? String(range[0])
          : range[0] + "–" + range[1];
      }
      return scalar ? String(scalar) : "";
    };
    if (b?.dmg) rows.push(["Physical Damage", b.dmg[0] + "–" + b.dmg[1]]);
    if (b?.crit) rows.push(["Critical Hit Chance", b.crit + "%"]);
    if (b?.aps) rows.push(["Attacks per Second", String(b.aps)]);
    const ar = ranged(b?.ar_range, b?.ar);
    if (ar) rows.push(["Armour", ar]);
    const ev = ranged(b?.ev_range, b?.ev);
    if (ev) rows.push(["Evasion Rating", ev]);
    const es = ranged(b?.es_range, b?.es);
    if (es) rows.push(["Energy Shield", es]);
    const ward = ranged(b?.ward_range, b?.ward);
    if (ward) rows.push(["Ward", ward]);
    if (b?.block) rows.push(["Block Chance", b.block + "%"]);
    if (b?.life_recovery) rows.push(["Recovers", b.life_recovery + " Life"]);
    if (b?.mana_recovery) rows.push(["Recovers", b.mana_recovery + " Mana"]);
    if (b?.recovery_seconds) {
      rows.push(["Recovery Time", b.recovery_seconds + " sec"]);
    }
    const reqs: string[] = [];
    const lvl = reqLevel ?? b?.lvl;
    if (lvl && lvl > 1) reqs.push("Level " + lvl);
    if (b?.str) reqs.push(b.str + " Str");
    if (b?.dex) reqs.push(b.dex + " Dex");
    if (b?.int) reqs.push(b.int + " Int");
    if (reqs.length) rows.push(["Requires", reqs.join(", ")]);
    if (!rows.length) return "";
    return '<div class="tt-base">' + rows.map(([l, v]) =>
      '<div class="tt-baseline"><span class="lbl">' + esc(l) +
      '</span><span class="val">' + esc(v) + "</span></div>"
    ).join("") + "</div>";
  }

  function itemTipHtml(
    name: string,
    rarity: string,
    icon: string | null,
    metaLine: string,
    base: BaseEntry | undefined,
    reqLevel: number | undefined,
    mods: string[],
    note: string,
  ): string {
    const art = icon
      ? '<img class="tt-gem-ic" src="' + esc(icon) + '" alt="">'
      : "";
    let html = '<div class="tt-head"><div class="tt-headrow">' + art +
      '<div><div class="tt-name r-' + esc(rarity) + '">' + esc(name) +
      "</div>" +
      '<div class="tt-meta">' + esc(metaLine) + "</div></div></div></div>";
    html += baseStatsHtml(base, reqLevel);
    if (base?.implicits?.length) {
      html += '<div class="tt-modlist tt-implicit">' + base.implicits.map((m) =>
        '<div class="tt-modline">' + esc(m) + "</div>"
      ).join("") + "</div>";
    }
    if (mods.length) {
      html += '<div class="tt-modlist">' + mods.map((m) =>
        '<div class="tt-modline">' + esc(m) + "</div>"
      ).join("") + "</div>";
    }
    if (note) {
      html +=
        '<div class="tt-note-section"><div class="tt-note-head">Note</div>' +
        '<div class="ls-tt-note">' + esc(note) + "</div></div>";
    }
    return html;
  }

  // Resolve a tip key: "unique:<name>" | "base:<name>" | "slot:<slotkey>".
  function tipHtmlFor(key: string): string | null {
    const sep = key.indexOf(":");
    if (sep < 0) {
      return null;
    }
    const kind = key.slice(0, sep), ref = key.slice(sep + 1);
    if (kind === "unique") {
      const u = uniqueByName.get(ref.toLowerCase());
      if (!u) {
        return null;
      }
      const b = u.base ? baseByName.get(u.base.toLowerCase()) : undefined;
      const mods = (u.latest_stats || "").split(" · ").filter(Boolean);
      return itemTipHtml(
        u.name,
        "unique",
        uniqueIcon(u),
        ["Unique", u.base || "", u.slot || ""].filter(Boolean).join(" · "),
        b,
        u.req_level,
        mods,
        "",
      );
    }
    if (kind === "base") {
      const b = baseByName.get(ref.toLowerCase());
      if (!b) {
        return null;
      }
      return itemTipHtml(
        b.name,
        "normal",
        b.icon ?? null,
        [b.class || "", "drop level " + (b.lvl || 1)].filter(Boolean).join(
          " · ",
        ),
        b,
        undefined,
        [],
        "",
      );
    }
    if (kind === "slot") {
      // Jewels are multi-instance: "slot:jewel#<idx>" targets one.
      const hash = ref.indexOf("#");
      const it = hash >= 0
        ? shownItems().filter((x) =>
          (x.slot ?? "") === ref.slice(0, hash)
        )[Number(ref.slice(hash + 1))]
        : shownItems().find((x) =>
          itemPlannerSlot(x) === plannerSlot(ref)
        );
      if (!it) return null;
      const nm = itemDisplayName(it);
      const uq = uniqueByName.get((it.uniqueName || nm).toLowerCase());
      if (uq) {
        const b = uq.base ? baseByName.get(uq.base.toLowerCase()) : undefined;
        const mods = [...new Set([
          ...(uq.latest_stats || "").split(" · ").filter(Boolean),
          ...(it.mods ?? []),
        ])];
        return itemTipHtml(
          uq.name,
          "unique",
          uniqueIcon(uq),
          ["Unique", uq.base || "", it.slot || "", ...richItemMeta(it)]
            .filter(Boolean).join(" · "),
          b,
          uq.req_level,
          mods,
          it.note || "",
        );
      }
      const rv = resolveRow(it);
      const baseName = it.base || RARITY_RE.exec(nm)?.[2] || nm;
      const b = baseByName.get(baseName.toLowerCase());
      return itemTipHtml(
        nm,
        rv.rarity,
        rv.icon,
        [b?.class || "", it.slot || "", ...richItemMeta(it)]
          .filter(Boolean).join(" · "),
        b,
        undefined,
        displayMods(it),
        it.note || "",
      );
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
  function hideItemTip(): void {
    itemTip.classList.remove("show");
  }
  document.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-item-tip]",
    );
    if (el && el.dataset.itemTip) showItemTip(el.dataset.itemTip, el);
    else hideItemTip();
  });
  document.addEventListener("scroll", hideItemTip, true);

  // The strip's capture: during replay it time-travels with the
  // slider (snapshots carry items too), otherwise the active capture.
  // EDITS always target the active capture — the popover paths exit
  // replay first so what you see is what you edit.
  function shownCapIdx(): number {
    if (!window.BuildwrightPlan) return -1;
    return (state.replayActive && state.replayCapIdx >= 0)
      ? state.replayCapIdx
      : window.BuildwrightPlan.captures.activeIndex();
  }
  function shownItems(): Item[] {
    if (!window.BuildwrightPlan) return [];
    const cap = window.BuildwrightPlan.captures.list()[shownCapIdx()] ??
      window.BuildwrightPlan.captures.active();
    return (cap && cap.items) ? cap.items.slice() : [];
  }
  function activeItems(): Item[] {
    if (!window.BuildwrightPlan) return [];
    const cap = window.BuildwrightPlan.captures.active();
    return (cap && cap.items) ? cap.items.slice() : [];
  }
  function shownActors(): ActorLoadoutV3[] {
    if (!window.BuildwrightPlan) return [];
    const route = window.BuildwrightPlan.native.route();
    return structuredClone(
      route[shownCapIdx()]?.actors ??
        route.find((candidate) =>
          candidate.id === window.BuildwrightPlan!.native.get().activeStateId
        )?.actors ??
        [],
    );
  }
  function activeNativeStateId(): string | null {
    return window.BuildwrightPlan?.native.get().activeStateId ?? null;
  }
  const actorKindLabel = (kind: ActorLoadoutV3["kind"]): string =>
    PROFILE.definition.actorKinds.find((candidate) => candidate.kind === kind)
      ?.label ?? kind;

  function renderActorStrip(captureText: string): void {
    actorStripEl.hidden = false;
    actorCapLabel.textContent = captureText;
    actorListEl.innerHTML = "";
    const actors = shownActors();
    if (!actors.length) {
      const empty = document.createElement("li");
      empty.className = "ss-empty";
      empty.textContent = "No actor loadouts in this state.";
      actorListEl.appendChild(empty);
      return;
    }
    for (const actor of actors) {
      const row = document.createElement("li");
      row.className = "ss-row as-row";
      row.dataset.actorId = actor.id;
      const count = actor.inventory?.items.length ?? 0;
      row.innerHTML = '<span class="as-name">' + esc(actor.name) + "</span>" +
        '<span class="as-items">' + count + (count === 1 ? " item" : " items") +
        "</span>" +
        '<span class="as-kind">' + esc(actorKindLabel(actor.kind)) + "</span>";
      actorListEl.appendChild(row);
    }
  }

  // ---------------------------------------------------------------
  // Strip
  // ---------------------------------------------------------------
  function renderItemBelt(
    target: HTMLElement,
    slots: typeof FLASK_SLOTS,
    bySlot: Map<string, Item>,
  ): void {
    target.innerHTML = "";
    for (const [i, s] of slots.entries()) {
      const it = bySlot.get(s.key);
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fs-slot" + (!it ? " is-empty" : "") +
        (it?.note ? " has-note" : "");
      button.dataset.slot = s.key;
      button.setAttribute(
        "aria-label",
        s.label +
          (it ? ": " + (itemDisplayName(it) || "item") : ": empty"),
      );
      const num = '<span class="fs-slot-num">' + (i + 1) + "</span>";
      if (it) {
        const rv = resolveRow(it);
        button.dataset.itemTip = "slot:" + s.key;
        const art = rv.icon
          ? '<img class="fs-item-ic" src="' + esc(rv.icon) +
            '" alt="" loading="lazy">'
          : '<span class="fs-item-ic fs-empty-ic r-' + esc(rv.rarity) +
            '"></span>';
        // Art-only in the in-tree belt. The accessible label and hover
        // card still expose the complete name, rarity, mods and notes.
        button.innerHTML = num + art;
      } else {
        button.innerHTML = num +
          '<span class="fs-empty-ic" aria-hidden="true"></span>';
      }
      li.appendChild(button);
      target.appendChild(li);
    }
  }

  function renderStrip(): void {
    if (!window.BuildwrightPlan) return;
    stripEl.hidden = false;
    flaskStripEl.hidden = false;
    if (CHARM_SLOTS.length) charmStripEl.hidden = false;
    const list = window.BuildwrightPlan.captures.list();
    const idx = shownCapIdx();
    const replaying = state.replayActive && state.replayCapIdx >= 0;
    const shown = list[idx];
    const captureText = list.length > 1
      ? (replaying ? "replay · " : "") +
        (shown?.name || "state " + (idx + 1)) + " · " + (idx + 1) + "/" +
        list.length
      : "";
    capLabel.textContent = captureText;
    flaskCapLabel.textContent = captureText;
    if (CHARM_SLOTS.length) charmCapLabel.textContent = captureText;
    renderActorStrip(captureText);
    const items = shownItems();
    listEl.innerHTML = "";
    const gearKeys = new Set(GEAR_SLOTS.map((s) => s.key));
    const hasGear = items.some((it) => gearKeys.has(itemPlannerSlot(it)));
    if (!hasGear) {
      const li = document.createElement("li");
      li.className = "ss-empty";
      li.textContent = "No gear in this state yet.";
      listEl.appendChild(li);
    }
    // Board order, not insertion order. Jewels are multi-instance
    // (one per tree socket) — every jewel renders its own row.
    const bySlot = new Map(
      items.filter((it) => (it.slot ?? "") !== "jewel")
        .map((it) => [itemPlannerSlot(it), it]),
    );
    const jewels = items.filter((it) => (it.slot ?? "") === "jewel");
    const rowPlan: {
      s: { key: string; label: string };
      it: Item;
      ji: number | null;
    }[] = [];
    for (const s of GEAR_SLOTS) {
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
        ? '<img class="gs-item-ic" src="' + esc(rv.icon) +
          '" alt="" loading="lazy">'
        : '<span class="gs-item-ic gs-ic-blank r-' + esc(rv.rarity) +
          '"></span>';
      // Granted-while-equipped badge: base spirit and/or item-granted
      // skills (from the mined grants data on bases.json). The skill
      // is free — no gem slot; supports attach in-game.
      const be = it.base ? baseByName.get(it.base.toLowerCase()) : undefined;
      let grantHtml = "";
      if (be && (be.spirit || (be.grants && be.grants.length))) {
        const bits: string[] = [];
        if (be.grants && be.grants.length) {
          bits.push("grants " + be.grants.join(", "));
        }
        if (be.spirit) bits.push("+" + be.spirit + " spirit");
        grantHtml =
          '<span class="gs-grant" title="Granted while this item is equipped — the skill needs no gem slot; supports attach in-game.">' +
          esc(bits.join(" · ")) + "</span>";
      }
      // Jewel rows: socket state badge. Socketed = where + how many
      // passives its radius covers; unsocketed = the placement CTA.
      // Socketed jewels get a locate ping (pan + glow at the socket);
      // placement itself happens on the tree — click an allocated
      // jewel socket and pick from the menu, like in-game.
      let socketHtml = "";
      if (ji !== null && it.socket != null) {
        socketHtml =
          '<button type="button" class="gs-locate" data-jewel-locate="' + ji +
          '" title="Show on tree">◎</button>';
      } else if (ji !== null) {
        li.title =
          "Unsocketed — click an allocated jewel socket on the tree to place it";
        li.classList.add("jewel-unsocketed");
      }
      li.innerHTML = art +
        '<span class="gs-slot-label">' + esc(s.label) + "</span>" +
        '<span class="gs-item-name r-' + esc(rv.rarity) + '">' +
        esc(itemDisplayName(it) || "—") + "</span>" +
        socketHtml +
        grantHtml +
        (it.note ? '<span class="ss-note-dot" title="has note">✎</span>' : "");
      listEl.appendChild(li);
    }

    // Consumable positions stay visible even while empty, mirroring
    // the horizontal belts in-game and making each section a direct
    // slot picker rather than another vertical equipment list.
    renderItemBelt(flaskListEl, FLASK_SLOTS, bySlot);
    if (CHARM_SLOTS.length) renderItemBelt(charmListEl, CHARM_SLOTS, bySlot);
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
  interface JewelSocket {
    id: number;
    x: number;
    y: number;
    name?: string;
    sinister?: boolean;
    special?: boolean;
    cluster_size?: number;
    cluster_parent?: number;
    cluster_outer?: boolean;
    in_radius: Record<string, number[]>;
  }
  interface JewelData {
    rings: Record<string, { outer: number; inner: number; radius: number }>;
    bases: Record<string, { radius: number }>;
    radius_rolls: Record<string, number>;
    uniques?: Record<
      string,
      {
        radius?: number;
        ring?: string;
        faction?: string;
        conquerors?: Record<string, number>;
      }
    >;
    sockets: JewelSocket[];
    /** Keystone-proximity lists (From Nothing): nodes within radius
     *  1000 of each keystone, the keystone itself excluded. */
    keystones?: Record<
      string,
      { id: number; x: number; y: number; in_radius: number[] }
    >;
    /** Timeless conversions: faction + conqueror_index → replacement
     *  keystone (name, csd-rendered stats, icon). */
    timeless_keystones?: {
      name: string;
      faction: string;
      conqueror_index: number;
      stats: string;
      icon: string;
    }[];
    cluster?: ClusterData;
  }
  let jewelData: JewelData | null = null;
  const socketById = new Map<number, JewelSocket>();
  const socketCoords = (socket: JewelSocket): { x: number; y: number } => {
    const dynamic = TREE.nodes[String(socket.id)];
    return dynamic ? { x: dynamic.x, y: dynamic.y } : socket;
  };
  const jewelRadiusArt = jewelRadiusArtFor(GAME.id);
  const jewelLocateArt = jewelLocateArtFor(GAME.id);
  if (JEWELS_ON) {
    loadGameAsset<JewelData>("jewels")
      .then((d: JewelData | null) => {
        if (!d) return;
        jewelData = d;
        for (const sk of d.sockets) socketById.set(sk.id, sk);
        if (PROFILE.definition.jewels.clusterExpansion && d.cluster) {
          configureClusterJewels(d.cluster);
          syncClusterJewelTrees(shownItems(), modFams);
        }
        // Warm the overlay sprites — first locate/ring paint must not
        // wait on a network fetch.
        for (const src of [jewelLocateArt, jewelRadiusArt]) {
          new Image().src = src;
        }
        renderStrip();
        syncJewelOverlays();
        publishJewelRules();
      })
      .catch(() => {/* optional */});
  }

  const sanitizeArt = (n: string): string => n.replace(/[^A-Za-z0-9]/g, "_");
  function jewelBaseName(it: Item): string {
    if (it.base) return it.base;
    const uname = it.uniqueName || it.name || "";
    const u = uniqueByName.get(uname.toLowerCase());
    if (u?.base) return u.base;
    return uname.replace(/^(?:Normal|Magic|Rare)\s+/i, "").trim();
  }
  function jewelFitsSocket(it: Item, sock: JewelSocket | undefined): boolean {
    return jewelAllowedInSocket(GAME.id, jewelBaseName(it), sock);
  }
  // Socket-fill art fallback chain: not every unique has its own
  // JewelSocketActive sprite (only 11 do) — fall back to the BASE's
  // socket art, then to the item's 2D icon.
  function jewelArtChain(it: Item): string[] {
    const chain: string[] = [];
    const uname = it.uniqueName || (it.name && !it.base ? it.name : null);
    const baseName = jewelBaseName(it);
    const native = jewelSocketArtForBase(GAME.id, baseName);
    if (native) chain.push(native);
    if (PROFILE.definition.jewels.nativeSocketArt) {
      const u = uname ? uniqueByName.get(uname.toLowerCase()) : undefined;
      if (u?.icon) chain.push(u.icon);
      else {
        const b = baseByName.get(baseName.toLowerCase());
        if (b?.icon) chain.push(b.icon);
      }
      return [...new Set(chain)];
    }
    if (uname) {
      chain.push("/assets/sprites/Jewel_U_" + sanitizeArt(uname) + ".png");
      const u = uniqueByName.get(uname.toLowerCase());
      if (u?.base) {
        chain.push("/assets/sprites/Jewel_" + sanitizeArt(u.base) + ".png");
      }
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
    const ringKey = (name: string): string | null => {
      const compact = name.replace(/\s+/g, "");
      return jewelData?.rings[compact] ? compact : null;
    };
    const lines = (it.mods ?? []).slice();
    const catalogue = uniqueByName.get(
      (it.uniqueName || it.name || "").toLowerCase(),
    );
    if (catalogue?.latest_stats) {
      lines.push(...catalogue.latest_stats.split(" · "));
    }
    for (const m of lines) {
      const mm = /in (.+?) Ring/i.exec(m);
      const key = mm ? ringKey(mm[1]!) : null;
      if (key) return key;
    }
    const u = it.uniqueName || it.name;
    const legacy = u ? jewelData.uniques?.[u]?.ring : null;
    return legacy ? ringKey(legacy) : null;
  }
  // Where a jewel's effect circle sits: socket-centered by default;
  // keystone-centered for "Radius of <Keystone>" rules (From Nothing).
  function ringSpecFor(it: Item): { x: number; y: number; r: number } | null {
    if (!jewelData || it.socket == null) return null;
    for (const m of it.mods ?? []) {
      const km = /Passives in Radius of (.+?) can be Allocated/i.exec(m);
      if (km) {
        const ks = jewelData.keystones?.[km[1]!.trim()];
        return ks ? { x: ks.x, y: ks.y, r: 1000 } : null;
      }
    }
    const sock = socketById.get(it.socket);
    const r = radiusForJewel(it);
    if (!sock || r <= 0) return null;
    const p = socketCoords(sock);
    return { x: p.x, y: p.y, r };
  }
  function radiusForJewel(it: Item): number {
    if (!jewelData) return 0;
    const u = it.uniqueName || it.name;
    const uq = u ? jewelData.uniques?.[u] : undefined;
    // "in <X> Ring" = the annulus band; its visual extent is OUTER.
    const rn = ringNameForJewel(it);
    if (rn) return jewelData.rings[rn]?.outer ?? 0;
    if (uq?.radius) return uq.radius;
    const catalogue = u ? uniqueByName.get(u.toLowerCase()) : undefined;
    if (catalogue?.radius) {
      const key = catalogue.radius.replace(/\s+/g, "");
      const ring = jewelData.rings[key];
      if (ring) return ring.radius;
    }
    let r = it.base ? (jewelData.bases[it.base]?.radius ?? 0) : 0;
    if (r > 0) {
      for (const m of it.mods ?? []) {
        // GGG's rollable radius mod reads "Upgrades Radius to Medium/
        // Large/ExtraLarge" — sizes ship in jewels.json radius_rolls
        // (+150/+300/+500). "+N to Radius" accepted as freetext too.
        const up = /Upgrades\s+Radius\s+to\s+(\w+)/i.exec(m);
        if (up) {
          const add = jewelData.radius_rolls[up[1]!] ?? 0;
          if (add > 0) {
            r += add;
            continue;
          }
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
  function nodesInRadius(
    sock: JewelSocket,
    radius: number,
    inner = 0,
  ): number[] | null {
    if (inner > 0) return sock.in_radius[inner + "-" + radius] ?? null;
    const keys = Object.keys(sock.in_radius).filter((k) => !k.includes("-"))
      .map(Number).sort((a, b) => a - b);
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
    return !!(sk?.sinister && activeSinisterIds().has(id));
  };
  function voicesItem(): Item | undefined {
    return shownItems().find((it) =>
      (it.slot ?? "") === "jewel" &&
      (it.name || it.uniqueName) === "Voices" &&
      it.socket != null &&
      jewelFitsSocket(it, socketById.get(it.socket)) &&
      state.selected.has(String(it.socket))
    );
  }
  function voicesActive(): boolean {
    return !!voicesItem();
  }
  // The roll decides HOW MANY sinister sockets activate (2/3/4).
  // Which ones: the N nearest to the Voices socket — deterministic;
  // the game data carries no explicit mapping (assumption, noted).
  function voicesCount(it: Item | undefined): number {
    for (const m of it?.mods ?? []) {
      const mm = /Allocates (\d+) Sinister/i.exec(m);
      if (mm) return Number(mm[1]);
    }
    const u = uniques.find((x) => x.name === "Voices");
    const mm = /Allocates (\d+) Sinister/i.exec(u?.latest_stats || "");
    return mm ? Number(mm[1]) : 0;
  }
  function activeSinisterIds(): Set<number> {
    const v = voicesItem();
    if (!v || !jewelData) return new Set();
    const home = socketById.get(v.socket!);
    if (!home) return new Set();
    const n = voicesCount(v);
    const sins = jewelData.sockets
      .filter((sk) => sk.sinister)
      .map((sk) => ({
        id: sk.id,
        d: (sk.x - home.x) ** 2 + (sk.y - home.y) ** 2,
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n);
    return new Set(sins.map((x) => x.id));
  }

  // ---------------------------------------------------------------
  // Jewel pathing rules → the game-neutral bridge pathfind consumes.
  // Recomputed on every capture change; derived from the ACTIVE
  // capture's socketed jewels sitting in allocated sockets:
  //   Split Personality        → its rolled class start becomes an
  //                              extra pathing root
  //   Controlled Metamorphosis → its ring's passives allocate
  //                              without connection
  //   Voices                   → sinister sockets activate
  // ---------------------------------------------------------------
  const ALT_START_RE = /from the (\w+)'s starting point/i;
  const KEYSTONE_RE = /Passives in Radius of (.+?) can be Allocated/i;
  function publishJewelRules(): void {
    const starts: string[] = [];
    const freeAlloc: string[] = [];
    const freeAllocBySocket: Record<string, string[]> = {};
    for (const it of shownItems()) {
      if ((it.slot ?? "") !== "jewel" || it.socket == null) continue;
      if (!jewelFitsSocket(it, socketById.get(it.socket))) continue;
      if (!state.selected.has(String(it.socket))) continue;
      for (const m of it.mods ?? []) {
        const sm = ALT_START_RE.exec(m);
        if (sm) starts.push(sm[1]!);
      }
      // From Nothing: free allocation around the ROLLED keystone
      // (radius 1000, keystone itself excluded — it can't be
      // allocated). Tied to this jewel's socket for lifecycle.
      for (const m of it.mods ?? []) {
        const km = KEYSTONE_RE.exec(m);
        if (!km) continue;
        const ks = jewelData?.keystones?.[km[1]!.trim()];
        if (ks) {
          const ids = ks.in_radius.map(String);
          freeAlloc.push(...ids);
          freeAllocBySocket[String(it.socket)] =
            (freeAllocBySocket[String(it.socket)] ?? []).concat(ids);
        }
      }
      // Metamorphosis: free allocation covers the full DISC of the
      // ring's Radius field ("Passives in Radius can be Allocated…"),
      // not just the drawn annulus — the ring art is where its OTHER
      // effects apply. Identified by the unique's stat text (data).
      const u = uniques.find((x) => x.name === (it.uniqueName || it.name));
      if (
        u &&
        /can be Allocated without being connected/i.test(u.latest_stats || "")
      ) {
        const sock = socketById.get(it.socket);
        // Allocation zone = the full disc bounded by the DRAWN circle
        // (the rolled ring's outer). What the player sees is what
        // allocates — nothing beyond the line.
        const disc = radiusForJewel(it);
        if (sock && disc > 0) {
          const ids = (nodesInRadius(sock, disc, 0) ?? []).map(String);
          freeAlloc.push(...ids);
          freeAllocBySocket[String(it.socket)] =
            (freeAllocBySocket[String(it.socket)] ?? []).concat(ids);
        }
      }
    }
    const before = JSON.stringify(window.BuildwrightJewelRules ?? null);
    window.BuildwrightJewelRules = {
      starts,
      freeAlloc,
      freeAllocBySocket,
      voicesActive: voicesActive(),
    };
    // Rules shrank (jewel unsocketed/moved/removed)? Ring points that
    // lost their justification fall, like in game. Only on CHANGE —
    // the sweep itself triggers a capture-change, so guard the loop.
    if (before !== JSON.stringify(window.BuildwrightJewelRules)) {
      const dropped = cascadeJewelOrphans();
      if (dropped > 0) {
        flushPersistNow(); // the sweep ran outside a click flow — persist it
        window.BuildwrightPlan?.flash(
          dropped + " disconnected ring point" + (dropped > 1 ? "s" : "") +
            " lost with the jewel",
        );
        emitStateChange("jewel-orphans");
      }
    }
  }
  function syncJewelState(): void {
    if (PROFILE.definition.jewels.clusterExpansion) {
      syncClusterJewelTrees(shownItems(), modFams);
    }
    publishJewelRules();
  }
  window.addEventListener(PLANNER_EVENTS.stateChange, syncJewelState);
  window.addEventListener(PLANNER_EVENTS.replayScrub, syncJewelState);
  window.addEventListener("buildwright-passives-change", syncJewelState);

  // --- Persistent overlays: socketed-jewel art + always-on rings ---
  // GGG shows the jewel INSIDE its socket and, for radius jewels, a
  // subtle circle whenever the jewel is slotted — so do we. One img
  // per socketed jewel (+ one ring), synced to the camera every frame
  // (the note-badge pattern; ≤ 19 elements, cheap).
  const jewelOverlay = document.getElementById("jewel-overlay") as
    | HTMLElement
    | null;
  const artEls = new Map<number, HTMLImageElement>(); // socket id → jewel art
  const ringEls = new Map<number, HTMLElement>(); // socket id → ring
  // Socket node visual diameter in tree units (jewel frames render at
  // roughly keystone size). Tune here if GGG resizes frames.
  const SOCKET_ART_D = 110;
  const sinisterGlowEls = new Map<number, HTMLElement>();
  function syncSinisterGlow(): void {
    if (!jewelOverlay || !jewelData) return;
    const active = activeSinisterIds();
    for (const sk of jewelData.sockets) {
      if (!sk.sinister) continue;
      const on = active.has(sk.id);
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
    syncConversions();
    const items = shownItems().filter((it) => (it.slot ?? "") === "jewel");
    const wanted = new Map<number, Item>();
    for (const it of items) {
      const sock = it.socket != null ? socketById.get(it.socket) : undefined;
      if (
        it.socket != null && sock && jewelFitsSocket(it, sock) &&
        socketAllocated(it.socket)
      ) {
        wanted.set(it.socket, it);
      }
    }
    for (const [sid, el] of artEls) {
      if (!wanted.has(sid)) {
        el.remove();
        artEls.delete(sid);
      }
    }
    for (const [sid, el] of ringEls) {
      const it = wanted.get(sid);
      if (!it || !ringSpecFor(it)) {
        el.remove();
        ringEls.delete(sid);
      }
    }
    for (const [sid, it] of wanted) {
      let img = artEls.get(sid);
      const src = jewelArtFor(it);
      if (!img) {
        img = document.createElement("img");
        img.className = "jewel-in-socket";
        img.alt = "";
        img.addEventListener("error", () => {
          img!.style.display = "none";
        });
        // Size + place before first paint — otherwise the sprite
        // flashes at natural size in the corner for one frame.
        const sk = socketById.get(sid)!;
        const p = socketCoords(sk);
        const d0 = SOCKET_ART_D * state.scale;
        img.style.width = d0 + "px";
        img.style.height = d0 + "px";
        img.style.transform = "translate3d(" +
          (p.x * state.scale + state.tx - d0 / 2) + "px, " +
          (p.y * state.scale + state.ty - d0 / 2) + "px, 0)";
        jewelOverlay.appendChild(img);
        artEls.set(sid, img);
      }
      if (!img.dataset.artFor || img.dataset.artFor !== src) {
        img.dataset.artFor = src;
        applyArtChain(img, jewelArtChain(it));
      }
      img.title = it.name || it.base || "jewel";
      if (ringSpecFor(it) && !ringEls.get(sid)) {
        const ring = document.createElement("div");
        ring.className = "jewel-ring-art";
        ring.style.backgroundImage = 'url("' + jewelRadiusArt + '")';
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
        const p = socketCoords(sk);
        const d = SOCKET_ART_D * sc;
        el.style.width = d + "px";
        el.style.height = d + "px";
        el.style.transform = "translate3d(" + (p.x * sc + state.tx - d / 2) +
          "px, " +
          (p.y * sc + state.ty - d / 2) + "px, 0)";
      }
    }
    if (convEls.size && jewelData?.keystones) {
      const sc = state.scale;
      const byId = new Map(
        Object.values(jewelData.keystones).map((k) => [String(k.id), k]),
      );
      for (const [nid, el] of convEls) {
        const ks = byId.get(nid);
        if (!ks) continue;
        const d = 68 * sc; // keystone icon footprint, tree units
        el.style.width = d + "px";
        el.style.height = d + "px";
        el.style.transform = "translate3d(" + (ks.x * sc + state.tx - d / 2) +
          "px, " +
          (ks.y * sc + state.ty - d / 2) + "px, 0)";
      }
    }
    if (artEls.size || ringEls.size) {
      const sc = state.scale;
      for (const [sid, el] of artEls) {
        const sk = socketById.get(sid)!;
        const p = socketCoords(sk);
        const d = SOCKET_ART_D * sc;
        el.style.width = d + "px";
        el.style.height = d + "px";
        el.style.transform = "translate3d(" + (p.x * sc + state.tx - d / 2) +
          "px, " +
          (p.y * sc + state.ty - d / 2) + "px, 0)";
      }
      const items = shownItems().filter((it) => (it.slot ?? "") === "jewel");
      for (const [sid, el] of ringEls) {
        const it = items.find((i) => i.socket === sid);
        const spec = it ? ringSpecFor(it) : null;
        if (!spec) continue;
        const d = 2 * spec.r * sc;
        el.style.width = d + "px";
        el.style.height = d + "px";
        el.style.transform = "translate3d(" + (spec.x * sc + state.tx - d / 2) +
          "px, " +
          (spec.y * sc + state.ty - d / 2) + "px, 0)";
      }
    }
    requestAnimationFrame(tickJewelOverlays);
  }
  requestAnimationFrame(tickJewelOverlays);
  window.addEventListener(PLANNER_EVENTS.stateChange, syncJewelOverlays);
  window.addEventListener(PLANNER_EVENTS.replayScrub, syncJewelOverlays);

  // Hover ring preview for UNplaced context (row hover / picker) —
  // reuses the same GGG ring art, temporary element.
  const previewRing = document.createElement("div");
  previewRing.className = "jewel-ring-art is-preview";
  previewRing.style.backgroundImage = 'url("' + jewelRadiusArt + '")';
  previewRing.style.display = "none";
  jewelOverlay?.appendChild(previewRing);
  let previewAt: { x: number; y: number; r: number } | null = null;
  function tickPreview(): void {
    if (!previewAt) return;
    const sc = state.scale, d = 2 * previewAt.r * sc;
    previewRing.style.width = d + "px";
    previewRing.style.height = d + "px";
    previewRing.style.transform = "translate3d(" +
      (previewAt.x * sc + state.tx - d / 2) + "px, " +
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
    const jl = items.filter((it) => (it.slot ?? "") === "jewel");
    const current = jl.find((it) => it.socket === socketId);
    let html = '<div class="jp-head">' + esc(sock.name || "Jewel socket") +
      "</div>";
    if (sock.sinister) {
      html +=
        '<div class="jp-note">Sinister socket — only active while the Voices jewel enables it</div>';
    } else if (sock.special) {
      html +=
        '<div class="jp-note">Special socket — has its own rules in-game</div>';
    }
    if (
      PROFILE.definition.jewels.clusterExpansion && sock.cluster_size == null
    ) {
      html +=
        '<div class="jp-note">This is an ordinary jewel socket; cluster jewels require an expansion socket.</div>';
    } else if (
      PROFILE.definition.jewels.clusterExpansion && sock.cluster_size != null
    ) {
      const maxSize = ["Small", "Medium", "Large"][sock.cluster_size] ??
        "compatible";
      html += '<div class="jp-note">Expansion socket — accepts up to a ' +
        maxSize + " Cluster Jewel.</div>";
    }
    pickerEl.innerHTML = html;
    const mkRow = (
      it: Item,
      attrs: Record<string, string>,
      hint: string,
      cls = "jp-row",
    ): void => {
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
    if (current) {
      mkRow(current, { unsocket: "1" }, "unsocket", "jp-row is-current");
    }
    jl.forEach((it, ji) => {
      if (it === current) {
        return;
      }
      if (!jewelFitsSocket(it, sock)) {
        return;
      }
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
      pickerEl.style.left =
        Math.max(pad, Math.min(cx + 14, window.innerWidth - r.width - pad)) +
        "px";
      pickerEl.style.top = Math.max(
        pad,
        Math.min(cy - r.height / 2, window.innerHeight - r.height - pad),
      ) + "px";
    };
    place();
    requestAnimationFrame(place);
  }
  pickerEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement | null)?.closest("button") as
      | HTMLElement
      | null;
    if (!b || pickerSocket === null) return;
    const items = activeItems();
    const jl = items.filter((it) => (it.slot ?? "") === "jewel");
    if (b.dataset.unsocket) {
      const cur = jl.find((it) => it.socket === pickerSocket);
      if (cur) {
        delete cur.socket;
        commitItems(items);
      }
    } else if (b.dataset.pick != null) {
      const it = jl[Number(b.dataset.pick)];
      if (it) {
        const sock = socketById.get(pickerSocket);
        if (!jewelFitsSocket(it, sock)) {
          window.BuildwrightPlan?.flash(
            "That cluster jewel is too large for this expansion socket",
            true,
          );
          return;
        }
        for (const o of jl) {
          if (o !== it && o.socket === pickerSocket) delete o.socket;
        }
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
  pickerEl.addEventListener("mouseover", (e) => {
    const b = (e.target as HTMLElement | null)?.closest("[data-pick]") as
      | HTMLElement
      | null;
    const sock = pickerSocket !== null
      ? socketById.get(pickerSocket)
      : undefined;
    if (!b || !sock) return;
    const it = activeItems().filter((x) =>
      (x.slot ?? "") === "jewel"
    )[Number(b.dataset.pick)];
    if (it) {
      const p = socketCoords(sock);
      showPreviewRing(p.x, p.y, radiusForJewel(it));
    }
  });
  pickerEl.addEventListener("mouseout", hidePreviewRing);
  window.addEventListener("mousedown", (e) => {
    if (
      !pickerEl.classList.contains("hidden") &&
      !pickerEl.contains(e.target as Node)
    ) closePicker();
  });
  // A jewel created from the picker's "+ add a jewel…" lands straight
  // in the socket the picker was opened on.
  let pendingSocketForNew: number | null = null;

  // pathfind calls this before treating a click as allocate/deallocate.
  // Handled (true) = allocated jewel socket → open the picker instead.
  window.BuildwrightJewels = {
    handleSocketClick: (nodeId: string, cx: number, cy: number): boolean => {
      const id = Number(nodeId);
      if (!socketById.has(id) || !socketAllocated(id)) return false;
      openPicker(id, cx, cy);
      return true;
    },
    // Tree tooltip: a converted keystone says what it becomes.
    conversionForKeystone: (
      nodeId: string,
    ): { title: string; lines: string[] } | null => {
      const conv = convCache.get(nodeId) ?? convertedKeystones().get(nodeId);
      if (!conv) return null;
      return {
        title: "Becomes " + conv.name + " (" + conv.jewel + " — " +
          conv.conqueror + ")",
        lines: conv.stats ? conv.stats.split(" · ") : ["(stat text pending)"],
      };
    },
    // Tree tooltip: what's in this socket / what state is it in.
    infoForSocket: (
      nodeId: string,
    ): { title: string; lines: string[] } | null => {
      const id = Number(nodeId);
      const sk = socketById.get(id);
      if (!sk) return null;
      const it = shownItems().find((x) =>
        (x.slot ?? "") === "jewel" && x.socket === id
      );
      if (it) {
        if (!jewelFitsSocket(it, sk)) {
          return {
            title: "Invalid cluster-jewel placement",
            lines: ["Move this jewel to a compatible expansion socket"],
          };
        }
        const lines = (it.mods ?? []).slice();
        if (!lines.length) {
          const u = uniques.find((x) => x.name === (it.uniqueName || it.name));
          if (u?.latest_stats) lines.push(...u.latest_stats.split(" · "));
        }
        const r = radiusForJewel(it);
        if (r > 0) lines.push("Radius: " + r);
        return { title: it.name || it.base || "jewel", lines };
      }
      if (sk.sinister) {
        return {
          title: "Sinister socket",
          lines: [
            activeSinisterIds().has(id)
              ? "Active via Voices — click to socket a jewel"
              : voicesActive()
              ? "Not among the " + voicesCount(voicesItem()) +
                " sockets this Voices roll activates"
              : "Only active while a Voices jewel is socketed",
          ],
        };
      }
      if (socketAllocated(id)) {
        return {
          title: "Empty jewel socket",
          lines: ["Click to socket a jewel"],
        };
      }
      return null;
    },
  };

  // --- Timeless conversions: keystones in a socketed timeless
  // jewel's radius BECOME the faction keystone keyed by the rolled
  // conqueror. Everything resolves from jewels.json per bake:
  // faction + conqueror indices on the unique, replacement
  // name/stats/icon in timeless_keystones, geometry from keystone
  // and socket positions. ---
  interface TimelessConv {
    name: string;
    stats: string;
    icon: string;
    jewel: string;
    conqueror: string;
  }
  function timelessConversionFor(it: Item): TimelessConv | null {
    if (!jewelData) return null;
    const uname = it.uniqueName || it.name;
    const u = uname ? jewelData.uniques?.[uname] : undefined;
    if (!u?.faction || !u.conquerors) return null;
    // The rolled conqueror rides in the item's variant mods.
    const modText = (it.mods ?? []).join(" ");
    const conq = Object.keys(u.conquerors).find((c) => modText.includes(c));
    if (!conq) return null;
    const idx = u.conquerors[conq]!;
    const tk = jewelData.timeless_keystones?.find(
      (t) => t.faction === u.faction && t.conqueror_index === idx,
    );
    return tk
      ? {
        name: tk.name,
        stats: tk.stats,
        icon: tk.icon,
        jewel: uname!,
        conqueror: conq,
      }
      : null;
  }
  /** node id (string) → conversion, for every keystone inside a
   *  socketed+allocated timeless jewel's radius. */
  function convertedKeystones(): Map<string, TimelessConv> {
    const out = new Map<string, TimelessConv>();
    if (!jewelData?.keystones) return out;
    for (const it of shownItems()) {
      if ((it.slot ?? "") !== "jewel" || it.socket == null) continue;
      if (!state.selected.has(String(it.socket))) continue;
      const conv = timelessConversionFor(it);
      if (!conv) continue;
      const sock = socketById.get(it.socket);
      const r = radiusForJewel(it);
      if (!sock || r <= 0) continue;
      const p = socketCoords(sock);
      const rr = r * r;
      for (const kn in jewelData.keystones) {
        const ks = jewelData.keystones[kn]!;
        const dx = ks.x - p.x, dy = ks.y - p.y;
        if (dx * dx + dy * dy <= rr) out.set(String(ks.id), conv);
      }
    }
    return out;
  }
  // Replacement-keystone art overlaid on converted keystones.
  const convEls = new Map<string, HTMLImageElement>();
  let convCache = new Map<string, TimelessConv>();
  function syncConversions(): void {
    if (!jewelOverlay) return;
    convCache = convertedKeystones();
    for (const [nid, el] of convEls) {
      if (!convCache.has(nid)) {
        el.remove();
        convEls.delete(nid);
      }
    }
    for (const [nid, conv] of convCache) {
      let img = convEls.get(nid);
      if (!img) {
        img = document.createElement("img");
        img.className = "jewel-in-socket"; // same camera-synced style
        img.alt = "";
        img.addEventListener("error", () => {
          img!.style.display = "none";
        });
        jewelOverlay.appendChild(img);
        convEls.set(nid, img);
      }
      if (!img.src.endsWith(conv.icon)) {
        img.src = conv.icon;
        img.style.display = "";
      }
      img.title = "Becomes " + conv.name;
    }
  }

  // --- Locate ping: pan to a jewel's socket + one glow breath ---
  function pingSocket(socketId: number): void {
    const sk = socketById.get(socketId);
    if (!sk || !jewelOverlay) return;
    const p = socketCoords(sk);
    const rect = viewport.getBoundingClientRect();
    // Overview zoom: close enough to see the socket's neighborhood
    // (and a radius ring), never the deep detail zoom.
    state.scale = Math.min(Math.max(state.scale, 0.12), 0.16);
    state.tx = rect.width / 2 - p.x * state.scale;
    state.ty = rect.height / 2 - p.y * state.scale;
    // The tree renders on demand — without this the CANVAS keeps the
    // old camera until the next input event while the DOM overlays
    // (synced per frame off state) already sit at the new one: the
    // glow appears "wrong" at screen center until the tree catches
    // up. This was the locate-ping ghost.
    requestRender();
    const glow = document.createElement("div");
    glow.className = "jewel-socket-glow is-ping";
    glow.style.backgroundImage = 'url("' + jewelLocateArt + '")';
    const sync = () => {
      const sc = state.scale, d = SOCKET_ART_D * 1.8 * sc;
      glow.style.width = d + "px";
      glow.style.height = d + "px";
      glow.style.transform = "translate3d(" + (p.x * sc + state.tx - d / 2) +
        "px, " +
        (p.y * sc + state.ty - d / 2) + "px, 0)";
    };
    sync(); // sized/placed BEFORE first paint
    jewelOverlay.appendChild(glow);
    const tick = () => {
      if (!glow.isConnected) return;
      sync();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(() => glow.remove(), 2600);
  }
  window.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" && !pickerEl.classList.contains("hidden")
    ) closePicker();
  });
  // Row hover previews the socketed jewel's radius on the tree.
  listEl.addEventListener("mouseover", (e) => {
    const row = (e.target as HTMLElement | null)?.closest(".gs-row") as
      | HTMLElement
      | null;
    if (!row || row.dataset.jewelIdx == null) return;
    const jl = shownItems().filter((it) => (it.slot ?? "") === "jewel");
    const it = jl[Number(row.dataset.jewelIdx)];
    if (it && it.socket != null) {
      const spec = ringSpecFor(it);
      if (spec) showPreviewRing(spec.x, spec.y, spec.r);
    }
  });
  listEl.addEventListener("mouseout", (e) => {
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
  const baseSlotOf = groundingSlot;

  // The base side of the spawn-weight gate: the base's real GGG tags
  // (int_armour, ezomyte_basetype, …) plus the class-level tags the
  // game attaches via item class (body_armour, ring, mace, armour…).
  const CLASS_TAGS: Record<string, string[]> = {
    "Body Armour": ["body_armour", "armour"],
    "Helmet": ["helmet", "armour"],
    "Gloves": ["gloves", "armour"],
    "Boots": ["boots", "armour"],
    "Shield": ["shield", "armour"],
    "Buckler": ["shield", "armour"],
    "Focus": ["focus"],
    "Quiver": ["quiver"],
    "Amulet": ["amulet"],
    "Talisman": ["amulet"],
    "Ring": ["ring"],
    "Belt": ["belt"],
    "Claw": ["claw", "weapon"],
    "Dagger": ["dagger", "weapon"],
    "Rune Dagger": ["rune_dagger", "dagger", "weapon"],
    "One Hand Sword": ["sword", "one_hand_weapon", "weapon"],
    "Thrusting One Hand Sword": [
      "sword",
      "thrusting_sword",
      "one_hand_weapon",
      "weapon",
    ],
    "Two Hand Sword": ["sword", "two_hand_weapon", "weapon"],
    "One Hand Axe": ["axe", "one_hand_weapon", "weapon"],
    "Two Hand Axe": ["axe", "two_hand_weapon", "weapon"],
    "One Hand Mace": ["mace", "weapon"],
    "Two Hand Mace": ["mace", "weapon"],
    "Sceptre": ["sceptre"],
    "Spear": ["spear", "weapon"],
    "Bow": ["bow", "weapon"],
    "Crossbow": ["crossbow", "weapon"],
    "Wand": ["wand", "weapon"],
    "Staff": ["staff", "weapon"],
    "Warstaff": ["staff", "weapon"],
    "FishingRod": ["fishing_rod", "weapon"],
    "LifeFlask": ["life_flask", "flask"],
    "ManaFlask": ["mana_flask", "flask"],
    "HybridFlask": ["life_flask", "mana_flask", "flask"],
    "UtilityFlask": ["utility_flask", "flask"],
    "Tincture": ["tincture"],
    "Jewel": ["jewel"],
  };
  function baseTags(b: BaseEntry): Set<string> {
    const t = new Set<string>(b.tags ?? []);
    for (const ct of CLASS_TAGS[b.class ?? ""] ?? []) t.add(ct);
    return t;
  }
  let draftBase: BaseEntry | null = null; // picked base, or null
  let draftRarity = "rare";
  let draftCluster: NonNullable<Item["cluster"]> | null = null;
  let draftSockets: ItemSocketV3[] = [];
  const RARITY_ORDER = ["normal", "magic", "rare"];

  function renderDraftSockets(): void {
    socketList.innerHTML = "";
    if (!draftSockets.length) {
      const empty = document.createElement("div");
      empty.className = "gp-socket-empty";
      empty.textContent = "No item sockets recorded.";
      socketList.appendChild(empty);
      return;
    }
    draftSockets.forEach((socket, index) => {
      const row = document.createElement("div");
      row.className = "gp-socket-row";

      const group = document.createElement("input");
      group.type = "number";
      group.min = "0";
      group.step = "1";
      group.value = String(socket.group);
      group.setAttribute("aria-label", `Socket ${index + 1} link group`);
      group.title = "Link group";
      group.addEventListener("input", () => {
        socket.group = Math.max(0, Math.trunc(Number(group.value) || 0));
      });

      const color = document.createElement("select");
      color.setAttribute("aria-label", `Socket ${index + 1} color`);
      for (
        const [value, label] of [
          ["", "No color"],
          ["R", "Red"],
          ["G", "Green"],
          ["B", "Blue"],
          ["W", "White"],
        ] as const
      ) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        color.appendChild(option);
      }
      color.value = socket.color ?? "";
      color.addEventListener("change", () => {
        if (color.value) socket.color = color.value;
        else delete socket.color;
      });

      const kind = document.createElement("input");
      kind.type = "text";
      kind.placeholder = "gem / abyss / rune";
      kind.value = socket.kind ?? "";
      kind.setAttribute("aria-label", `Socket ${index + 1} kind`);
      kind.addEventListener("input", () => {
        const value = kind.value.trim();
        if (value) socket.kind = value;
        else delete socket.kind;
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "gp-socket-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        draftSockets.splice(index, 1);
        renderDraftSockets();
      });

      row.append(group, color, kind, remove);
      socketList.appendChild(row);
    });
  }

  socketAdd.addEventListener("click", () => {
    const nextGroup = draftSockets.reduce(
      (max, socket) => Math.max(max, socket.group),
      -1,
    ) + 1;
    draftSockets.push({ group: nextGroup });
    renderDraftSockets();
  });

  // Cluster-jewel tree properties are enchants/structure, not ordinary
  // prefixes and suffixes. Keep them in dedicated controls while the
  // shared affix picker below continues to handle real rollable mods.
  const clusterWrap = document.createElement("div");
  clusterWrap.className = "gp-cluster hidden";
  const clusterSkillSel = document.createElement("select");
  const clusterNodesSel = document.createElement("select");
  const clusterSocketsValue = document.createElement("span");
  clusterSocketsValue.className = "gp-cluster-fixed";
  clusterWrap.innerHTML =
    '<div class="gp-cluster-head">Generated passive tree</div>' +
    '<label>Repeated small passives</label><span data-cluster-control="skill"></span>' +
    '<label>Passive count</label><span data-cluster-control="nodes"></span>' +
    '<label>Jewel sockets</label><span data-cluster-control="sockets"></span>' +
    '<div class="gp-cluster-note">“also grant” mods apply to every repeated small node; ' +
    "“1 Added Passive Skill is…” mods become distinct notables.</div>";
  clusterWrap.querySelector('[data-cluster-control="skill"]')?.appendChild(
    clusterSkillSel,
  );
  clusterWrap.querySelector('[data-cluster-control="nodes"]')?.appendChild(
    clusterNodesSel,
  );
  clusterWrap.querySelector('[data-cluster-control="sockets"]')?.appendChild(
    clusterSocketsValue,
  );
  rarityTabs.insertAdjacentElement("afterend", clusterWrap);

  function syncClusterControls(): void {
    const size = draftBase
      ? clusterSizeForItem({ base: draftBase.name })
      : null;
    const on = PROFILE.definition.jewels.clusterExpansion && baseActive() &&
      !!size;
    clusterWrap.classList.toggle("hidden", !on);
    if (!on || !size) {
      draftCluster = null;
      return;
    }
    const template = clusterTemplateForSize(size);
    const skills = clusterSkillsForSize(size);
    if (!template || !skills.length) {
      clusterWrap.classList.add("hidden");
      return;
    }
    if (!draftCluster || draftCluster.size !== size) {
      draftCluster = defaultClusterConfig(size);
    }
    if (!draftCluster) return;
    clusterSkillSel.innerHTML = "";
    for (const skill of skills) {
      const option = document.createElement("option");
      option.value = skill.id;
      option.textContent = skill.name +
        (skill.stats ? " — " + skill.stats : "");
      clusterSkillSel.appendChild(option);
    }
    clusterSkillSel.value = draftCluster.skill;
    if (!clusterSkillSel.value) {
      clusterSkillSel.value = skills[0]!.id;
      draftCluster.skill = clusterSkillSel.value;
    }
    clusterNodesSel.innerHTML = "";
    for (let n = template.min_nodes; n <= template.max_nodes; n++) {
      const option = document.createElement("option");
      option.value = String(n);
      option.textContent = String(n);
      clusterNodesSel.appendChild(option);
    }
    clusterNodesSel.value = String(draftCluster.nodeCount);
    const socketCount = size === "Large" ? 2 : size === "Medium" ? 1 : 0;
    clusterSocketsValue.textContent =
      `${socketCount} (fixed by ${size} Cluster Jewel)`;
    draftCluster.nodeCount = Number(clusterNodesSel.value);
    draftCluster.sockets = socketCount;
  }
  clusterSkillSel.addEventListener("change", () => {
    if (!draftCluster) return;
    draftCluster.skill = clusterSkillSel.value;
    refreshChips();
  });
  clusterNodesSel.addEventListener("change", () => {
    if (draftCluster) draftCluster.nodeCount = Number(clusterNodesSel.value);
  });

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
    const max = (isFlaskSlot(popSlot.value) || isCharmSlot(popSlot.value))
      ? "magic"
      : "rare";
    const maxIdx = RARITY_ORDER.indexOf(max);
    // Imported/freetext flask data may contain more than two lines;
    // it remains editable without pretending flasks can become rare.
    const fi = Math.min(RARITY_ORDER.indexOf(floor), maxIdx);
    for (const b of Array.from(rarityTabs.querySelectorAll("button"))) {
      const rank = RARITY_ORDER.indexOf(b.dataset.rarity ?? "");
      b.disabled = rank < fi || rank > maxIdx;
    }
    const rank = RARITY_ORDER.indexOf(draftRarity);
    if (rank < fi || rank > maxIdx) setRarity(RARITY_ORDER[fi]!);
  }
  // The composition controls exist only while the input names the
  // picked base EXACTLY — deriving visibility on every refresh means
  // no interaction path can leave them up for a unique or freetext.
  function baseActive(): boolean {
    return !!draftBase &&
      popInput.value.trim().toLowerCase() === draftBase.name.toLowerCase();
  }
  function syncBaseOpts(): void {
    const on = baseActive();
    baseOpts.classList.toggle("hidden", !on);
    syncClusterControls();
    if (on) {
      refreshChips();
      enforceRarity();
    }
    syncVariantSel();
  }

  // --- Unique variants ("Split Personality: Warrior") -------------
  // Some uniques ROLL differently (which class start, which element,
  // …). The catalogue carries current-era variants; picking one
  // stores its stat lines as the item's mods, so the choice travels
  // in plans, shares, and to agents like any other mod line.
  const variantWrap = document.createElement("div");
  variantWrap.className = "gp-variant hidden";
  variantWrap.innerHTML = "<label>Variant</label>";
  const variantSel = document.createElement("select");
  variantWrap.appendChild(variantSel);
  popInput.parentElement?.insertAdjacentElement("afterend", variantWrap);
  const FN_LINE = (k: string): string =>
    "Passives in Radius of " + k +
    " can be Allocated without being connected to your tree";
  function currentVariants(): { label: string; stats: string }[] {
    if (!draftUnique) return [];
    const u = uniques.find((x) => x.name === draftUnique);
    if (u?.variants?.length) return u.variants;
    // From Nothing rolls WHICH keystone — the domain is every
    // keystone on the tree (our own data), so the picker exists even
    // while the unique's stats are pending upstream.
    if (draftUnique === "From Nothing" && jewelData?.keystones) {
      return Object.keys(jewelData.keystones).sort().map((k) => ({
        label: k,
        stats: FN_LINE(k),
      }));
    }
    return [];
  }
  // Uniques the data doesn't cover yet (stats pending the PoB pin —
  // e.g. From Nothing) still ROLL — a hint steers those rolls into
  // the Notes field (this is a planner, not a PoB replacement).
  const pendingNote = document.createElement("div");
  pendingNote.className = "gp-pending hidden";
  pendingNote.textContent =
    "Mod data for this unique is pending — describe your copy's roll in Notes below.";
  variantWrap.insertAdjacentElement("afterend", pendingNote);
  // Read-only stat lines (with roll ranges) for the drafted unique —
  // fixed rolls; the Variant select above covers the rollable part.
  const uniqueStats = document.createElement("div");
  uniqueStats.className = "gp-unique-stats hidden";
  pendingNote.insertAdjacentElement("afterend", uniqueStats);

  function syncVariantSel(preselectMods?: string[]): void {
    void preselectMods;
    const vs = currentVariants();
    const u = draftUnique
      ? uniques.find((x) => x.name === draftUnique)
      : undefined;
    const dataless = !!u && !baseActive() && !vs.length &&
      !(u.latest_stats || "").trim();
    pendingNote.classList.toggle("hidden", !dataless);
    const lines = (u && !baseActive() ? (u.latest_stats || "") : "").split(
      " · ",
    ).filter(Boolean);
    uniqueStats.classList.toggle("hidden", !lines.length);
    if (lines.length) {
      uniqueStats.innerHTML = '<div class="us-head">' + esc(u!.name) +
        " — rolls</div>" +
        lines.map((l) => '<div class="us-line">' + esc(l) + "</div>").join("");
    }
    variantWrap.classList.toggle("hidden", vs.length === 0);
    if (!vs.length) return;
    variantSel.innerHTML = "";
    // GGG's roll text uses the START POSITION's name, which for four
    // starts is the PoE1 class (mined class_start pairs: Shadow|Monk,
    // Marauder|Warrior, Duelist|Mercenary, Templar|Druid) — append
    // the PoE2 class so nobody has to know tree archaeology.
    const START_POS: Record<string, string> = {
      Shadow: "Monk",
      Marauder: "Warrior",
      Duelist: "Mercenary",
      Templar: "Druid",
    };
    vs.forEach((v, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      const poe2 = START_POS[v.label];
      o.textContent = (poe2 ? v.label + " (" + poe2 + "'s start)" : v.label) +
        " — " + v.stats;
      variantSel.appendChild(o);
    });
    if (preselectMods?.length) {
      const joined = preselectMods.join(" · ");
      const i = vs.findIndex((v) => v.stats === joined);
      if (i >= 0) variantSel.value = String(i);
    }
  }
  // Affix caps, like the game: flasks/Charms take one prefix + one
  // suffix, rare jewels take at most 2 + 2, and other rare gear 3 + 3.
  // (Bases that bend the rule are out of scope — notes cover them.)
  function affixCap(): number {
    return (isFlaskSlot(popSlot.value) || isCharmSlot(popSlot.value))
      ? 1
      : popSlot.value === "jewel"
      ? 2
      : 3;
  }
  function kindOf(label: string): string {
    return modFams.find((f) => (f.text || f.type) === label)?.kind ?? "";
  }
  function toggleMod(label: string): void {
    const i = selectedMods.findIndex((m) =>
      m.toLowerCase() === label.toLowerCase()
    );
    if (i >= 0) selectedMods.splice(i, 1);
    else {
      const kind = kindOf(label);
      if (kind === "prefix" || kind === "suffix") {
        const n = selectedMods.filter((m) => kindOf(m) === kind).length;
        if (n >= affixCap()) {
          window.BuildwrightPlan?.flash(
            "An item takes at most " + affixCap() + " " + kind +
              (affixCap() > 1 ? "es" : "") + " — remove one first",
            true,
          );
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
    const base = draftBase;
    const q = statsInput.value.trim().toLowerCase();
    const tags = baseTags(base);
    if (draftCluster?.skill) tags.add(draftCluster.skill);
    const pool = modFams
      .filter((f) => canRollFamily(f, tags, itemDomain(base.class, tags)))
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "prefix" ? -1 : 1));
    const isSel = (label: string): boolean =>
      selectedMods.some((m) => m.toLowerCase() === label.toLowerCase());
    // Two fixed zones: the item's chosen mods as pills up top (with
    // the affix budget), and a real SCROLLABLE list for the rollable
    // pool below — one mod per row, kind-tagged, searchable.
    if (selectedMods.length) {
      const head = document.createElement("div");
      head.className = "gp-chip-head";
      const cap = affixCap();
      const np = selectedMods.filter((m) => kindOf(m) === "prefix").length;
      const ns = selectedMods.filter((m) => kindOf(m) === "suffix").length;
      head.textContent = "On item — " + np + "/" + cap + " prefixes · " + ns +
        "/" + cap + " suffixes";
      statChips.appendChild(head);
      const onItem = document.createElement("div");
      onItem.className = "gp-on-item";
      for (const m of selectedMods) {
        const k = kindOf(m);
        const cls = "gp-chip on" + (k === "suffix" ? " gp-chip-suf" : "");
        onItem.appendChild(
          chip(m, cls, (k || "custom") + " — click to remove"),
        );
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
      const rows = pool.filter((f) =>
        f.kind === kind && !isSel(f.text || f.type) &&
        (!q || (f.text || f.type).toLowerCase().includes(q) ||
          f.type.toLowerCase().includes(q))
      );
      if (!rows.length) continue;
      const cap = affixCap();
      const used = selectedMods.filter((m) => kindOf(m) === kind).length;
      const full = used >= cap;
      const head = document.createElement("div");
      head.className = "gp-pool-head" + (full ? " is-full" : "");
      head.textContent = kind === "prefix" ? "Prefixes" : "Suffixes";
      head.textContent += full
        ? " — full (" + used + "/" + cap + ")"
        : " (" + used + "/" + cap + " used)";
      poolEl.appendChild(head);
      if (full) {
        shownCount++;
        continue;
      }
      for (const f of rows) {
        const row = chip(
          f.text || f.type,
          "gp-pool-row",
          f.type + " (" + kind + ")",
        );
        poolEl.appendChild(row);
        shownCount++;
      }
    }
    if (!shownCount) {
      const none = document.createElement("span");
      none.className = "gp-chip-none";
      none.textContent = "no rollable mod matches “" + statsInput.value.trim() +
        "”";
      poolEl.appendChild(none);
    }
    statChips.appendChild(poolEl);
  }

  let comboFocusIdx = -1;
  function refreshItemList(): void {
    const slot = slotByKey.get(popSlot.value);
    const q = (popInput.value || "").toLowerCase().trim();
    const cats = new Set(slot ? slot.cat : []);
    const wanted = baseSlotOf(popSlot.value);
    let pool = uniques.filter((u) =>
      u.allowed_slots?.length
        ? u.allowed_slots.includes(wanted)
        : (!u.slot || cats.size === 0 || cats.has(u.slot))
    );
    pool = pool.filter((u) => {
      const b = u.base ? baseByName.get(u.base.toLowerCase()) : undefined;
      return baseAllowedForPlannerSlot(
        GAME.id,
        popSlot.value,
        b?.class,
        u.base ?? "",
      );
    });
    if (popSlot.value === "jewel" && pendingSocketForNew != null) {
      const sock = socketById.get(pendingSocketForNew);
      pool = pool.filter((u) =>
        jewelAllowedInSocket(GAME.id, u.base ?? "", sock)
      );
    }
    if (q) {
      pool = pool.filter((u) =>
        u.name.toLowerCase().includes(q) ||
        (u.base || "").toLowerCase().includes(q)
      );
    }
    const shown = pool.slice(0, q ? 8 : 12);
    popList.innerHTML = "";
    comboFocusIdx = -1;
    for (const u of shown) {
      const li = document.createElement("li");
      li.dataset.unique = u.name;
      li.dataset.itemTip = "unique:" + u.name;
      const icon = uniqueIcon(u);
      const art = icon
        ? '<img class="gp-item-ic" src="' + esc(icon) +
          '" alt="" loading="lazy">'
        : '<span class="gp-item-ic gs-ic-blank r-unique"></span>';
      li.innerHTML = art +
        '<span class="sp-combo-name r-unique">' + esc(u.name) + "</span>" +
        (u.base ? '<span class="sp-combo-tag">' + esc(u.base) + "</span>" : "");
      popList.appendChild(li);
    }
    // Base rows: endgame tiers first (highest drop level), filtered to
    // the slot; picking one opens the rarity + priority-stats controls.
    const bslot = baseSlotOf(popSlot.value);
    let bpool = bases.filter((b) =>
      b.allowed_slots?.length
        ? b.allowed_slots.includes(bslot)
        : b.slot === bslot
    );
    bpool = bpool.filter((b) =>
      baseAllowedForPlannerSlot(GAME.id, popSlot.value, b.class, b.name)
    );
    if (popSlot.value === "jewel" && pendingSocketForNew != null) {
      const sock = socketById.get(pendingSocketForNew);
      bpool = bpool.filter((b) => jewelAllowedInSocket(GAME.id, b.name, sock));
    }
    if (q) bpool = bpool.filter((b) => b.name.toLowerCase().includes(q));
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
          ? '<img class="gp-item-ic" src="' + esc(b.icon) +
            '" alt="" loading="lazy">'
          : '<span class="gp-item-ic gs-ic-blank r-normal"></span>';
        li.innerHTML = art +
          '<span class="sp-combo-name">' + esc(b.name) + "</span>" +
          '<span class="sp-combo-tag">' + esc(b.class ?? "") +
          (b.lvl ? " · lvl " + b.lvl : "") + "</span>";
        popList.appendChild(li);
      }
    }
    const hidden = (pool.length - shown.length) +
      (bpool.length - bshown.length);
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
      li.innerHTML = "No match — use “<b>" + esc(popInput.value.trim()) +
        "</b>” as written";
      popList.appendChild(li);
    }
  }

  let popOwner: InventoryOwnerV3 = { kind: "player" };
  function actorItemsForEdit(actorId: string): Item[] {
    if (!window.BuildwrightPlan) return [];
    const native = window.BuildwrightPlan.native.get();
    const active = native.states.find((candidate) =>
      candidate.id === native.activeStateId
    );
    const actor = active?.actors.find((candidate) => candidate.id === actorId);
    return (actor?.inventory?.items ?? []).map(projectEquippedItemV3ToV2);
  }
  function editorItems(): Item[] {
    return popOwner.kind === "player"
      ? activeItems()
      : actorItemsForEdit(popOwner.actorId);
  }

  let draftUnique: string | null = null; // picked unique name, or null for freetext
  // Which jewel instance the popover is editing (jewels share the
  // 'jewel' slot; identity is the index within the jewel sub-list).
  // null = editing a normal slot, or adding a NEW jewel.
  let popJewelIdx: number | null = null;
  function syncPopoverKind(): void {
    popTitle.textContent = isFlaskSlot(popSlot.value)
      ? "Edit Flask Slot"
      : isCharmSlot(popSlot.value)
      ? "Edit Charm Slot"
      : "Edit Gear Slot";
  }
  function openPopover(
    slotKey: string | null,
    jewelIdx: number | null = null,
    preferredSlots = GEAR_SLOTS,
    owner: InventoryOwnerV3 = { kind: "player" },
  ): void {
    popOwner = owner;
    popSlot.innerHTML = "";
    for (const s of preferredSlots) {
      const o = document.createElement("option");
      o.value = s.key;
      o.textContent = s.label;
      popSlot.appendChild(o);
    }
    popJewelIdx = jewelIdx;
    const items = editorItems();
    // Default to the first EMPTY slot when adding fresh (jewels are
    // never "full" — the jewel option always means "add another").
    const firstEmpty = preferredSlots.find((s) =>
      s.key !== "jewel" &&
      !items.some((it) => itemPlannerSlot(it) === s.key)
    );
    popSlot.value = plannerSlot(
      slotKey ?? (firstEmpty ? firstEmpty.key : preferredSlots[0]!.key),
    );
    syncPopoverKind();
    const existing = popSlot.value === "jewel"
      ? (jewelIdx !== null
        ? items.filter((it) => (it.slot ?? "") === "jewel")[jewelIdx]
        : undefined)
      : items.find((it) => itemPlannerSlot(it) === popSlot.value);
    seedFromExisting(existing);
    popRemove.hidden = !existing;
    refreshItemList();
    popEl.classList.remove("hidden");
    popInput.focus();
  }
  function closePopover(): void {
    popEl.classList.add("hidden");
    pendingSocketForNew = null;
    popOwner = { kind: "player" };
  }

  // Seed the form from whatever occupies a slot (also used on slot
  // change). A composed base item re-opens with its rarity selected;
  // its stats live in the note, so the stats input starts empty.
  function seedFromExisting(existing: Item | undefined): void {
    // Composed items re-seed with their BASE name — Apply recomposes
    // "<Rarity> <Base>" from the tabs, so the round-trip is lossless.
    popInput.value = existing
      ? (existing.base || existing.name || existing.uniqueName || "")
      : "";
    popNote.value = existing ? (existing.note || "") : "";
    draftUnique = existing?.uniqueName || null;
    draftCluster = existing?.cluster ? { ...existing.cluster } : null;
    itemLevelInput.value = existing?.itemLevel != null
      ? String(existing.itemLevel)
      : "";
    qualityInput.value = existing?.quality != null
      ? String(existing.quality)
      : "";
    corruptedInput.checked = existing?.corrupted === true;
    draftSockets = (existing?.sockets ?? []).map((socket) => ({ ...socket }));
    sourceTextInput.value = existing?.sourceText ?? "";
    renderDraftSockets();
    statsInput.value = "";
    selectedMods = (existing?.mods ?? []).slice();
    syncVariantSel(existing?.mods);
    if (existing?.base) {
      draftBase = bases.find((b) =>
        b.name.toLowerCase() === existing.base!.toLowerCase()
      ) ??
        { name: existing.base };
      setRarity((existing.rarity || "rare").toLowerCase());
    } else {
      draftBase = null;
      setRarity("rare");
    }
    syncBaseOpts();
  }

  function commitItems(next: Item[]): void {
    if (!window.BuildwrightPlan) {
      return;
    }
    window.BuildwrightPlan.data.commit(next, "items");
    emitStateChange("items-commit");
  }

  function newItemInstanceId(): string {
    if (typeof crypto.randomUUID === "function") {
      return "item:" + crypto.randomUUID();
    }
    return "item:" + Date.now().toString(36) + ":" +
      Math.random().toString(36).slice(2);
  }

  popApply.addEventListener("click", () => {
    const name = popInput.value.trim();
    if (!name) {
      window.BuildwrightPlan?.flash(
        "Pick a unique, a base, or type an item name first",
        true,
      );
      return;
    }
    const itemLevel = itemLevelInput.value === ""
      ? undefined
      : Number(itemLevelInput.value);
    const quality = qualityInput.value === ""
      ? undefined
      : Number(qualityInput.value);
    if (
      itemLevel != null &&
      (!Number.isInteger(itemLevel) || itemLevel < 0)
    ) {
      window.BuildwrightPlan?.flash(
        "Item level must be a whole number of 0 or higher",
        true,
      );
      return;
    }
    if (quality != null && !Number.isFinite(quality)) {
      window.BuildwrightPlan?.flash("Quality must be a number", true);
      return;
    }
    const isJewel = popSlot.value === "jewel";
    let keptSocket: number | undefined;
    let previousItem: Item | undefined;
    let items: Item[];
    if (isJewel) {
      // Replace exactly the edited instance (keeping its socket);
      // popJewelIdx === null appends a new jewel.
      items = editorItems();
      if (popJewelIdx !== null) {
        const jl = items.filter((it) =>
          (it.slot ?? "") === "jewel"
        );
        const prev = jl[popJewelIdx];
        if (prev) {
          previousItem = prev;
          keptSocket = prev.socket;
          items = items.filter((it) => it !== prev);
        }
      }
    } else {
      const active = editorItems();
      previousItem = active.find((it) => itemPlannerSlot(it) === popSlot.value);
      items = active.filter((it) => itemPlannerSlot(it) !== popSlot.value);
    }
    const instanceId = previousItem?.id || newItemInstanceId();
    let entry: Item = { id: instanceId, slot: popSlot.value, name };
    if (keptSocket != null) entry.socket = keptSocket;
    let note = popNote.value.trim();
    if (draftUnique && draftUnique === name) {
      entry.uniqueName = draftUnique;
      // Persist the grounded base as part of the item. This keeps
      // game rules (notably PoE1 cluster-socket eligibility) valid
      // even if a later session temporarily cannot load the catalogue.
      const grounded = uniqueByName.get(draftUnique.toLowerCase());
      if (grounded?.base) entry.base = grounded.base;
      if (grounded?.official_name) {
        entry.officialUniqueName = grounded.official_name;
      }
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
        id: instanceId,
        slot: popSlot.value,
        name: rar === "normal"
          ? b.name
          : rar.charAt(0).toUpperCase() + rar.slice(1) + " " + b.name,
        base: b.name,
        rarity: rar,
      };
      if (keptSocket != null) entry.socket = keptSocket;
      if (selectedMods.length) entry.mods = selectedMods.slice();
      if (draftCluster) entry.cluster = { ...draftCluster };
    }
    if (itemLevel != null) entry.itemLevel = itemLevel;
    if (quality != null) entry.quality = quality;
    if (corruptedInput.checked) entry.corrupted = true;
    if (draftSockets.length) {
      entry.sockets = draftSockets.map((socket) => ({ ...socket }));
    }
    if (sourceTextInput.value) entry.sourceText = sourceTextInput.value;
    if (note) entry.note = note;
    // A jewel added via the socket picker's "+ add a jewel…" goes
    // straight into the socket the picker was opened on.
    if (
      popSlot.value === "jewel" && popJewelIdx === null &&
      pendingSocketForNew != null
    ) {
      if (
        (entry.uniqueName || entry.name) === "Voices" &&
        socketById.get(pendingSocketForNew)?.sinister
      ) {
        window.BuildwrightPlan?.flash(
          "Voices creates the sinister sockets — it can't occupy one",
          true,
        );
      } else {
        for (const it of items) {
          if (
            (it.slot ?? "") === "jewel" && it.socket === pendingSocketForNew
          ) delete it.socket;
        }
        entry.socket = pendingSocketForNew;
      }
    }
    if (
      entry.socket != null &&
      !jewelFitsSocket(entry, socketById.get(entry.socket))
    ) {
      window.BuildwrightPlan?.flash(
        "That cluster jewel is too large for this expansion socket",
        true,
      );
      return;
    }
    pendingSocketForNew = null;
    items.push(entry);
    if (popOwner.kind === "actor") {
      const stateId = activeNativeStateId();
      if (
        !stateId || !window.BuildwrightPlan?.native.upsertInventoryItem(
          stateId,
          popOwner,
          migrateItemV2ToV3(entry),
        )
      ) {
        window.BuildwrightPlan?.flash("Could not update actor equipment", true);
        return;
      }
      renderStrip();
    } else {
      commitItems(items);
    }
    closePopover();
    syncJewelOverlays();
  });
  popRemove.addEventListener("click", () => {
    if (popOwner.kind === "actor") {
      const stateId = activeNativeStateId();
      const existing = editorItems().find((item) =>
        itemPlannerSlot(item) === popSlot.value
      );
      if (
        !stateId || !existing?.id ||
        !window.BuildwrightPlan?.native.removeInventoryItem(
          stateId,
          popOwner,
          existing.id,
        )
      ) {
        window.BuildwrightPlan?.flash("Could not remove actor equipment", true);
        return;
      }
      closePopover();
      renderStrip();
      return;
    }
    if (popSlot.value === "jewel" && popJewelIdx !== null) {
      const items = activeItems();
      const jl = items.filter((it) => (it.slot ?? "") === "jewel");
      const prev = jl[popJewelIdx];
      commitItems(items.filter((it) => it !== prev));
    } else {
      commitItems(
        activeItems().filter((it) => itemPlannerSlot(it) !== popSlot.value),
      );
    }
    closePopover();
  });
  popEl.addEventListener("wheel", (e) => e.stopPropagation());
  popClose.addEventListener("click", closePopover);
  popCancel.addEventListener("click", closePopover);
  popSlot.addEventListener("change", () => {
    // Re-seed the fields from whatever occupies the newly-picked slot.
    // Switching TO jewel means "new jewel" (instances are edited from
    // their own rows, not via the slot dropdown).
    if (popSlot.value === "jewel") popJewelIdx = null;
    syncPopoverKind();
    const existing = popSlot.value === "jewel"
      ? undefined
      : editorItems().find((it) => itemPlannerSlot(it) === popSlot.value);
    seedFromExisting(existing);
    popRemove.hidden = !existing;
    refreshItemList();
  });
  popInput.addEventListener("input", () => {
    draftUnique = null;
    refreshItemList();
    syncBaseOpts(); // typing past a picked base hides the controls
  });
  rarityTabs.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement | null)?.closest("button");
    if (b?.dataset.rarity && !b.disabled) setRarity(b.dataset.rarity);
  });
  statsInput.addEventListener("input", refreshChips);
  popList.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement | null)?.closest("li");
    if (!li) return;
    if (li.dataset.unique) {
      popInput.value = li.dataset.unique;
      draftUnique = li.dataset.unique;
      draftBase = null;
    } else if (li.dataset.base) {
      const b = bases.find((x) => x.name === li.dataset.base) ??
        { name: li.dataset.base };
      popInput.value = b.name;
      draftBase = b;
      draftUnique = null;
    } else if (li.dataset.free) {
      popInput.value = li.dataset.free;
      draftUnique = null;
      draftBase = null;
    }
    refreshItemList();
    syncBaseOpts();
  });

  let editedActorId: string | null = null;
  function newActorId(kind: ActorLoadoutV3["kind"]): string {
    if (typeof crypto.randomUUID === "function") {
      return "actor:" + kind + ":" + crypto.randomUUID();
    }
    return "actor:" + kind + ":" + Date.now().toString(36) + ":" +
      Math.random().toString(36).slice(2);
  }
  function activeActor(actorId: string): ActorLoadoutV3 | undefined {
    if (!window.BuildwrightPlan) return undefined;
    const native = window.BuildwrightPlan.native.get();
    return native.states.find((candidate) =>
      candidate.id === native.activeStateId
    )?.actors.find((candidate) => candidate.id === actorId);
  }
  function closeActorPopover(): void {
    actorPopEl.classList.add("hidden");
    editedActorId = null;
  }
  function renderActorInventory(): void {
    actorInventoryEl.innerHTML = "";
    const kind = actorKindInput.value as ActorLoadoutV3["kind"];
    const slots = PROFILE.rules.actorInventorySlots(kind);
    const actor = editedActorId ? activeActor(editedActorId) : undefined;
    if (!editedActorId) {
      actorInventoryHelp.textContent =
        "Save this actor first, then reopen it to set equipment.";
      return;
    }
    if (!slots.length) {
      actorInventoryHelp.textContent =
        "This actor kind has no game-supported equipment positions. Skills and notes remain available in the native plan.";
      const empty = document.createElement("div");
      empty.className = "ap-inventory-empty";
      empty.textContent = "No equipment slots";
      actorInventoryEl.appendChild(empty);
      return;
    }
    const bySlot = new Map(
      (actor?.inventory?.items ?? []).map((item) => [item.slot.id, item]),
    );
    const visibleKeys = new Set(slots.map((slot) => slot.key));
    const preserved = (actor?.inventory?.items ?? []).filter((item) =>
      !visibleKeys.has(item.slot.id)
    ).length;
    actorInventoryHelp.textContent =
      "Uses the same item selector and rich item editor as player gear." +
      (preserved
        ? ` ${preserved} imported out-of-profile item${
          preserved === 1 ? " is" : "s are"
        } preserved but not editable here.`
        : "");
    for (const slot of slots) {
      const item = bySlot.get(slot.key);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ap-slot";
      button.dataset.actorSlot = slot.key;
      button.innerHTML = '<span class="ap-slot-label">' + esc(slot.label) +
        "</span>" +
        '<span class="ap-slot-item">' +
        esc(
          item?.item.name || item?.item.unique?.name || item?.item.base?.name ||
            item?.item.base?.key || "Empty",
        ) +
        "</span>";
      actorInventoryEl.appendChild(button);
    }
  }
  function openActorPopover(actorId: string | null): void {
    editedActorId = actorId;
    const actor = actorId ? activeActor(actorId) : undefined;
    actorKindInput.innerHTML = "";
    for (const definition of PROFILE.definition.actorKinds) {
      const option = document.createElement("option");
      option.value = definition.kind;
      option.textContent = definition.label;
      actorKindInput.appendChild(option);
    }
    const defaultKind = PROFILE.definition.actorKinds[0]?.kind ?? "custom";
    actorKindInput.value = actor?.kind ?? defaultKind;
    actorNameInput.value = actor?.name ?? actorKindLabel(defaultKind);
    actorNotesInput.value = actor?.notes ?? "";
    actorPopTitle.textContent = actor ? "Edit Actor" : "Add Actor";
    actorRemove.hidden = !actor;
    renderActorInventory();
    actorPopEl.classList.remove("hidden");
    actorNameInput.focus();
    actorNameInput.select();
  }

  actorKindInput.addEventListener("change", () => {
    if (!editedActorId) {
      actorNameInput.value = actorKindLabel(
        actorKindInput.value as ActorLoadoutV3["kind"],
      );
    }
    renderActorInventory();
  });
  function saveActorDraft(): string | null {
    const stateId = activeNativeStateId();
    const kind = actorKindInput.value as ActorLoadoutV3["kind"];
    const name = actorNameInput.value.trim();
    if (!stateId || !name || !window.BuildwrightPlan) {
      window.BuildwrightPlan?.flash("Actor name is required", true);
      return null;
    }
    const existing = editedActorId ? activeActor(editedActorId) : undefined;
    const actor: ActorLoadoutV3 = {
      ...(existing ? structuredClone(existing) : {
        id: newActorId(kind),
        inventory: { items: [] },
      }),
      kind,
      name,
      ...(actorNotesInput.value.trim()
        ? { notes: actorNotesInput.value.trim() }
        : {}),
    };
    if (!actorNotesInput.value.trim()) delete actor.notes;
    if (!window.BuildwrightPlan.native.upsertActor(stateId, actor)) return null;
    editedActorId = actor.id;
    return actor.id;
  }
  actorApply.addEventListener("click", () => {
    if (!saveActorDraft()) return;
    closeActorPopover();
    renderStrip();
  });
  actorRemove.addEventListener("click", () => {
    const stateId = activeNativeStateId();
    if (
      !stateId || !editedActorId || !window.BuildwrightPlan ||
      !confirm("Remove this actor and its equipment from the current state?")
    ) return;
    if (!window.BuildwrightPlan.native.removeActor(stateId, editedActorId)) {
      return;
    }
    closeActorPopover();
    renderStrip();
  });
  actorInventoryEl.addEventListener("click", (e) => {
    const slotKey = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-actor-slot]",
    )?.dataset.actorSlot;
    if (!slotKey || !editedActorId) return;
    const kind = actorKindInput.value as ActorLoadoutV3["kind"];
    const slots = PROFILE.rules.actorInventorySlots(kind);
    const actorId = saveActorDraft();
    if (!actorId) return;
    closeActorPopover();
    openPopover(slotKey, null, slots, { kind: "actor", actorId });
  });
  actorPopClose.addEventListener("click", closeActorPopover);
  actorCancel.addEventListener("click", closeActorPopover);

  function exitReplayForEdit(): void {
    if (
      state.replayActive &&
      typeof window.BuildwrightReplayExitRestore === "function"
    ) {
      window.BuildwrightReplayExitRestore();
    }
  }
  addBtn.addEventListener("click", () => {
    exitReplayForEdit();
    openPopover(null);
  });
  flaskAddBtn.addEventListener("click", () => {
    exitReplayForEdit();
    openPopover(null, null, FLASK_SLOTS);
  });
  charmAddBtn.addEventListener("click", () => {
    exitReplayForEdit();
    openPopover(null, null, CHARM_SLOTS);
  });
  actorAddBtn.addEventListener("click", () => {
    exitReplayForEdit();
    openActorPopover(null);
  });
  actorListEl.addEventListener("click", (e) => {
    const actorId = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-actor-id]",
    )?.dataset.actorId;
    if (!actorId) return;
    exitReplayForEdit();
    if (!activeActor(actorId)) {
      window.BuildwrightPlan?.flash(
        "That replayed actor is not present in the active state.",
        true,
      );
      renderStrip();
      return;
    }
    openActorPopover(actorId);
  });
  listEl.addEventListener("click", (e) => {
    const loc = (e.target as HTMLElement | null)?.closest(
      "[data-jewel-locate]",
    ) as HTMLElement | null;
    if (loc) {
      e.stopPropagation();
      const jl = shownItems().filter((it) => (it.slot ?? "") === "jewel");
      const it = jl[Number(loc.dataset.jewelLocate)];
      if (it && it.socket != null) pingSocket(it.socket);
      return;
    }
    const row = (e.target as HTMLElement | null)?.closest(".gs-row") as
      | HTMLElement
      | null;
    if (row && row.dataset.slot) {
      exitReplayForEdit();
      openPopover(
        row.dataset.slot,
        row.dataset.jewelIdx != null ? Number(row.dataset.jewelIdx) : null,
      );
    }
  });
  flaskListEl.addEventListener("click", (e) => {
    const slot = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      ".fs-slot",
    )?.dataset.slot;
    if (!slot) return;
    exitReplayForEdit();
    openPopover(slot, null, FLASK_SLOTS);
  });
  charmListEl.addEventListener("click", (e) => {
    const slot = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      ".fs-slot",
    )?.dataset.slot;
    if (!slot) return;
    exitReplayForEdit();
    openPopover(slot, null, CHARM_SLOTS);
  });
  // Esc closes (popover is modal-lite; backdrop-less like the skill one).
  window.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" && !popEl.classList.contains("hidden")
    ) closePopover();
    if (
      e.key === "Escape" && !actorPopEl.classList.contains("hidden")
    ) closeActorPopover();
  });

  window.addEventListener(PLANNER_EVENTS.stateChange, renderStrip);
  window.addEventListener(PLANNER_EVENTS.replayScrub, renderStrip);
  function init(): void {
    if (window.BuildwrightPlan) {
      // Asset fetches often beat the wizard's initial local-plan
      // hydration on localhost. Reconcile once the plan API exists so
      // saved cluster jewels rebuild their generated subgraphs on a
      // hard reload even when both data promises already settled.
      renderStrip();
      syncJewelState();
      syncJewelOverlays();
    } else {
      setTimeout(init, 120);
    }
  }
  init();
}
