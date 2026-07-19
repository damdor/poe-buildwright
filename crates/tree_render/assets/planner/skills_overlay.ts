// ============================================================================
// === Skills overlay (top-right strip + edit-socket popover) ================
// ============================================================================
// Text-only — no gem icons / art per the "selectors and fields" scope.
// Active capture's skills render as a text strip in the upper-right;
// click any row (or +Add skill) to open a centered modal popover with
// searchable comboboxes + level + weapon-set + supports + notes.
// Writes go through window.PoE2Plan.data.commit(skills, 'skills'),
// so the snapshot timeline + .build run-collapse export Just Work.
// ============================================================================
import { spiritCapAt, state } from "./state.ts";
import { currentCharacterLevel } from "./captures_bar.ts";
import type { Skill } from "../../../../types/poe2.d.ts";

// Tree-only games ship no skills/spirit UI either.
const SKILLS_ON = window.PoE2Game?.features?.skills !== false;
if (!SKILLS_ON) {
  document.getElementById('skills-strip')?.remove();
  document.getElementById('skill-popover')?.remove();
}
if (SKILLS_ON) {
  interface Gem {
    id: string;
    name: string;
    gem_type?: string;
    natural_max_level?: number;
    tag_string?: string;
    color_name?: string;               // str | dex | int — attribute chip in picker rows
    icon?: string | null;              // gem inventory art (extracted first-party)
    description?: string;              // GGG skill/support description (rich-text markup)
    parts?: string[];                  // stat-set labels: the skill's display sections
    granted_effect_id?: string;        // key into skill_stats.json
    req_level?: number;
    cast_time?: string;                // milliseconds, as string, actives only
    skill_types?: string[];
    require_skill_types?: string[];
    exclude_skill_types?: string[];
  }
  interface StatPart { label?: string; crit?: number; const?: string[]; levels?: Record<string, string[]>; }
  interface EffectStats {
    parts: StatPart[];
    cost?: Record<string, number>;
    reservation?: Record<string, number>;
    cooldown_ms?: Record<string, number>;
    /** Support gems: % multiplier on the supported skill's cost AND
     *  spirit reservation (product across supports, ÷100 each). */
    cost_multiplier?: Record<string, number>;
  }
  interface Catalogue { gems: Gem[]; }
  interface SupportDraft { id: string; level: number; quality: number; note: string; }
  interface Draft {
    id: string;
    level: number;
    quality: number;
    set: 'main' | 'set1' | 'set2';
    note: string;
    supports: SupportDraft[];
  }
  type SetTag = 'main' | 'set1' | 'set2';

  const stripEl    = document.getElementById('skills-strip')  as HTMLElement;
  const listEl     = document.getElementById('ss-list')       as HTMLElement;
  const capLabel   = document.getElementById('ss-cap-label')  as HTMLElement;
  const addBtn     = document.getElementById('ss-add')        as HTMLElement;
  const popEl      = document.getElementById('skill-popover') as HTMLElement;
  const popClose   = document.getElementById('sp-close')      as HTMLElement;
  const popCancel  = document.getElementById('sp-cancel')     as HTMLElement;
  const popApply   = document.getElementById('sp-apply')      as HTMLElement;
  const popRemove  = document.getElementById('sp-remove')     as HTMLElement;
  const popNote    = document.getElementById('sp-note')       as HTMLTextAreaElement;
  const popLevel   = document.getElementById('sp-level')      as HTMLSelectElement;
  const popSupports = document.getElementById('sp-supports')  as HTMLElement;
  const popSetTabs = document.getElementById('sp-set-tabs')   as HTMLElement;
  const popActiveInput = document.getElementById('sp-active-input') as HTMLInputElement;
  const popActiveList  = document.getElementById('sp-active-list')  as HTMLElement;

  // The `as HTMLElement` casts above lean on emit.rs to actually
  // emit each id into planner.html. The runtime guard below makes
  // the casts honest: if any id is missing the planner throws
  // immediately at boot instead of NPE'ing on the first interaction.
  if (!stripEl || !popEl || !listEl || !capLabel || !addBtn ||
      !popClose || !popCancel || !popApply || !popRemove ||
      !popNote || !popLevel || !popSupports || !popSetTabs ||
      !popActiveInput || !popActiveList) {
    throw new Error('skills overlay: missing required DOM element');
  }

  // Max visible rows BEFORE the "+ N more" footer kicks in. Anything
  // above this stays accessible via mouse-wheel scroll (no scrollbar
  // chrome — see CSS .sp-combo-list scrollbar-width: none).
  const MAX_VISIBLE = 12;

  // ---------------------------------------------------------------
  // Catalogue — lazy-loaded; ~860 KB.
  // ---------------------------------------------------------------
  let catalogue: Catalogue | null = null;
  let activeGems: Gem[] = [];
  let supportGems: Gem[] = [];
  let gemById: Map<string, Gem> = new Map();
  let catalogueLoading: Promise<Catalogue> | null = null;
  function loadCatalogue(): Promise<Catalogue> {
    if (catalogue) return Promise.resolve(catalogue);
    if (catalogueLoading) return catalogueLoading;
    catalogueLoading = fetch('/assets/skill_catalogue.json')
      .then(r => r.ok ? r.json() : Promise.reject('catalogue fetch ' + r.status))
      .then((raw: unknown) => {
        const data = raw as Catalogue;
        catalogue = data;
        activeGems  = data.gems.filter(g => g.gem_type !== 'Support')
          .sort((a, b) => a.name.localeCompare(b.name));
        supportGems = data.gems.filter(g => g.gem_type === 'Support')
          .sort((a, b) => a.name.localeCompare(b.name));
        gemById = new Map(data.gems.map(g => [g.id, g] as const));
        // POE2_GEMS_BY_ID is consumed by level_slider; the runtime
        // shape IS Map<string, Gem> but the global type slot was
        // declared loose — cast at the seam.
        (window as unknown as { POE2_GEMS_BY_ID: Map<string, Gem> }).POE2_GEMS_BY_ID = gemById;
        // Slider may have rendered before catalogue loaded — kick a
        // re-render so skill-note ticks pick up gem-name labels.
        window.dispatchEvent(new CustomEvent('poe2-capture-change',
          { detail: { reason: 'catalogue-loaded' } }));
        return data;
      })
      .catch(e => { console.warn('skill catalogue load failed:', e); catalogue = null; throw e; });
    return catalogueLoading;
  }

  function escHtml(s: unknown): string {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
    ));
  }

  // Display tags for a row: the gem's own tag_string when it has one;
  // supports mostly ship without tags, so fall back to what they
  // SUPPORT — the first few require_skill_types tokens (operators
  // stripped), which is the data the compat filter actually enforces.
  const RPN_OPS = new Set(['AND', 'OR', 'NOT']);
  function gemTagLine(g: Gem): string {
    if (g.tag_string) return g.tag_string;
    if (g.gem_type !== 'Support') return '';
    const toks = (g.require_skill_types || []).filter(t => !RPN_OPS.has(t));
    if (!toks.length) return '';
    const shown = [...new Set(toks)].slice(0, 3);
    return 'supports ' + shown.join(', ') + (toks.length > shown.length ? ', …' : '');
  }

  // ---------------------------------------------------------------
  // Gem preview tooltip — the same "brown popup" family as the tree
  // tooltip, structured: art + name, meta row (type · attribute ·
  // req level), tag pills, full description, part labels, and what a
  // support applies to. One fixed element, shown for anything
  // carrying data-gem-id (picker rows, selected pills, strip icons).
  // ---------------------------------------------------------------
  const gemTip = document.createElement('div');
  gemTip.id = 'gem-tooltip';
  document.body.appendChild(gemTip);

  // Per-level per-part numbers (skill_stats.json, baked from
  // GrantedEffectStatSetsPerLevel + the csd chain). Lazy-fetched on
  // first tooltip; ~800 KB, browser-cached.
  let skillStats: Record<string, EffectStats> | null = null;
  let skillStatsLoading = false;
  // Support cost multipliers by GEM NAME (spirit.json, deploy-generated).
  // The baked skill_stats.json predates cost_multiplier, so the agent
  // surface's validated extraction is the source of truth for both
  // surfaces; absent (e.g. bare local render) → multipliers of 1.
  let spiritMultipliers: Record<string, Record<string, number>> = {};
  function loadSkillStats(): void {
    if (skillStats || skillStatsLoading) return;
    skillStatsLoading = true;
    fetch('/assets/skill_stats.json')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { effects?: Record<string, EffectStats> } | null) => {
        skillStats = d?.effects ?? {};
        // The spirit chip needs these ladders — repaint once loaded.
        renderStrip();
      })
      .catch(() => { skillStats = {}; });
    fetch('/assets/agent/spirit.json')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { support_cost_multipliers?: Record<string, Record<string, number>> } | null) => {
        spiritMultipliers = d?.support_cost_multipliers ?? {};
        renderStrip();
      })
      .catch(() => { /* optional */ });
  }

  // ---------------------------------------------------------------
  // Spirit budget chip. Persistent buffs (HasReservation) reserve
  // Spirit; the base pool is quest-earned (spiritCapAt — deliberately
  // conservative) and each support multiplies its skill's reservation
  // by cost_multiplier/100. Rendered next to the snapshot label so a
  // build's reservation habit is visible at a glance; +Spirit gear
  // can extend the pool, so overspend styles as a warning, not an
  // error.
  // ---------------------------------------------------------------
  function spiritReservedFor(skills: Skill[]): number {
    if (!skillStats) return 0;
    let total = 0;
    for (const s of skills) {
      if (!s || !s.id) continue;
      const g = gemById.get(s.id);
      const st = g?.granted_effect_id ? skillStats[g.granted_effect_id] : undefined;
      const base = st ? ladderAt(st.reservation, s.level || 1) : null;
      if (!base) continue;
      let mult = 1;
      for (const sup of s.supports || []) {
        const sg = sup && sup.id ? gemById.get(sup.id) : undefined;
        const sst = sg?.granted_effect_id ? skillStats[sg.granted_effect_id] : undefined;
        const m = (sst ? ladderAt(sst.cost_multiplier, sup.level || 1) : null)
          ?? (sg?.name ? ladderAt(spiritMultipliers[sg.name], sup.level || 1) : null);
        if (m && m !== 100) mult *= m / 100;
      }
      total += Math.round(base * mult);
    }
    return total;
  }
  // Lines at gem level L: exact level if present, else the highest
  // authored level below it (short support ladders top out early).
  function linesAt(p: StatPart, L: number): string[] {
    const lv = p.levels;
    if (!lv) return [];
    if (lv[String(L)]) return lv[String(L)]!;
    let best = -1;
    for (const k in lv) {
      const n = +k;
      if (n <= L && n > best) best = n;
    }
    return best > 0 ? (lv[String(best)] ?? []) : [];
  }
  function ladderAt(m: Record<string, number> | undefined, L: number): number | null {
    if (!m) return null;
    if (m[String(L)] != null) return m[String(L)]!;
    let best = -1;
    for (const k in m) {
      const n = +k;
      if (n <= L && n > best) best = n;
    }
    return best > 0 ? (m[String(best)] ?? null) : null;
  }
  function gemTipHtml(g: Gem, lvl: number): string {
    const icon = g.icon
      ? '<img class="tt-gem-ic" src="' + escHtml(g.icon) + '" alt="">'
      : '';
    const meta: string[] = [g.gem_type === 'Support' ? 'Support gem' : 'Skill gem'];
    if (g.color_name) meta.push({ str: 'strength', dex: 'dexterity', int: 'intelligence' }[g.color_name] ?? g.color_name);
    if (g.req_level && g.req_level > 1) meta.push('req level ' + g.req_level);
    const tags = g.tag_string
      ? '<div class="tt-tags">' + g.tag_string.split(', ').slice(0, 6)
          .map(t => '<span class="tt-tag">' + escHtml(t) + '</span>').join('') + '</div>'
      : '';
    let html = '<div class="tt-head"><div class="tt-headrow">' + icon +
      '<div><div class="tt-name">' + escHtml(g.name) + '</div>' +
      '<div class="tt-meta">' + escHtml(meta.join(' · ')) + '</div></div></div>' +
      tags + '</div>';
    if (g.description) {
      html += '<div class="tt-desc">' + escHtml(
        g.description
          .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$2')
          .replace(/\[([^\]|]+)\]/g, '$1')) + '</div>';
    }
    // Real numbers at the drafted gem level, per display PART — the
    // in-game gem popup's stat sections, from skill_stats.json.
    const st = g.granted_effect_id && skillStats ? skillStats[g.granted_effect_id] : null;
    let renderedParts = false;
    if (st) {
      const sections = st.parts
        .map(p => {
          const lines = [...linesAt(p, lvl), ...(p.const ?? [])];
          if (p.crit) lines.push(p.crit + '% Critical Hit Chance');
          if (!lines.length) return '';
          return '<div class="tt-skill-section">' +
            (p.label ? '<div class="tt-skill-head">' + escHtml(p.label) + '</div>' : '') +
            '<div class="tt-skill-desc">' + lines.map(escHtml).join('<br>') + '</div></div>';
        })
        .filter(Boolean);
      if (sections.length) {
        html += '<div class="tt-accum-head">At gem level ' + lvl + '</div>' + sections.join('');
        renderedParts = true;
      }
    }
    if (!renderedParts && (g.parts?.length ?? 0) > 1) {
      html += '<div class="tt-skill-section"><div class="tt-skill-head">Parts</div>' +
        g.parts!.map(p => '<span class="tt-part">' + escHtml(p) + '</span>').join('') + '</div>';
    }
    if (g.gem_type === 'Support') {
      const toks = [...new Set((g.require_skill_types || []).filter(t => !RPN_OPS.has(t)))];
      if (toks.length) {
        html += '<div class="tt-skill-section"><div class="tt-skill-head">Applies to skills tagged</div>' +
          toks.slice(0, 8).map(t => '<span class="tt-part">' + escHtml(t) + '</span>').join('') +
          (toks.length > 8 ? '<span class="tt-part">…</span>' : '') + '</div>';
      }
    }
    const req: string[] = [];
    if (st) {
      const cost = ladderAt(st.cost, lvl);
      if (cost) req.push('cost <b>' + cost + '</b>');
      const resv = ladderAt(st.reservation, lvl);
      if (resv) req.push('reserves <b>' + resv + ' Spirit</b>');
      const cd = ladderAt(st.cooldown_ms, lvl);
      if (cd) req.push('cooldown <b>' + (cd / 1000) + 's</b>');
    }
    const ct = parseInt(g.cast_time || '', 10);
    if (ct > 0 && g.gem_type !== 'Support') req.push('cast time <b>' + (ct / 1000) + 's</b>');
    if (g.natural_max_level && g.natural_max_level > 1) req.push('max gem level <b>' + g.natural_max_level + '</b>');
    if (req.length) html += '<div class="tt-req">' + req.join(' · ') + '</div>';
    return html;
  }
  function showGemTip(id: string, anchor: HTMLElement): void {
    loadSkillStats();
    const g = gemById.get(id);
    if (!g) return;
    const lvl = Math.max(1, parseInt(anchor.dataset.gemLvl || '', 10)
      || (draft ? draft.level : 0) || 1);
    gemTip.innerHTML = gemTipHtml(g, lvl);
    gemTip.classList.add('show');
    const r = anchor.getBoundingClientRect();
    const tw = gemTip.offsetWidth, th = gemTip.offsetHeight;
    // Prefer to the right of the anchor; flip left when clipped.
    let x = r.right + 12;
    if (x + tw > window.innerWidth - 8) x = r.left - tw - 12;
    if (x < 8) x = 8;
    let y = Math.min(r.top, window.innerHeight - th - 8);
    if (y < 8) y = 8;
    gemTip.style.left = x + 'px';
    gemTip.style.top = y + 'px';
  }
  function hideGemTip(): void { gemTip.classList.remove('show'); }
  document.addEventListener('mouseover', (e) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-gem-tip]');
    if (el && el.dataset.gemTip) showGemTip(el.dataset.gemTip, el);
    else hideGemTip();
  });
  document.addEventListener('scroll', hideGemTip, true);

  // ---------------------------------------------------------------
  // Support-compatibility (ported from PoB2)
  // ---------------------------------------------------------------
  // Lua reference: data/pob2/src/Modules/CalcTools.lua
  //   doesTypeExpressionMatch + canGrantedEffectSupportActiveSkill
  // Type-expression arrays may contain literal SkillType tokens AND
  // boolean operators (OR/AND/NOT) in postfix order. ~149 supports in
  // our 0.4 catalogue use operators, so a naive set-intersection is
  // wrong — we need the actual stack evaluator.
  function doesTypeExpressionMatch(checkTypes: string[], skillTypesSet: Set<string>): boolean {
    if (!checkTypes || checkTypes.length === 0) return false;
    const stack: boolean[] = [];
    for (const t of checkTypes) {
      if (t === 'OR') {
        const b = stack.pop() ?? false;
        stack[stack.length - 1] = (stack[stack.length - 1] ?? false) || b;
      } else if (t === 'AND') {
        const b = stack.pop() ?? false;
        stack[stack.length - 1] = (stack[stack.length - 1] ?? false) && b;
      } else if (t === 'NOT') {
        stack[stack.length - 1] = !(stack[stack.length - 1] ?? false);
      } else {
        stack.push(skillTypesSet.has(t));
      }
    }
    // PoB returns true if ANY value on the stack is truthy (handles
    // simple lists where each token pushes its own boolean).
    for (const v of stack) if (v) return true;
    return false;
  }
  function supportCompatibleWith(support: Gem, active: Gem | null | undefined): boolean {
    if (!active) return true;  // no active picked yet — show all
    const types = new Set<string>(active.skill_types || []);
    if (types.size === 0) return true;  // data gap (e.g. multi-GE actives) — compat unknown, show all
    const ex = support.exclude_skill_types || [];
    if (ex.length > 0 && doesTypeExpressionMatch(ex, types)) return false;
    const req = support.require_skill_types || [];
    if (req.length === 0) return true;
    return doesTypeExpressionMatch(req, types);
  }

  // ---------------------------------------------------------------
  // Support-copy dedup
  // ---------------------------------------------------------------
  // PoE2 base rule: each support gem can only be socketed ONCE
  // across the entire build. PoB2 surfaces this as a per-build
  // `MaxSupportGemCopies` mod (default 1, overridden to 2 by an
  // upcoming Gemling-Legionnaire-style passive — currently no
  // 0.4 ascendancy/item grants it, but PoB2's ModParser carries
  // the matcher for "you can use two copies of the same support
  // gem in different skills" → MaxSupportGemCopies=2, so the
  // feature is expected to return).
  //
  // We compute the constraint as: for a given support id, how many
  // copies are already used across all OTHER skills in the active
  // snapshot, plus other slots in the current draft. If that count
  // >= maxCopies, the support is excluded from this slot's pool.
  function maxSupportCopies(): number {
    // TODO: when a future patch ships Gemling-style "extra copy"
    // passives or items, read the count off the active capture's
    // allocated ascendancy nodes / equipped items and return 2 (or
    // higher). For 0.4 this is hard-coded to 1.
    return 1;
  }
  function supportCopyCount(supportId: string, currentSlotIdx: number): number {
    if (!window.PoE2Plan || !draft) return 0;
    const cap = window.PoE2Plan.captures.active();
    const skills = (cap && cap.skills) || [];
    let n = 0;
    for (let k = 0; k < skills.length; k++) {
      if (k === editingIdx) continue;  // current draft replaces this slot
      const sk = skills[k];
      if (!sk) continue;
      for (const s of (sk.supports || [])) {
        if (s.id === supportId) n++;
      }
    }
    for (let j = 0; j < draft.supports.length; j++) {
      if (j === currentSlotIdx) continue;
      if (draft.supports[j]!.id === supportId) n++;
    }
    return n;
  }
  function supportPickableFor(slotIdx: number, support: Gem): boolean {
    // Combine compatibility + copy-cap filtering.
    const activeGem = draft && draft.id ? gemById.get(draft.id) : null;
    if (!supportCompatibleWith(support, activeGem)) return false;
    if (supportCopyCount(support.id, slotIdx) >= maxSupportCopies()) return false;
    return true;
  }

  // ---------------------------------------------------------------
  // Strip rendering (text-only)
  // ---------------------------------------------------------------
  function renderStrip(): void {
    if (!window.PoE2Plan) return;
    // During replay the strip time-travels with the slider: it shows
    // the SCRUBBED capture's loadout (snapshots carry skills + items,
    // not just the tree), not the working capture's.
    const list = window.PoE2Plan.captures.list();
    const replaying = state.replayActive && state.replayCapIdx >= 0;
    const idx = replaying ? state.replayCapIdx : window.PoE2Plan.captures.activeIndex();
    const cap = list[idx] ?? window.PoE2Plan.captures.active();
    const skills = (cap && cap.skills) || [];
    stripEl.hidden = false;
    capLabel.textContent = list.length > 1
      ? (replaying ? 'replay · ' : '') + 'snap ' + (idx + 1) + '/' + list.length
      : '';
    // Spirit budget chip (see spiritReservedFor). Level source: the
    // same live/replay-aware character level the sidebar shows.
    loadSkillStats();
    {
      let chip = document.getElementById('ss-spirit');
      if (!chip) {
        chip = document.createElement('span');
        chip.id = 'ss-spirit';
        capLabel.parentElement?.insertBefore(chip, capLabel);
      }
      const reserved = spiritReservedFor(skills as Skill[]);
      if (reserved > 0) {
        const lvl = typeof currentCharacterLevel === 'function' ? currentCharacterLevel() : 100;
        const avail = spiritCapAt(lvl);
        chip.textContent = 'spirit ' + reserved + '/' + avail;
        chip.className = reserved > avail ? 'over' : '';
        chip.title = reserved > avail
          ? 'Reserves more than the quest-earned base pool at this level — needs +Spirit gear (sceptres, some uniques) to work.'
          : 'Spirit reserved by persistent buffs / available from quest rewards at this level (gear can add more).';
        (chip as HTMLElement).style.display = '';
      } else {
        (chip as HTMLElement).style.display = 'none';
      }
    }
    listEl.innerHTML = '';
    if (skills.length === 0) {
      const li = document.createElement('li');
      li.className = 'ss-empty';
      li.textContent = 'No skills in this snapshot yet.';
      listEl.appendChild(li);
      return;
    }
    for (let i = 0; i < skills.length; i++) {
      const s = skills[i];
      if (!s) continue;
      const li = document.createElement('li');
      li.className = 'ss-row' + (s.note ? ' has-note' : '');
      li.dataset.idx = String(i);
      const g = gemById.get(s.id);
      const name = g ? g.name : (s.id || '(missing gem)');
      const gemIc = g && g.icon
        ? '<img class="ss-gem-ic" src="' + escHtml(g.icon) + '" alt="" data-gem-tip="' +
          escHtml(g.id) + '" data-gem-lvl="' + (s.level || 1) + '" loading="lazy">'
        : '';
      const supIcs = (s.supports || [])
        .filter(sp => sp && sp.id)
        .map(sp => ({ sp, sg2: gemById.get(sp.id) }))
        .filter((x): x is { sp: typeof x.sp; sg2: Gem } => !!x.sg2 && !!x.sg2.icon)
        .map(x => '<img class="ss-sup-ic" src="' + escHtml(x.sg2.icon!) + '" alt="" data-gem-tip="' +
          escHtml(x.sg2.id) + '" data-gem-lvl="' + (x.sp.level || s.level || 1) + '" loading="lazy">')
        .join('');
      const supCount = (s.supports || []).length;
      const setTag = s.set === 'set1' ? 'set 1'
                   : s.set === 'set2' ? 'set 2'
                   : null;
      const metaParts: string[] = [];
      if (s.level) metaParts.push('lvl ' + s.level);
      if (supCount > 0) metaParts.push(supCount + ' support' + (supCount === 1 ? '' : 's'));
      li.innerHTML =
        '<div class="ss-row-head">' + gemIc +
          '<div class="ss-row-name">' + escHtml(name) + '</div>' +
        '</div>' +
        '<div class="ss-row-meta">' +
        metaParts.map(p => '<span class="ss-row-tag">' + escHtml(p) + '</span>').join('') +
        (setTag ? '<span class="ss-row-tag ' + s.set + '">' + setTag + '</span>' : '') +
        (supIcs ? '<span class="ss-sup-row">' + supIcs + '</span>' : '') +
        '</div>';
      listEl.appendChild(li);
    }
  }

  // ---------------------------------------------------------------
  // Popover state
  // ---------------------------------------------------------------
  let draft: Draft | null = null;
  let editingIdx = -1;
  // Which support row (by index) is currently in EDIT mode (showing
  // its combobox). -1 = none; only one expanded at a time so the
  // popover doesn't grow into a wall of search lists.
  let expandedSupportIdx = -1;

  function openPopover(idx: number, opts?: { focusNote?: boolean }): void {
    const o = opts || {};
    loadCatalogue().then(() => {
      if (!window.PoE2Plan) return;
      const cap = window.PoE2Plan.captures.active();
      const skills = (cap && cap.skills) || [];
      editingIdx = idx;
      if (idx >= 0 && skills[idx]) {
        const s = skills[idx]!;
        draft = {
          id: s.id || '',
          level: s.level || 1,
          quality: s.quality || 0,
          set: (s.set as SetTag) || 'main',
          note: s.note || '',
          supports: (s.supports || []).map(x => ({
            id: x.id || '', level: x.level || 1, quality: x.quality || 0, note: x.note || ''
          })),
        };
      } else {
        draft = { id: '', level: 1, quality: 0, set: 'main', note: '', supports: [] };
      }
      expandedSupportIdx = -1;
      renderPopover();
      popEl.classList.remove('hidden');
      if (o.focusNote) {
        requestAnimationFrame(() => { popNote.focus(); popNote.select(); });
      } else {
        popActiveInput.focus();
      }
    }).catch(() => {
      if (window.PoE2Plan && window.PoE2Plan.flash) {
        window.PoE2Plan.flash('Skills catalogue failed to load — check connection', true);
      }
    });
  }
  function closePopover(): void {
    popEl.classList.add('hidden');
    draft = null;
    editingIdx = -1;
    expandedSupportIdx = -1;
  }

  function renderPopover(): void {
    if (!draft) return;
    // Active gem
    const g = draft.id ? gemById.get(draft.id) : null;
    popActiveInput.value = g ? g.name : '';
    refreshComboList(popActiveList, popActiveInput, activeGems, draft.id);
    // Level dropdown
    const maxLvl = g && g.natural_max_level ? g.natural_max_level : 20;
    popLevel.innerHTML = '';
    for (let lv = 1; lv <= maxLvl; lv++) {
      const opt = document.createElement('option');
      opt.value = String(lv);
      opt.textContent = 'Lvl ' + lv;
      if (lv === draft.level) opt.selected = true;
      popLevel.appendChild(opt);
    }
    // Set tabs
    for (const tab of popSetTabs.querySelectorAll<HTMLElement>('.sp-set-tab')) {
      tab.classList.toggle('is-active', tab.dataset.set === draft.set);
    }
    // Supports — pill rows; click a pill to expand into a combobox.
    popSupports.innerHTML = '';
    for (let i = 0; i < draft.supports.length; i++) {
      popSupports.appendChild(renderSupportRow(i));
    }
    // Add Support button. Hidden when:
    //  - 5 supports already taken (PoE2 cap per skill)
    //  - The last support row is empty AND expanded — auto-add-on-
    //    pick already gave the user a ready-to-fill slot, showing
    //    another "+ Add" would let them queue up multiple empties.
    const last = draft.supports[draft.supports.length - 1];
    const lastIsEmptyExpanded = last && !last.id
      && expandedSupportIdx === draft.supports.length - 1;
    if (draft.supports.length < 5 && !lastIsEmptyExpanded) {
      const addLi = document.createElement('li');
      const addBtnEl = document.createElement('button');
      addBtnEl.type = 'button';
      addBtnEl.className = 'sp-add-support';
      addBtnEl.textContent = '+ Add support gem';
      addBtnEl.addEventListener('click', () => {
        if (!draft) return;
        draft.supports.push({ id: '', level: 1, quality: 0, note: '' });
        expandedSupportIdx = draft.supports.length - 1;
        renderPopover();
      });
      addLi.appendChild(addBtnEl);
      popSupports.appendChild(addLi);
    }
    popNote.value = draft.note || '';
    popRemove.hidden = editingIdx < 0;
  }

  function renderSupportRow(i: number): HTMLElement {
    const row = document.createElement('li');
    row.className = 'sp-support-row';
    if (!draft) return row;
    const sup = draft.supports[i]!;
    const expanded = (i === expandedSupportIdx);
    // Vertical container so the support's combobox + per-support
    // note textarea stack neatly. The × button stays on the right
    // (horizontal sibling) regardless of collapsed/expanded state.
    const stack = document.createElement('div');
    stack.className = 'sp-support-stack';

    if (expanded) {
      // --- combobox (replaces the pill while editing) ---
      const cb = document.createElement('div');
      cb.className = 'sp-combobox';
      const input = document.createElement('input');
      input.type = 'search';
      input.className = 'sp-combo-input';
      input.placeholder = 'Type to search supports…';
      const g = sup.id ? gemById.get(sup.id) : null;
      input.value = g ? g.name : '';
      const list = document.createElement('ol');
      list.className = 'sp-combo-list';
      cb.appendChild(input);
      cb.appendChild(list);
      // Pool = compatible AND not already used elsewhere (excluding
      // THIS slot, since editing replaces). Keeps the just-picked
      // gem out of the next +Add row's search results, prevents
      // accidental duplicates.
      const filteredSupports = supportGems.filter(s => supportPickableFor(i, s));
      // Pick flow:
      //   1. Apply the chosen gem to this slot
      //   2. Collapse this row to a pill (so the combobox doesn't
      //      invite picking a 2nd gem that would silently REPLACE
      //      the one we just chose — was the user's complaint)
      //   3. If there's room (and the active is selected), auto-add
      //      an empty support row + expand it. Natural flow for
      //      building a 5-link: pick → pick → pick.
      //   4. To add a NOTE to a support, click the pill to re-expand.
      wireCombo(input, list, () => filteredSupports, () => sup.id, (gem) => {
        if (!draft) return;
        draft.supports[i] = Object.assign({}, draft.supports[i]!, { id: gem.id });
        if (draft.supports.length < 5) {
          draft.supports.push({ id: '', level: 1, quality: 0, note: '' });
          expandedSupportIdx = draft.supports.length - 1;
        } else {
          expandedSupportIdx = -1;
        }
        renderPopover();
      });
      stack.appendChild(cb);
      requestAnimationFrame(() => input.focus());

      // --- per-support note (GGG's BuildSupport.additional_text) ---
      // Stays in sync with draft.supports[i].note on every keystroke.
      // Collapsing the row back to a pill preserves the note (only
      // visual change — data stays in draft).
      const noteTa = document.createElement('textarea');
      noteTa.className = 'sp-support-note';
      noteTa.rows = 2;
      noteTa.placeholder = "Note for this support gem (e.g., 'add at lvl 18 when 4-link is unlocked')";
      noteTa.value = sup.note || '';
      noteTa.addEventListener('input', () => {
        if (!draft) return;
        draft.supports[i] = Object.assign({}, draft.supports[i]!, { note: noteTa.value });
        // Don't re-render — would steal focus from the textarea.
      });
      stack.appendChild(noteTa);
    } else {
      // --- collapsed pill: same anatomy as a picker row (gem art +
      // name + tags), so the selected state looks like what was
      // picked instead of a bare text line. Hover = description. ---
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'sp-support-pill' + (sup.note ? ' has-note' : '');
      const g = sup.id ? gemById.get(sup.id) : null;
      const noteHint = sup.note ? ' <span class="sp-pill-note-tag">has note</span>' : '';
      if (g) {
        pill.dataset.gemTip = g.id;
        const art = g.icon
          ? '<img class="sp-gem-ic" src="' + escHtml(g.icon) + '" alt="" loading="lazy">'
          : '<span class="sp-chip sp-chip-' + escHtml(g.color_name || 'none') + '"></span>';
        const tagLine = gemTagLine(g);
        pill.innerHTML = art +
          '<span class="sp-combo-name">' + escHtml(g.name) + '</span>' + noteHint +
          (tagLine ? '<span class="sp-combo-tag">' + escHtml(tagLine) + '</span>' : '');
      } else {
        pill.innerHTML = '<span class="sp-muted-name">(click to pick a support…)</span>' + noteHint;
      }
      pill.addEventListener('click', () => {
        expandedSupportIdx = i;
        renderPopover();
      });
      stack.appendChild(pill);
    }

    row.dataset.supIdx = String(i);
    row.appendChild(stack);

    // Remove button — always visible regardless of expand state.
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'sp-support-rm';
    rm.textContent = '×';
    rm.setAttribute('aria-label', 'Remove support');
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!draft) return;
      draft.supports.splice(i, 1);
      if (expandedSupportIdx === i) expandedSupportIdx = -1;
      else if (expandedSupportIdx > i) expandedSupportIdx--;
      renderPopover();
    });
    row.appendChild(rm);
    return row;
  }

  // ---------------------------------------------------------------
  // Searchable combobox — input + ALWAYS-VISIBLE results list,
  // keyboard arrows + Enter to pick. List has hidden scrollbar
  // (mouse-wheel still works) so "+ N more — refine search" only
  // appears as a footer-row when there's overflow.
  // ---------------------------------------------------------------
  function refreshComboList(
    list: HTMLElement, input: HTMLInputElement, pool: Gem[], selectedId: string,
  ): void {
    const q = (input.value || '').toLowerCase().trim();
    let matches = pool;
    if (q) {
      matches = pool.filter(g => g.name.toLowerCase().includes(q));
    }
    const total = matches.length;
    const shown = matches.slice(0, MAX_VISIBLE);
    list.innerHTML = '';
    if (shown.length === 0) {
      const li = document.createElement('li');
      li.className = 'sp-combo-empty';
      li.textContent = q ? 'No matches for "' + q + '".' : 'No gems available.';
      list.appendChild(li);
      return;
    }
    for (let i = 0; i < shown.length; i++) {
      const g = shown[i];
      if (!g) continue;
      const li = document.createElement('li');
      if (g.id === selectedId) li.classList.add('is-selected');
      li.dataset.gemId = g.id;
      li.dataset.idx = String(i);
      // Hover = the structured gem preview (brown popup).
      li.dataset.gemTip = g.id;
      // Row anatomy: [attr color chip] name … tags (ellipsized).
      // color_name is the gem's attribute (str/dex/int) from the
      // catalogue — the red/green/blue chip players recognize in-game.
      const chip = g.icon
        ? '<img class="sp-gem-ic" src="' + escHtml(g.icon) + '" alt="" loading="lazy">'
        : (g.color_name
          ? '<span class="sp-chip sp-chip-' + escHtml(g.color_name) + '" title="' + escHtml(g.color_name) + '"></span>'
          : '<span class="sp-chip sp-chip-none"></span>');
      const tagLine = gemTagLine(g);
      li.innerHTML = chip + '<span class="sp-combo-name">' + escHtml(g.name) + '</span>' +
        (tagLine ? '<span class="sp-combo-tag">' + escHtml(tagLine) + '</span>' : '');
      list.appendChild(li);
    }
    if (total > MAX_VISIBLE) {
      const more = document.createElement('li');
      more.className = 'sp-combo-more';
      more.textContent = '+' + (total - MAX_VISIBLE) + ' more — type to refine';
      list.appendChild(more);
    }
  }

  function wireCombo(
    input: HTMLInputElement, list: HTMLElement,
    getPool: () => Gem[], getSelectedId: () => string | undefined,
    onPick: (gem: Gem) => void,
  ): void {
    let focusedIdx = -1;
    function refresh(): void {
      refreshComboList(list, input, getPool(), getSelectedId() ?? '');
      focusedIdx = -1;
      // Pre-highlight the already-selected row so Enter on an
      // unchanged search confirms (no surprise).
      const sel = list.querySelector('li.is-selected');
      if (sel) {
        const all = [...list.querySelectorAll('li[data-gem-id]')];
        focusedIdx = all.indexOf(sel);
        if (focusedIdx >= 0) sel.classList.add('is-focused');
      }
    }
    function setFocus(idx: number): void {
      const all = [...list.querySelectorAll<HTMLElement>('li[data-gem-id]')];
      if (all.length === 0) return;
      if (idx < 0) idx = all.length - 1;
      if (idx >= all.length) idx = 0;
      for (const li of all) li.classList.remove('is-focused');
      all[idx]!.classList.add('is-focused');
      all[idx]!.scrollIntoView({ block: 'nearest' });
      focusedIdx = idx;
    }
    input.addEventListener('focus', refresh);
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(focusedIdx + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(focusedIdx - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const focused = list.querySelector<HTMLElement>('li.is-focused');
        if (focused && focused.dataset.gemId) {
          const pool = getPool();
          const gem = pool.find(g => g.id === focused.dataset.gemId);
          if (gem) onPick(gem);
        }
      }
      // Esc handled by the global popover-close listener.
    });
    list.addEventListener('mousedown', (e) => {
      // mousedown not click — input's blur otherwise fires first.
      const li = (e.target as HTMLElement | null)?.closest<HTMLElement>('li[data-gem-id]');
      if (!li) return;
      e.preventDefault();
      const pool = getPool();
      const gem = pool.find(g => g.id === li.dataset.gemId);
      if (gem) onPick(gem);
    });
    // Hover preview — show focus ring on the row the mouse is over
    // so click + keyboard share the same affordance.
    list.addEventListener('mouseover', (e) => {
      const li = (e.target as HTMLElement | null)?.closest<HTMLElement>('li[data-gem-id]');
      if (!li) return;
      for (const x of list.querySelectorAll<HTMLElement>('li.is-focused')) x.classList.remove('is-focused');
      li.classList.add('is-focused');
      focusedIdx = +(li.dataset.idx ?? '0') || 0;
    });
    // Initial render so the list is visible immediately on first
    // open (not just on input focus).
    refresh();
  }

  wireCombo(popActiveInput, popActiveList,
    () => activeGems,
    () => (draft && draft.id) || undefined,
    (gem) => {
      if (!draft) return;
      draft.id = gem.id;
      const maxLvl = gem.natural_max_level || 20;
      if (draft.level > maxLvl) draft.level = maxLvl;
      renderPopover();
      // Move focus to the Level dropdown so keyboard users can tab
      // through naturally after picking.
      requestAnimationFrame(() => popLevel.focus());
    });

  // ---------------------------------------------------------------
  // Apply / Remove
  // ---------------------------------------------------------------
  interface SkillEntry {
    id: string; level: number; quality: number; set: SetTag;
    note?: string; supports?: SupportDraft[];
  }
  function applyDraft(): void {
    if (!draft || !window.PoE2Plan) return;
    if (!draft.id) {
      if (window.PoE2Plan.flash) window.PoE2Plan.flash('Pick an active skill gem first', true);
      return;
    }
    draft.level = +popLevel.value || 1;
    draft.supports = draft.supports.filter(s => s.id);
    const cap = window.PoE2Plan.captures.active();
    const skills = ((cap && cap.skills) || []).slice();
    const entry: SkillEntry = {
      id: draft.id, level: draft.level, quality: draft.quality || 0,
      set: draft.set,
    };
    if (draft.note && draft.note.trim()) entry.note = draft.note.trim();
    if (draft.supports.length > 0) entry.supports = draft.supports;
    if (editingIdx >= 0) skills[editingIdx] = entry;
    else                 skills.push(entry);
    window.PoE2Plan.data.commit(skills, 'skills');
    window.dispatchEvent(new CustomEvent('poe2-capture-change', { detail: { reason: 'skills-commit' } }));
    if (window.PoE2Plan.flash) {
      window.PoE2Plan.flash(editingIdx >= 0 ? 'Updated skill' : 'Added skill');
    }
    closePopover();
    renderStrip();
  }
  function removeDraft(): void {
    if (editingIdx < 0 || !window.PoE2Plan) { closePopover(); return; }
    const cap = window.PoE2Plan.captures.active();
    const skills = ((cap && cap.skills) || []).slice();
    skills.splice(editingIdx, 1);
    window.PoE2Plan.data.commit(skills, 'skills');
    window.dispatchEvent(new CustomEvent('poe2-capture-change', { detail: { reason: 'skills-commit' } }));
    if (window.PoE2Plan.flash) window.PoE2Plan.flash('Removed skill');
    closePopover();
    renderStrip();
  }

  // ---------------------------------------------------------------
  // Wire interactions
  // ---------------------------------------------------------------
  // Editing during replay would silently write into the WORKING
  // capture while the strip displays a frozen one — exit replay first
  // (restores the authoring state) so edits land where the user sees.
  function exitReplayForEdit(): void {
    if (state.replayActive && typeof window.PoE2SliderExitRestore === 'function') {
      window.PoE2SliderExitRestore();
    }
  }
  addBtn.addEventListener('click', () => { exitReplayForEdit(); openPopover(-1); });
  listEl.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.ss-row');
    if (!row) return;
    exitReplayForEdit();
    openPopover(+(row.dataset.idx ?? '0'));
  });
  popClose.addEventListener('click', closePopover);
  popCancel.addEventListener('click', closePopover);
  popApply.addEventListener('click', applyDraft);
  popRemove.addEventListener('click', removeDraft);
  popSetTabs.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement | null)?.closest<HTMLElement>('.sp-set-tab');
    if (!tab || !draft) return;
    draft.set = (tab.dataset.set as SetTag) || 'main';
    renderPopover();
  });
  popLevel.addEventListener('change', () => { if (draft) draft.level = +popLevel.value || 1; });
  popNote.addEventListener('input', () => { if (draft) draft.note = popNote.value || ''; });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popEl.classList.contains('hidden')) {
      closePopover();
    }
  });
  // Outside-click closes the popover. CRITICAL: use composedPath()
  // instead of popEl.contains(e.target). When an in-popover button
  // handler (e.g. +Add Support) re-renders the supports section
  // BEFORE this listener fires, e.target gets detached from the
  // DOM — popEl.contains(detached) returns false and the popover
  // gets closed even though the original click was inside it.
  // composedPath is captured at event-dispatch time and survives
  // mid-handler DOM mutations.
  document.addEventListener('click', (e) => {
    if (popEl.classList.contains('hidden')) return;
    const path = (typeof e.composedPath === 'function') ? e.composedPath() : null;
    if (path && path.includes(popEl)) return;
    const t = e.target as HTMLElement;
    if (!path && t instanceof Node && popEl.contains(t)) return;  // fallback
    if (t && t.closest && t.closest('.ss-row, #ss-add')) return;
    closePopover();
  });

  // N on a hovered skill row opens the popover focused on the Notes
  // textarea. Mirror of the passive-side N hotkey in note_overlay.js.
  let hoveredSkillIdx = -1;
  listEl.addEventListener('mouseover', (e) => {
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.ss-row');
    hoveredSkillIdx = row ? +(row.dataset.idx ?? '0') : -1;
  });
  listEl.addEventListener('mouseleave', () => { hoveredSkillIdx = -1; });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    // N on a hovered skill row → focus its notes textarea
    if ((e.key === 'n' || e.key === 'N') && hoveredSkillIdx >= 0
        && popEl.classList.contains('hidden')) {
      e.preventDefault();
      openPopover(hoveredSkillIdx, { focusNote: true });
      return;
    }
    // G → open the gems window (Add Skill flow). If the popover is
    // already open, do nothing — Esc closes, G doesn't toggle (a
    // toggle would close mid-edit, lose draft work).
    if ((e.key === 'g' || e.key === 'G') && popEl.classList.contains('hidden')) {
      e.preventDefault();
      openPopover(-1);
      return;
    }
    // I → open the gear-slot editor (gear_overlay owns the popover;
    // triggering its +Set gear button keeps a single open-path).
    if (e.key === 'i' || e.key === 'I') {
      const gearPop = document.getElementById('gear-popover');
      if (gearPop && gearPop.classList.contains('hidden')) {
        e.preventDefault();
        document.getElementById('gs-add')?.click();
      }
    }
  });

  window.addEventListener('poe2-capture-change', renderStrip);
  window.addEventListener('poe2-replay-scrub', renderStrip);
  function init(): void {
    if (window.PoE2Plan) {
      renderStrip();
      loadCatalogue().then(renderStrip).catch(() => {});
    } else {
      requestAnimationFrame(init);
    }
  }
  init();
}
