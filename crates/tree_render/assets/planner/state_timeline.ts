// Branch-aware character-state timeline.
//
// The native v3 graph owns identity/ancestry; the rest of the planner still
// edits a projected route through BuildwrightPlan's compatibility surface.

import { currentCharacterLevel } from "./captures_bar.ts";
import { PLANNER_EVENTS } from "./runtime_contract.ts";
import { state } from "./state.ts";
import { flushPersistNow } from "./wizard_sync.ts";
import type {
  CharacterStatePhase,
  CharacterStateV3,
  PlanV3,
} from "../../../../types/shared.d.ts";

const timelineEl = document.getElementById("cap-chip-list") as
  | HTMLOListElement
  | null;
const addButton = document.getElementById("cap-snapshot") as
  | HTMLButtonElement
  | null;
const editorEl = document.getElementById("state-editor") as HTMLElement | null;
const titleEl = document.getElementById("state-editor-title") as
  | HTMLElement
  | null;
const nameEl = document.getElementById("state-editor-name") as
  | HTMLInputElement
  | null;
const phaseEl = document.getElementById("state-editor-phase") as
  | HTMLSelectElement
  | null;
const levelEl = document.getElementById("state-editor-level") as
  | HTMLInputElement
  | null;
const rangeFromEl = document.getElementById("state-editor-range-from") as
  | HTMLInputElement
  | null;
const rangeToEl = document.getElementById("state-editor-range-to") as
  | HTMLInputElement
  | null;
const descriptionEl = document.getElementById("state-editor-description") as
  | HTMLTextAreaElement
  | null;
const defaultEl = document.getElementById("state-editor-default") as
  | HTMLInputElement
  | null;
const defaultWrap = document.getElementById("state-editor-default-wrap") as
  | HTMLElement
  | null;
const saveButton = document.getElementById("state-editor-save") as
  | HTMLButtonElement
  | null;
const alternativeButton = document.getElementById("state-editor-alternative") as
  | HTMLButtonElement
  | null;
const cancelButton = document.getElementById("state-editor-cancel") as
  | HTMLButtonElement
  | null;
const closeButton = document.getElementById("state-editor-close") as
  | HTMLButtonElement
  | null;

const PHASE_LABELS: Record<CharacterStatePhase, string> = {
  leveling: "Leveling",
  "early-endgame": "Early endgame",
  endgame: "Late endgame",
  aspirational: "Aspirational",
  custom: "Custom",
};

type EditorMode =
  | { kind: "create"; activeId: string }
  | { kind: "edit"; stateId: string };
let editorMode: EditorMode | null = null;

interface OrderedState {
  state: CharacterStateV3;
  depth: number;
  siblingIndex: number;
}

function childrenOf(plan: PlanV3, parentId: string): CharacterStateV3[] {
  return plan.states
    .filter((candidate) => candidate.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function orderedStates(plan: PlanV3): OrderedState[] {
  const out: OrderedState[] = [];
  const walk = (
    node: CharacterStateV3,
    depth: number,
    siblingIndex: number,
  ): void => {
    out.push({ state: node, depth, siblingIndex });
    childrenOf(plan, node.id).forEach((child, index) =>
      walk(child, depth + 1, index)
    );
  };
  const root = plan.states.find((candidate) =>
    candidate.id === plan.rootStateId
  );
  if (root) walk(root, 0, 0);
  return out;
}

function actionButton(
  action: string,
  label: string,
  glyph: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "state-card-action" +
    (action === "delete" ? " delete" : "");
  button.dataset.stateAction = action;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = glyph;
  return button;
}

export function renderStateTimeline(): void {
  if (!timelineEl || !window.BuildwrightPlan) return;
  const native = window.BuildwrightPlan.native.get();
  const routeIds = new Set(
    window.BuildwrightPlan.native.route().map((item) => item.id),
  );
  timelineEl.innerHTML = "";
  for (const entry of orderedStates(native)) {
    if (entry.depth > 0) {
      const edge = document.createElement("li");
      edge.className = "state-edge" + (entry.siblingIndex > 0 ? " branch" : "");
      edge.setAttribute("aria-hidden", "true");
      edge.textContent = entry.siblingIndex > 0 ? "↳" : "→";
      timelineEl.appendChild(edge);
    }
    const item = document.createElement("li");
    item.className = [
      "cap-chip",
      "state-card",
      routeIds.has(entry.state.id) ? "on-route" : "",
      entry.state.id === native.activeStateId ? "active" : "",
      entry.state.id === native.defaultLeafId ? "default-leaf" : "",
    ].filter(Boolean).join(" ");
    item.dataset.stateId = entry.state.id;
    item.style.setProperty("--state-depth", String(entry.depth));

    const copy = document.createElement("span");
    copy.className = "state-card-copy";
    const name = document.createElement("span");
    name.className = "state-card-name";
    name.textContent = entry.state.name || "Untitled state";
    const level = document.createElement("span");
    level.className = "state-card-level";
    const isOpenDraftRange = entry.state.characterLevel == null &&
      entry.state.name === "Current build" &&
      entry.state.recommendedLevelRange?.[0] === 1 &&
      entry.state.recommendedLevelRange?.[1] === 100;
    level.textContent = entry.state.characterLevel != null
      ? "Lv " + entry.state.characterLevel
      : entry.state.recommendedLevelRange && !isOpenDraftRange
      ? "Lv " + entry.state.recommendedLevelRange.join("–")
      : "";
    if (entry.state.recommendedLevelRange && !isOpenDraftRange) {
      level.title = "Recommended levels " +
        entry.state.recommendedLevelRange.join("–");
    }
    const phase = document.createElement("span");
    phase.className = "state-card-phase";
    phase.textContent = PHASE_LABELS[entry.state.phase] ?? entry.state.phase;
    copy.append(name, level, phase);
    item.appendChild(copy);

    const actions = document.createElement("span");
    actions.className = "state-card-actions";
    actions.appendChild(actionButton("edit", "Edit " + entry.state.name, "✎"));
    if (entry.state.id !== native.rootStateId) {
      actions.appendChild(actionButton(
        "delete",
        "Delete " + entry.state.name + " and its descendants",
        "×",
      ));
    }
    item.appendChild(actions);
    item.title = routeIds.has(entry.state.id)
      ? "Click to edit this state"
      : "Alternative branch — click to open this route";
    timelineEl.appendChild(item);
  }
}

function closeEditor(): void {
  editorMode = null;
  editorEl?.classList.add("hidden");
}

function populateEditor(
  stateValue: CharacterStateV3 | null,
  inheritedPhase: CharacterStatePhase = "leveling",
): void {
  if (
    !nameEl || !phaseEl || !levelEl || !rangeFromEl || !rangeToEl ||
    !descriptionEl || !defaultEl
  ) return;
  nameEl.value = stateValue?.name ?? "";
  phaseEl.value = stateValue?.phase ?? inheritedPhase;
  levelEl.value = stateValue?.characterLevel != null
    ? String(stateValue.characterLevel)
    : String(currentCharacterLevel());
  rangeFromEl.value = stateValue?.recommendedLevelRange
    ? String(stateValue.recommendedLevelRange[0])
    : "";
  rangeToEl.value = stateValue?.recommendedLevelRange
    ? String(stateValue.recommendedLevelRange[1])
    : "";
  rangeFromEl.setCustomValidity("");
  rangeToEl.setCustomValidity("");
  descriptionEl.value = stateValue?.description ?? "";
}

function openCreateEditor(): void {
  if (!window.BuildwrightPlan || !editorEl) return;
  flushPersistNow();
  const native = window.BuildwrightPlan.native.get();
  const active = native.states.find((candidate) =>
    candidate.id === native.activeStateId
  );
  if (!active) return;
  editorMode = { kind: "create", activeId: active.id };
  populateEditor(null, active.phase);
  if (titleEl) titleEl.textContent = "Add a character state";
  if (saveButton) saveButton.textContent = "Add next state";
  if (alternativeButton) {
    alternativeButton.hidden = active.parentId == null;
    alternativeButton.disabled = active.parentId == null;
  }
  if (defaultWrap) defaultWrap.hidden = false;
  if (defaultEl) defaultEl.checked = active.id === native.defaultLeafId;
  editorEl.classList.remove("hidden");
  nameEl?.focus();
}

function openEditEditor(stateId: string): void {
  if (!window.BuildwrightPlan || !editorEl) return;
  flushPersistNow();
  const native = window.BuildwrightPlan.native.get();
  const selected = native.states.find((candidate) => candidate.id === stateId);
  if (!selected) return;
  editorMode = { kind: "edit", stateId };
  populateEditor(selected);
  if (titleEl) titleEl.textContent = "Edit character state";
  if (saveButton) saveButton.textContent = "Save state";
  if (alternativeButton) alternativeButton.hidden = true;
  const isLeaf = !native.states.some((candidate) =>
    candidate.parentId === stateId
  );
  if (defaultWrap) defaultWrap.hidden = !isLeaf;
  if (defaultEl) defaultEl.checked = selected.id === native.defaultLeafId;
  editorEl.classList.remove("hidden");
  nameEl?.focus();
}

function editorValues(): {
  name: string;
  description: string;
  phase: CharacterStatePhase;
  characterLevel: number | null;
  recommendedLevelRange: [number, number] | null;
} | null {
  if (
    !nameEl || !phaseEl || !levelEl || !rangeFromEl || !rangeToEl ||
    !descriptionEl
  ) return null;
  const name = nameEl.value.trim();
  if (!name) {
    nameEl.focus();
    return null;
  }
  const rawLevel = levelEl.value.trim();
  const rawFrom = rangeFromEl.value.trim();
  const rawTo = rangeToEl.value.trim();
  rangeFromEl.setCustomValidity("");
  rangeToEl.setCustomValidity("");
  if (!!rawFrom !== !!rawTo) {
    const incomplete = rawFrom ? rangeToEl : rangeFromEl;
    incomplete.setCustomValidity("Enter both ends of the recommended range.");
    incomplete.reportValidity();
    incomplete.focus();
    return null;
  }
  let recommendedLevelRange: [number, number] | null = null;
  if (rawFrom && rawTo) {
    const from = Math.max(1, Math.min(100, Number(rawFrom) | 0));
    const to = Math.max(1, Math.min(100, Number(rawTo) | 0));
    if (from > to) {
      rangeToEl.setCustomValidity(
        "The ending level must be at least the starting level.",
      );
      rangeToEl.reportValidity();
      rangeToEl.focus();
      return null;
    }
    recommendedLevelRange = [from, to];
  }
  return {
    name,
    description: descriptionEl.value.trim(),
    phase: phaseEl.value as CharacterStatePhase,
    characterLevel: rawLevel
      ? Math.max(1, Math.min(100, Number(rawLevel) | 0))
      : null,
    recommendedLevelRange,
  };
}

function addState(alternative: boolean): void {
  if (!window.BuildwrightPlan || editorMode?.kind !== "create") return;
  const values = editorValues();
  if (!values) return;
  const activeId = editorMode.activeId;
  const native = window.BuildwrightPlan.native.get();
  const active = native.states.find((candidate) => candidate.id === activeId);
  if (!active) return;
  const parentId = alternative ? active.parentId : active.id;
  if (!parentId) return;
  const id = window.BuildwrightPlan.native.addChildState(parentId, {
    name: values.name,
    phase: values.phase,
    ...(values.characterLevel != null
      ? { characterLevel: values.characterLevel }
      : {}),
    ...(values.recommendedLevelRange
      ? { recommendedLevelRange: values.recommendedLevelRange }
      : {}),
    makeDefault: !alternative && !!defaultEl?.checked,
  });
  if (!id) return;
  window.BuildwrightPlan.native.updateState(id, {
    description: values.description,
    characterLevel: values.characterLevel,
    recommendedLevelRange: values.recommendedLevelRange,
  });
  if (defaultEl?.checked) window.BuildwrightPlan.native.setDefaultLeaf(id);
  closeEditor();
}

function saveEditedState(): void {
  if (!window.BuildwrightPlan || editorMode?.kind !== "edit") return;
  const values = editorValues();
  if (!values) return;
  if (!window.BuildwrightPlan.native.updateState(editorMode.stateId, values)) {
    return;
  }
  if (defaultEl?.checked) {
    window.BuildwrightPlan.native.setDefaultLeaf(editorMode.stateId);
  }
  closeEditor();
}

addButton?.addEventListener("click", openCreateEditor);
saveButton?.addEventListener("click", () => {
  if (editorMode?.kind === "create") addState(false);
  else saveEditedState();
});
alternativeButton?.addEventListener("click", () => addState(true));
cancelButton?.addEventListener("click", closeEditor);
closeButton?.addEventListener("click", closeEditor);
editorEl?.addEventListener("click", (event) => {
  if (event.target === editorEl) closeEditor();
  event.stopPropagation();
});
for (const eventName of ["mousedown", "mouseup"]) {
  editorEl?.addEventListener(eventName, (event) => event.stopPropagation());
}
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && editorMode) closeEditor();
});

timelineEl?.addEventListener("click", (event) => {
  event.stopPropagation();
  const target = event.target as HTMLElement | null;
  const card = target?.closest<HTMLElement>(".state-card");
  const stateId = card?.dataset.stateId;
  if (!stateId || !window.BuildwrightPlan) return;
  const action = target?.closest<HTMLElement>("[data-state-action]")?.dataset
    .stateAction;
  if (action === "edit") {
    openEditEditor(stateId);
    return;
  }
  if (action === "delete") {
    const native = window.BuildwrightPlan.native.get();
    const selected = native.states.find((candidate) =>
      candidate.id === stateId
    );
    if (!selected) return;
    const descendantCount = native.states.filter((candidate) => {
      let parent = candidate.parentId;
      while (parent) {
        if (parent === stateId) return true;
        parent = native.states.find((stateItem) =>
          stateItem.id === parent
        )?.parentId ?? null;
      }
      return false;
    }).length;
    const suffix = descendantCount
      ? ` and ${descendantCount} descendant state${
        descendantCount === 1 ? "" : "s"
      }`
      : "";
    if (!confirm(`Delete "${selected.name}"${suffix}?`)) return;
    window.BuildwrightPlan.native.removeStateSubtree(stateId);
    return;
  }
  if (state.replayActive) window.BuildwrightReplayExit?.();
  flushPersistNow();
  const routeIds = new Set(
    window.BuildwrightPlan.native.route().map((item) => item.id),
  );
  if (routeIds.has(stateId)) {
    window.BuildwrightPlan.native.setActiveState(stateId);
  } else window.BuildwrightPlan.native.selectRoute(stateId);
});

window.addEventListener(PLANNER_EVENTS.stateChange, renderStateTimeline);
requestAnimationFrame(renderStateTimeline);
