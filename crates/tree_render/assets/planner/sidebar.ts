// ============================================================================
// === Sidebar: class / asc / selection list ================================
// ============================================================================

import { defaultClassName } from "./image_preload.ts";
import { MAX_ASC_POINTS, MAX_MAIN_POINTS, MAX_SET_POINTS, allocModeSel, ascSel, classSel, countAsc, countMain, countSelected, countSet1, countSet2, countSets, exportBtn, isMcParent, pickedMcOption, resetBtn, selCount, selList, state, weaponSetCapAt , resolveAscName, ascNodeOverride} from "./state.ts";
import { maybeRebuildStaticForLocks } from "./lock_rebuild.ts";
import { ensureClassArt } from "./lazy_art.ts";
import { requestRender } from "./render.ts";
import { esc } from "./hover.ts";
import { computeDeallocResult, updatePreview } from "./pathfind.ts";
import { doExportBuild } from "./build_io.ts";
import { focusNode } from "./cmdk.ts";
import { flushPersistNow, persistToWizardStore } from "./wizard_sync.ts";
import { currentCharacterLevel } from "./captures_bar.ts";
import type { Allocation, Capture } from "../../../../types/poe2.d.ts";

export function refreshAscOptions(): void {
  const klass = classSel.value || null;
  const klassChanged = state.klass !== klass;
  state.klass = klass;
  // Kick the lazy fetch for this class's art (no-op if resident or if
  // it's the default class, whose art shipped with the boot preload).
  // Every class change funnels through here — the sidebar select, plan
  // import, wizard restore — so this is the single choke point.
  void ensureClassArt(klass);
  state.asc = null;
  state.ascVariant = null;
  ascSel.innerHTML = '';
  const cls = TREE.classes.find(c => c.name === klass);
  if (!cls) {
    ascSel.innerHTML = '<option value="">— pick a class first —</option>';
  } else {
    ascSel.innerHTML = '<option value="">— any —</option>';
    for (const a of cls.asc) {
      const o = document.createElement('option');
      o.value = a; o.textContent = a;
      ascSel.appendChild(o);
    }
  }
  // Switching class invalidates any existing allocation: the tree
  // was rooted at the previous class's start hub. Clear so the user
  // doesn't end up with disconnected nodes hanging in space.
  if (klassChanged) {
    state.selected.clear();
    state.pickedAttrs.clear();
    state.allocationMeta.clear();
    state.popoutId = null;
    state.pathSwapTarget = null; state.pathSwapIndex = 0;
    state.selDirty = true;
    updatePreview();
    updateSelectionUI();
  }
  requestRender();
}
// First-run hint chip (#firstrun-hint, top of the canvas): visible only
// while the build has ZERO allocations, so a new user learns the two
// first steps (pick class → click a start node) instead of falling into
// the silent-default-class trap. Dismissable; auto-hides for the session
// once the first passive lands (synced by updateSelectionUI).
const frHint = document.getElementById('firstrun-hint');
let frHintDismissed = false;
document.getElementById('firstrun-hint-x')?.addEventListener('click', () => {
  frHintDismissed = true;
  syncFirstrunHint();
});
export function syncFirstrunHint(): void {
  if (!frHint) return;
  const show = !frHintDismissed && state.selected.size === 0;
  frHint.classList.toggle('hidden', !show);
}

// Class change is destructive: the tree is rooted at the class
 // start hub, so every existing allocation (across every snapshot)
 // is orphan-grown from the old root. Confirm + do a full clear
 // (same shape as the footer "Clear" button). Skipped silently for
 // empty builds (no captures with allocations) — nothing to lose,
 // no prompt friction.
let _classSilent: boolean = false;          // re-entrance guard for programmatic value resets
classSel.addEventListener('change', () => {
  if (_classSilent) { _classSilent = false; refreshAscOptions(); applyAsc(); return; }
  const previousKlass = state.klass;
  const buildHasContent = state.selected.size > 0
    || (window.PoE2Plan && window.PoE2Plan.captures.list().some(c => c.passives && c.passives.length > 0));
  if (buildHasContent && previousKlass && previousKlass !== classSel.value) {
    const ok = confirm(
      'Switching base class will clear every snapshot, every allocation, every note.\n\n' +
      'Keeps: build name + description.\n' +
      'Continue?'
    );
    if (!ok) {
      _classSilent = true;
      classSel.value = previousKlass;
      return;
    }
    // Full clear: same plan-rebuild flow the Clear button uses.
    // wizard_chrome's normalizePlan mints id/name/description for
    // any capture that doesn't have them, so the cast is honest
    // — the API boundary normalizes before persisting.
    if (window.PoE2Plan) {
      const plan = window.PoE2Plan.get();
      window.PoE2Plan.set({
        format: plan.format, version: plan.version, patch: plan.patch,
        name: plan.name || '', description: plan.description || '',
        class: classSel.value, activeSet: 'main',
        captures: [{
          levelRange: [1, 100], ascendancy: null,
          passives: [], skills: [], items: [],
        } as unknown as Capture],
        activeCapture: 0,
      });
    }
    state.selected.clear();
    state.pickedAttrs.clear();
    state.allocationMeta.clear();
    state.popoutId = null;
    state.pathSwapTarget = null; state.pathSwapIndex = 0;
    state.selDirty = true;
  }
  refreshAscOptions();
  applyAsc();
});
ascSel.addEventListener('change', applyAsc);
// Allocation mode (regular passive / weapon set 1 / weapon set 2)
// affects which set new clicks land in — existing allocations stay
// where they are.
//
// `state.activeSet` is the sticky mode set by the sidebar dropdown.
// `state.modOverride` is a transient override applied while the user
// holds Ctrl (→ set1) or Shift (→ set2); released → reverts. Every
// place that previously read state.activeSet for path-finding /
// tinting / tooltip-warnings goes through effectiveActiveSet() so
// the held modifier previews the alternate mode in real time.
state.modOverride = null;
export function effectiveActiveSet(): 'main' | 'set1' | 'set2' {
  return state.modOverride || state.activeSet || 'main';
}
export const modeBadge = document.getElementById('mode-badge') as HTMLElement | null;
export function syncModeBadge(): void {
  if (!modeBadge) return;
  const m = effectiveActiveSet();
  modeBadge.classList.remove('mode-main', 'mode-set1', 'mode-set2');
  modeBadge.classList.add('mode-' + m);
  const label = m === 'set1' ? 'Set 1' : m === 'set2' ? 'Set 2' : 'Main';
  const labelEl = modeBadge.querySelector('.mode-label');
  if (labelEl) labelEl.textContent = label;
}
syncModeBadge();
allocModeSel.addEventListener('change', () => {
  state.activeSet = (allocModeSel.value as 'main' | 'set1' | 'set2') || 'main';
  syncModeBadge();
  updatePreview();
  requestRender();
});
// Bottom-left HUD's mode segment is now clickable — cycle
// Main → Set 1 → Set 2 → Main. Replaces the sidebar dropdown
// that lived in the Passives header (removed). Click target is
// limited to the .mode-dot + .mode-label sub-elements so a click
// on the level/pool counters doesn't accidentally swap mode.
const MODE_CYCLE: ReadonlyArray<'main' | 'set1' | 'set2'> = ['main', 'set1', 'set2'];
export function cycleSetMode(): void {
  const cur = state.activeSet || 'main';
  const i = Math.max(0, MODE_CYCLE.indexOf(cur));
  const next = MODE_CYCLE[(i + 1) % MODE_CYCLE.length] ?? 'main';
  state.activeSet = next;
  if (allocModeSel) allocModeSel.value = next;
  syncModeBadge();
  updatePreview();
  requestRender();
}
if (modeBadge) {
  const dot   = modeBadge.querySelector<HTMLElement>('.mode-dot');
  const label = modeBadge.querySelector<HTMLElement>('.mode-label');
  const handler = (e: Event) => { e.stopPropagation(); cycleSetMode(); };
  if (dot)   { dot.style.cursor   = 'pointer'; dot.addEventListener('click', handler); }
  if (label) { label.style.cursor = 'pointer'; label.title = 'Click to switch sticky mode (Main → Set 1 → Set 2). Ctrl/Shift override per-click.'; label.addEventListener('click', handler); }
}
// Live mod-key preview. Skip when a text input is focused so typing
// in the cmd-K palette / wizard inputs doesn't strobe the badge.
export function shouldTrackMods(): boolean {
  const a = document.activeElement;
  if (!a || a === document.body) return true;
  const tag = a.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  return true;
}
export function refreshModOverride(e: KeyboardEvent): void {
  if (!shouldTrackMods()) {
    if (state.modOverride !== null) {
      state.modOverride = null;
      syncModeBadge(); updatePreview(); requestRender();
    }
    return;
  }
  const next = (e.ctrlKey || e.metaKey) ? 'set1'
             : e.shiftKey                ? 'set2'
             : null;
  // First Ctrl / Shift press while a sticky mode is active resets
  // the sticky to 'main'. Rationale: hotkey users who toggled the
  // pill into Set 1 / Set 2 expect modifier behaviour to take over
  // the moment they reach for it — release the modifier and clicks
  // go back to main, no extra click-on-pill needed. Sticky stays at
  // 'main' after this; the modifier override drives the per-click
  // mode for as long as it's held.
  if (next !== null && state.activeSet && state.activeSet !== 'main') {
    state.activeSet = 'main';
    if (allocModeSel) allocModeSel.value = 'main';
  }
  if (next === state.modOverride) return;
  state.modOverride = next;
  syncModeBadge(); updatePreview(); requestRender();
}
window.addEventListener('keydown', refreshModOverride);
window.addEventListener('keyup',   refreshModOverride);
// Window can lose focus while a modifier is held (Cmd-tab on macOS,
// Alt-tab on Linux) — keyup never fires, so the override would stick.
window.addEventListener('blur', () => {
  if (state.modOverride !== null) {
    state.modOverride = null;
    syncModeBadge(); updatePreview(); requestRender();
  }
});
export function applyAsc(): void {
  // Variant ascendancies: the SELECT carries the variant name; the
  // engine runs on the parent panel.
  {
    const chosen = ascSel.value || null;
    const r = resolveAscName(chosen);
    state.ascVariant = r.variant;
    if (r.variant && ascSel.value !== r.panel) {
      // Keep the visible selection on the variant but hand the engine
      // the parent below by reading panel instead of raw value.
    }
  }
  const oldAsc = state.asc;
  const newAsc = resolveAscName(ascSel.value || null).panel;
  if (oldAsc !== newAsc && oldAsc) {
    // Asc nodes are rooted at the OLD ascendancy's start. Anything
    // selected inside the old asc panel is now orphaned; remove it
    // so the budget counter and adjacency stay correct.
    const toRemove: string[] = [];
    for (const id of state.selected.keys()) {
      const n = TREE.nodes[id];
      if (n && n.a === oldAsc) toRemove.push(id);
    }
    for (const id of toRemove) {
      state.selected.delete(id);
      state.pickedAttrs.delete(id);
      state.allocationMeta.delete(id);
    }
    if (toRemove.length > 0) state.selDirty = true;
  }
  state.asc = newAsc;

  // Asc-driven invalidations:
  //   * Pathfinder "Path of the Sorceress / Warrior" options live
  //     inside the Pathfinder asc panel and were just removed above.
  //     They had `altStartClass` effects that rooted whole branches
  //     of the main tree (Sorceress / Warrior starting clusters).
  //     Those main-tree allocations are now disconnected from any
  //     start hub and must cascade-drop.
  //   * Oracle's Unseen Path (5571) gated ~197 locked main-tree
  //     nodes. Switching off Oracle re-locks them. They become
  //     unreachable and need pruning too.
  // computeDeallocResult with a sentinel target reuses the existing
  // multi-mode BFS to find every selection that's no longer rooted.
  //
  // SKIPPED during replay — the slider's stateAtLevel intentionally
  // shows a position-sliced subset that may not form a connected
  // subgraph (a typical PoE2 leveling path is fine; the visualization
  // just walks the cumulative cap snapshot one step at a time). The
  // orphan prune would aggressively remove "disconnected" allocations
  // and corrupt the replay view.
  if (state.selected.size > 0 && !state.replayActive) {
    const orphans = computeDeallocResult('__none__');
    orphans.delete('__none__');
    if (orphans.size > 0) {
      for (const id of orphans) {
        state.selected.delete(id);
        state.pickedAttrs.delete(id);
        state.allocationMeta.delete(id);
      }
      state.selDirty = true;
    }
  }

  state.popoutId = null;
  state.pathSwapTarget = null;
  state.pathSwapIndex = 0;
  // Static geometry depends on the lock mask (Unseen Path visibility).
  // Asc change → bake again so locked / unlocked nodes appear /
  // disappear together with the new ascendancy.
  maybeRebuildStaticForLocks();
  updatePreview();
  updateSelectionUI();
  requestRender();
}

// Default class on load = alphabetically first.
export function initDefaultClass(): void {
  // defaultClassName is also what image_preload builds the eager
  // sprite set from — one rule, so the boot-visible class is always
  // the one whose art loaded eagerly.
  const first = defaultClassName();
  if (first) { classSel.value = first; refreshAscOptions(); }
}

export function updateSelectionUI(): void {
  syncFirstrunHint();
  const c = countSelected();
  const mainCap = MAX_MAIN_POINTS + c.mainPointGrant;
  // Weapon-set cap is level-gated: quest rewards across acts grant
  // the 24 points incrementally (see WEAPON_SET_REWARDS). Display
  // the cap as "how much is available at your current level + any
  // asc grants" rather than the flat-24 endgame number — otherwise
  // a Lv 13 player would see "0/24" and think they have empty room
  // for 24 points when they really only have 4 available.
  const charLvl  = typeof currentCharacterLevel === 'function' ? currentCharacterLevel() : 1;
  const baseSetCap = typeof weaponSetCapAt === 'function' ? weaponSetCapAt(charLvl) : MAX_SET_POINTS;
  const setCap  = baseSetCap + c.weaponSetGrant;
  // Bottom-left HUD: live character level. Tracks both editing and
  // replay modes — replay swaps state.selected, so the same derivation
  // yields the slider's position in replay and the live count otherwise.
  // Also mirrored next to the sidebar's "main: N / 99" counter so the
  // points-vs-level relationship is obvious in one place.
  const lvlNow = typeof currentCharacterLevel === 'function' ? currentCharacterLevel() : 1;
  const hudLevelEl = document.getElementById('mode-level-val');
  if (hudLevelEl) hudLevelEl.textContent = String(lvlNow);
  const ctrLvlEl = document.getElementById('count-main-lvl');
  if (ctrLvlEl) ctrLvlEl.textContent = 'Lv ' + lvlNow;
  countMain.textContent = String(c.main);
  countSet1.textContent = String(c.set1);
  countSet2.textContent = String(c.set2);
  countSets.textContent = String(c.sets);
  countAsc.textContent  = String(c.asc);
  // Dynamic caps. Asc nodes that grant +N passive points raise the
  // main ceiling; Witchhunter's Weapon Master raises the weapon-set
  // ceiling by 100. Show both the new total and a "(+N from asc)"
  // hint so the source of the bonus is visible.
  const capEl  = document.getElementById('count-main-cap');
  const bonusEl = document.getElementById('count-main-bonus');
  if (capEl)   capEl.textContent   = String(mainCap);
  if (bonusEl) bonusEl.textContent = c.mainPointGrant > 0 ? ' (+' + c.mainPointGrant + ' from asc)' : '';
  const setCapEl   = document.getElementById('count-sets-cap');
  const setBonusEl = document.getElementById('count-sets-bonus');
  if (setCapEl)   setCapEl.textContent   = String(setCap);
  if (setBonusEl) setBonusEl.textContent = c.weaponSetGrant > 0 ? ' +' + c.weaponSetGrant + ' from Weapon Master' : '';
  // Per-set HUD caps. PoB2 caps each weapon set independently at
  // maxWeaponSets + extraWeaponSets (Witchhunter's Weapon Master
  // adds +100 to BOTH set 1 and set 2), so we render the cap on each
  // segment rather than a single "swap total / cap" ratio.
  const setHudCaps = document.querySelectorAll('.hud-set-cap');
  setHudCaps.forEach((el) => { (el as HTMLElement).textContent = String(setCap); });
  countMain.style.color = c.main >= mainCap ? '#ff6b6b' : '';
  countSets.style.color = c.sets >= setCap  ? '#ff6b6b' : '';
  countAsc.style.color  = c.asc  >= MAX_ASC_POINTS  ? '#ff6b6b' : '';
  selCount.textContent = String(state.selected.size);
  selList.innerHTML = '';
  // The list iterates state.selected in insertion order, but we
  // deliberately do NOT render per-row level labels — within-capture
  // respec (remove + add) reorders the underlying array in ways that
  // would make any "Lv N" hint stale. Authors see the cumulative set
  // of nodes for the active capture; the captures-bar at the top is
  // where leveling-stage context lives. Asc allocations DO get a
  // small badge because they're qualitatively different (they spend
  // a different point pool than main passives).
  //
  // Small attribute nodes are NOT shown per-row — there can be 15+
  // of them in a typical build and listing each is pure noise. We
  // collapse them into a single summary row showing the totals per
  // picked variant (Str / Dex / Int / unpicked) at the TOP of the
  // list. The user can't drag-reorder or note-attach the summary;
  // those operations don't make sense on an aggregate.
  type AttrKey = 'Strength' | 'Dexterity' | 'Intelligence' | '_unpicked';
  const attrTotals: Record<AttrKey, number> = {
    Strength: 0, Dexterity: 0, Intelligence: 0, _unpicked: 0,
  };
  let attrCount = 0;
  for (const id of state.selected.keys()) {
    const n = TREE.nodes[id];
    if (!n || n.k !== 'attribute') continue;
    attrCount++;
    const pick = state.pickedAttrs.get(id);
    if (pick && (pick === 'Strength' || pick === 'Dexterity' || pick === 'Intelligence')) {
      attrTotals[pick] += 5;
    } else {
      attrTotals._unpicked += 5;
    }
  }
  if (attrCount > 0) {
    const liSum = document.createElement('li');
    liSum.className = 'alloc-attr-sum';
    const parts: string[] = [];
    if (attrTotals.Strength > 0)     parts.push('<span class="attr-pill str">+' + attrTotals.Strength     + ' STR</span>');
    if (attrTotals.Dexterity > 0)    parts.push('<span class="attr-pill dex">+' + attrTotals.Dexterity    + ' DEX</span>');
    if (attrTotals.Intelligence > 0) parts.push('<span class="attr-pill int">+' + attrTotals.Intelligence + ' INT</span>');
    if (attrTotals._unpicked > 0)    parts.push('<span class="attr-pill any" title="Allocate the +5 to any Attribute node and click on the tree to pick Str/Dex/Int">+' + attrTotals._unpicked + ' any</span>');
    liSum.innerHTML =
      '<div class="alloc-body">' +
        '<div class="alloc-name"><span class="alloc-attr-label">' + attrCount + ' attribute node' + (attrCount === 1 ? '' : 's') + '</span></div>' +
        '<div class="alloc-attr-pills">' + parts.join('') + '</div>' +
      '</div>';
    selList.appendChild(liSum);
  }

  // Accumulated stat summary — replaces the per-node row list. Same
  // pattern as the attribute pills above: anything that stacks gets
  // summed; unique lines render as-is. Not a PoB replacement, just
  // an "at-a-glance" total of what the allocated tree actually does.
  //
  // Algorithm: turn each stat line into a (template, numbers[]) pair
  // by replacing every numeric value with a `?`. Lines whose templates
  // match get their numbers summed position-by-position, then the
  // template is rebuilt with the sums. Negative-prefix and the unicode
  // minus (U+2212) both get captured; integer sums display without
  // ".0", decimals retain precision.
  //
  // Multi-choice notables (Path of Sorceress etc.) contribute the
  // PICKED option's stats in addition to the parent's, so the picker
  // choice is reflected in the totals. Class / asc starts have no
  // useful stats and get skipped.
  const NUM_RE = /[-−]?\d+(\.\d+)?/g;
  interface AccumStat { template: string; nums: number[]; count: number; }
  const accumStats = new Map<string, AccumStat>();
  function ingestStats(text: string | undefined): void {
    if (!text) return;
    for (const rawLine of text.split(/;\s*/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const key = line.replace(NUM_RE, '?');
      const nums = [...line.matchAll(NUM_RE)]
        .map(m => parseFloat(m[0].replace('−', '-')));
      const prev = accumStats.get(key);
      if (!prev) {
        accumStats.set(key, { template: key, nums: [...nums], count: 1 });
      } else {
        for (let i = 0; i < nums.length; i++) {
          prev.nums[i] = (prev.nums[i] ?? 0) + (nums[i] ?? 0);
        }
        prev.count++;
      }
    }
  }
  for (const id of state.selected.keys()) {
    const n = TREE.nodes[id];
    if (!n) continue;
    if (n.k === 'attribute') continue;
    if (n.k === 'class_start' || n.k === 'asc_start') continue;
    ingestStats(ascNodeOverride(id)?.s ?? n.s);
    if (isMcParent(id)) {
      const pickedId = pickedMcOption(id);
      if (pickedId) {
        const opt = TREE.nodes[pickedId];
        if (opt) ingestStats(opt.s);
      }
    }
  }
  const sortedStats = [...accumStats.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.template.localeCompare(b.template);
  });
  function formatNum(n: number): string {
    if (!Number.isFinite(n)) return String(n);
    // Trim trailing zeros from decimals but keep them meaningful:
    // 1.0 → "1", 1.50 → "1.5", -3 → "-3".
    return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(2)));
  }
  for (const entry of sortedStats) {
    let i = 0;
    const text = entry.template.replace(/\?/g, () => formatNum(entry.nums[i++] ?? 0));
    const li = document.createElement('li');
    li.className = 'stat-row';
    li.innerHTML = '<span class="stat-text">' + esc(text) + '</span>';
    selList.appendChild(li);
  }
  if (selCount && sortedStats.length === 0 && state.selected.size === 0) {
    // Empty state — show a one-liner so the section doesn't look broken.
    const li = document.createElement('li');
    li.className = 'stat-empty';
    li.textContent = 'Allocate passives to see your stat totals.';
    selList.appendChild(li);
  }
}
// Re-order state.selected by moving `dragId` to land directly above
// `targetId` (or below if `below` is true). Maps don't natively
// support insertion at a position, so we rebuild the Map.
export function reorderAllocation(dragId: string, targetId: string, below: boolean): void {
  if (!state.selected.has(dragId) || !state.selected.has(targetId)) return;
  if (dragId === targetId) return;
  const entries = [...state.selected.entries()];
  const dragEntry = entries.find(([k]) => k === dragId);
  if (!dragEntry) return;
  const without = entries.filter(([k]) => k !== dragId);
  const targetIdx = without.findIndex(([k]) => k === targetId);
  if (targetIdx < 0) return;
  const insertAt = below ? targetIdx + 1 : targetIdx;
  without.splice(insertAt, 0, dragEntry);
  state.selected = new Map(without);
  state.selDirty = true;
  requestRender();
  updateSelectionUI();
}
selList.addEventListener('click', e => {
  const target = e.target as HTMLElement | null;
  const rmBtn = target?.closest<HTMLElement>('button[data-rm]');
  if (rmBtn) {
    const id = rmBtn.getAttribute('data-rm');
    if (!id || !state.selected.has(id)) return;
    const removed = computeDeallocResult(id);
    for (const rid of removed) {
      state.selected.delete(rid);
      state.pickedAttrs.delete(rid);
      state.allocationMeta.delete(rid);
    }
    if (state.popoutId && removed.has(state.popoutId)) state.popoutId = null;
    state.selDirty = true;
    updatePreview();
    requestRender();
    updateSelectionUI();
    return;
  }
  const noteBtn = target?.closest<HTMLElement>('button[data-note]');
  if (noteBtn) {
    const id = noteBtn.getAttribute('data-note');
    if (!id) return;
    const parent = noteBtn.parentNode as HTMLElement | null;
    if (!parent) return;
    // Toggle / lazily-create the textarea. We always insert the
    // textarea HERE rather than rendering it pre-built — that way
    // a row without an existing note doesn't ship an empty hidden
    // textarea on every render.
    let wrap = parent.querySelector<HTMLElement>('.alloc-note-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'alloc-note-wrap';
      const meta = state.allocationMeta.get(id) || {};
      wrap.innerHTML =
        '<textarea class="alloc-note-text" data-id="' + id + '" ' +
        'placeholder="Note for this passive (markup: &lt;bold&gt;{...} &lt;red&gt;{...} &lt;rgb(r,g,b)&gt;{...})">' +
        esc(meta.notes || '') + '</textarea>';
      parent.appendChild(wrap);
    }
    const ta = wrap.querySelector<HTMLTextAreaElement>('textarea');
    if (wrap.style.display === 'none' || !wrap.style.display) {
      wrap.style.display = 'block';
      parent.classList.add('has-note');
      if (ta) ta.focus();
    } else {
      wrap.style.display = 'none';
      // If user collapsed an empty note, drop the meta entry.
      if (ta && !ta.value.trim()) {
        state.allocationMeta.delete(id);
        parent.classList.remove('has-note');
        noteBtn.classList.remove('has-note');
        noteBtn.innerHTML = '＋📝';
      }
    }
    return;
  }
  // Plain click on the row body → pan camera to that node.
  const li = target?.closest<HTMLElement>('li[data-id]');
  if (li) {
    const id = li.dataset.id;
    if (!id) return;
    const n = TREE.nodes[id];
    if (n && typeof focusNode === 'function') focusNode(id);
  }
});
// Note textarea persistence: every keystroke saves to
// state.allocationMeta and triggers a debounced persist directly.
// Previously we relied solely on the RAF-tick autosave to notice the
// dirty hash and call persistToWizardStore — but RAF is throttled
// (in background tabs, on display-off, sometimes during dev-tools)
// and the user can lose notes if the tab loses focus before the next
// tick fires. Calling persistToWizardStore directly here gives the
// 300ms debounce a guaranteed start time anchored to keystrokes.
//
// Replay-mode guard: while the slider is in replay, state is a
// derived view of past tree state, not authored content. Allowing
// note edits there would silently lose them on replay-exit (which
// restores the pre-replay snapshot, including allocationMeta). Show
// a flash hint instead so the user knows to leave replay first.
selList.addEventListener('input', e => {
  const t = e.target as HTMLTextAreaElement | null;
  if (!t || !t.classList || !t.classList.contains('alloc-note-text')) return;
  const id = t.dataset.id;
  if (!id || !state.selected.has(id)) return;
  if (state.replayActive) {
    // Auto-exit replay AND switch to the cap covering the slider's
    // scrub level — same pattern the N-hotkey path uses. The user
    // typed in a note textarea while viewing an old snapshot via
    // slider scrub; they clearly meant to annotate THAT snapshot,
    // not the working cap. Without this auto-switch, with the old
    // Edit/View toggle removed the user has no obvious way to leave
    // replay mode.
    if (window.PoE2SliderDebug && window.PoE2SliderExit) {
      const lsInput = document.getElementById('ls-input') as HTMLInputElement | null;
      const L = lsInput ? +lsInput.value : null;
      const s = L != null ? window.PoE2SliderDebug.stateAt(L) : null;
      const typed = t.value || '';
      window.PoE2SliderExit();
      if (s && window.PoE2Plan && window.PoE2Plan.captures) {
        window.PoE2Plan.captures.setActive(s.capIdx);
      }
      // capture-change re-hydrates state.selected and re-renders
      // #sel-list, replacing this textarea. After the re-render,
      // find the new textarea for the same id and restore the user's
      // typed text + re-focus so they can keep typing seamlessly.
      requestAnimationFrame(() => {
        const newTa = selList.querySelector<HTMLTextAreaElement>('textarea.alloc-note-text[data-id="' + id + '"]');
        if (newTa) {
          newTa.value = typed;
          newTa.focus();
          newTa.setSelectionRange(typed.length, typed.length);
          // Re-fire input so the save flow kicks in on the new textarea.
          newTa.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    }
    return;
  }
  const text = t.value || '';
  const prev = state.allocationMeta.get(id) || {};
  if (text.trim()) {
    state.allocationMeta.set(id, Object.assign({}, prev, { notes: text }));
  } else {
    const copy = Object.assign({}, prev);
    delete copy.notes;
    if (Object.keys(copy).length === 0) state.allocationMeta.delete(id);
    else state.allocationMeta.set(id, copy);
  }
  // Mark the row's note-button so the icon state stays in sync as
  // the user types — without a full re-render that would steal
  // focus from the textarea.
  const btn = selList.querySelector<HTMLButtonElement>('button[data-note="' + id + '"]');
  if (btn) {
    const has = !!text.trim();
    btn.classList.toggle('has-note', has);
    btn.innerHTML = has ? '📝' : '＋📝';
    btn.title = has ? 'Edit note (additional_text)' : 'Add a note (additional_text)';
  }
  state.selDirty = true;
  if (typeof persistToWizardStore === 'function') persistToWizardStore();
  // No requestRender needed — the textarea is HTML, not GL state.
});
// Native HTML5 drag-and-drop for sidebar reordering. The drop target
// gets a top- or bottom-edge highlight depending on cursor position.
let dragId: string | null = null;
selList.addEventListener('dragstart', e => {
  const li = (e.target as HTMLElement | null)?.closest<HTMLElement>('li[data-id]');
  if (!li) return;
  dragId = li.dataset.id ?? null;
  li.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId ?? '');
  }
});
selList.addEventListener('dragend', () => {
  dragId = null;
  for (const li of selList.querySelectorAll('li')) {
    li.classList.remove('dragging', 'drop-target-above', 'drop-target-below');
  }
});
selList.addEventListener('dragover', e => {
  const li = (e.target as HTMLElement | null)?.closest<HTMLElement>('li[data-id]');
  if (!li || !dragId || li.dataset.id === dragId) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  const rect = li.getBoundingClientRect();
  const below = (e.clientY - rect.top) > rect.height / 2;
  for (const x of selList.querySelectorAll('li')) {
    x.classList.remove('drop-target-above', 'drop-target-below');
  }
  li.classList.add(below ? 'drop-target-below' : 'drop-target-above');
});
selList.addEventListener('drop', e => {
  const li = (e.target as HTMLElement | null)?.closest<HTMLElement>('li[data-id]');
  if (!li || !dragId) return;
  e.preventDefault();
  const targetId = li.dataset.id;
  if (!targetId) return;
  const rect = li.getBoundingClientRect();
  const below = (e.clientY - rect.top) > rect.height / 2;
  reorderAllocation(dragId, targetId, below);
});
resetBtn.addEventListener('click', () => {
  if (!confirm(
    'Clear all snapshots and reset the tree?\n\n' +
    'Keeps:  build name, description, class, ascendancy\n' +
    'Clears: every snapshot + all allocated passives, skills, items'
  )) return;
  let keptAsc = null;
  if (window.PoE2Plan) {
    // Pull identity-only fields off the plan so we can rebuild it.
    const plan = window.PoE2Plan.get();
    const keptName = plan.name || '';
    const keptDesc = plan.description || '';
    const keptClass = plan.class || null;
    // Ascendancy lives per-capture; keep the active one (if any) so
    // a re-author starts from "Druid + Shaman" instead of "Druid + ?".
    const activeCap = plan.captures[plan.activeCapture] || plan.captures[0];
    keptAsc = (activeCap && activeCap.ascendancy) || null;
    // Replace the plan via PoE2Plan.set — wizard chrome normalizes it,
    // installs a single empty capture, and persists immediately.
    window.PoE2Plan.set({
      format: plan.format, version: plan.version, patch: plan.patch,
      name: keptName, description: keptDesc,
      class: keptClass, activeSet: 'main',
      captures: [{
        levelRange: [1, 100],
        ascendancy: keptAsc,
        passives: [], skills: [], items: [],
      } as unknown as Capture],
      activeCapture: 0,
    });
  }
  // Local in-memory state — drop everything; the chrome event will
  // re-hydrate from the empty active capture.
  state.selected.clear();
  state.pickedAttrs.clear();
  state.allocationMeta.clear();
  state.popoutId = null;
  state.pathSwapTarget = null;
  state.pathSwapIndex = 0;
  state.selDirty = true;
  updatePreview();
  requestRender();
  updateSelectionUI();
  if (window.PoE2Plan && window.PoE2Plan.flash) {
    window.PoE2Plan.flash('Cleared — kept name, class' + (keptAsc ? ', ascendancy' : ''));
  }
});
// Footer "Export" button now emits the GGG .build format the new
// in-game Build Planner consumes. For the lossless internal plan,
// or for importing, use the Cmd+K command palette.
exportBtn.addEventListener('click', doExportBuild);

// Sidebar "Copy link" — encode the current plan into a URL fragment
// and put the resulting share URL on the clipboard. The recipient
// opens it → /share.html decodes → imports as a fresh build.
const shareBtn = document.getElementById('share');
if (shareBtn) shareBtn.addEventListener('click', doShareLink);

export async function doShareLink(): Promise<void> {
  if (!window.PoE2Share || !window.PoE2Plan) {
    alert('Share codec did not load.');
    return;
  }
  // Push pending edits into the plan SYNCHRONOUSLY so the share
  // captures the latest in-memory state, including any notes the
  // user just typed (persistToWizardStore is debounced 300ms —
  // it would race with the read below).
  flushPersistNow();
  const plan = window.PoE2Plan.get();
  // (Pre-share connectivity check was tied to the old delta-captures
  // shape and is currently dead. Step 3 re-introduces a captures-aware
  // validator before share-link encoding.)
  let url;
  try {
    url = await window.PoE2Share.buildUrl(plan);
  } catch (e) {
    alert('Could not encode the share link: ' + ((e as Error).message || e));
    return;
  }
  // URL-length warning. Discord embeds / common chats cap around
  // 2 KB. Larger builds still work for direct paste but may break
  // on some surfaces — flag it so the author isn't surprised.
  let warn = '';
  if (url.length > 2048) {
    warn = '\n\nHeads up: the link is ' + url.length + ' characters. ' +
           'Some chat apps and shorteners may truncate it. ' +
           'A server-side short link arrives with the Summary page.';
  }
  try {
    await navigator.clipboard.writeText(url);
    window.PoE2Plan.flash('Share link copied (' + url.length + ' chars)');
    if (warn) alert('Share link copied.' + warn);
  } catch (e) {
    // Clipboard write can fail (no permission, http context, …).
    // Show the URL so the user can copy it manually.
    prompt('Copy this share link:', url);
  }
}

