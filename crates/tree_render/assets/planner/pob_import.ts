// Reviewed Path of Building import shared by game profiles.
//
// Parsing and normalization are pure modules. This controller owns only the
// browser workflow: acquire source → inspect independent PoB sets → require
// explicit state/chronology choices → show the final loss report → replace the
// current local v3 plan transactionally.

import type {
  CharacterStatePhase,
  PlanV3,
} from "../../../../types/shared.d.ts";
import { pickFile } from "./build_io.ts";
import { assetUrl, PROFILE } from "./game.ts";
import type {
  PoBCompatibilityReport,
  PoBImportPreview,
  PoBImportResult,
  PoBImportReview,
  PoBStateProposal,
} from "./pob_normalize.ts";
import { inspectPoBImport, normalizePoBImport } from "./pob_normalize.ts";
import { validatePlanForSelectedGame } from "./game_profile.ts";

const openButton = document.getElementById("pob-import-open") as
  | HTMLButtonElement
  | null;
const entry = document.getElementById("pob-import-entry") as HTMLElement | null;
const modal = document.getElementById("pob-import") as HTMLElement | null;
const entryGame = document.getElementById("pob-import-entry-game") as
  | HTMLElement
  | null;
const modalKicker = document.getElementById("pob-import-kicker") as
  | HTMLElement
  | null;

interface ClusterEnvelope {
  cluster?: {
    skills?: Array<{
      id: string;
      size: "Small" | "Medium" | "Large";
      stats: string;
      name?: string;
    }>;
  };
}

const PATCH_NODE_IDS = new Set(Object.keys(TREE.nodes));
const PHASES: Array<{ value: CharacterStatePhase; label: string }> = [
  { value: "leveling", label: "Leveling" },
  { value: "early-endgame", label: "Early endgame" },
  { value: "endgame", label: "Late endgame" },
  { value: "aspirational", label: "Aspirational" },
  { value: "custom", label: "Custom" },
];

let preview: PoBImportPreview | null = null;
let sourceUrl: string | undefined;
let pending: PoBImportResult | null = null;
let clusterSkillsPromise:
  | Promise<
    NonNullable<NonNullable<ClusterEnvelope["cluster"]>["skills"]>
  >
  | null = null;

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

const closeButton = byId<HTMLButtonElement>("pob-import-close");
const cancelButton = byId<HTMLButtonElement>("pob-import-cancel");
const fileButton = byId<HTMLButtonElement>("pob-import-file");
const inspectButton = byId<HTMLButtonElement>("pob-import-inspect");
const confirmButton = byId<HTMLButtonElement>("pob-import-confirm");
const input = byId<HTMLTextAreaElement>("pob-import-input");
const sourceLabel = byId<HTMLLabelElement>("pob-import-source-label");
const sourceHelp = byId<HTMLElement>("pob-import-source-help");
const status = byId<HTMLElement>("pob-import-status");
const reviewSection = byId<HTMLElement>("pob-import-review");
const sourceSummary = byId<HTMLElement>("pob-import-source-summary");
const planName = byId<HTMLInputElement>("pob-import-plan-name");
const arrangement = byId<HTMLSelectElement>("pob-import-arrangement");
const defaultState = byId<HTMLSelectElement>("pob-import-default");
const includeActors = byId<HTMLInputElement>("pob-import-actors");
const states = byId<HTMLElement>("pob-import-states");
const report = byId<HTMLElement>("pob-import-report");

function setStatus(message: string, isError = false): void {
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function setBusy(busy: boolean): void {
  if (inspectButton) {
    inspectButton.disabled = busy;
    inspectButton.textContent = busy ? "Inspecting…" : "Inspect source";
  }
  if (fileButton) fileButton.disabled = busy;
  if (confirmButton) confirmButton.disabled = busy;
}

function show(): void {
  if (!modal) return;
  modal.classList.remove("hidden");
  input?.focus();
}

function hide(): void {
  modal?.classList.add("hidden");
}

function reportGroup(
  key: keyof PoBCompatibilityReport,
  values: PoBCompatibilityReport[typeof key],
): HTMLDetailsElement | null {
  if (!values.length) return null;
  const labels: Record<keyof PoBCompatibilityReport, string> = {
    imported: "Imported",
    transformed: "Transformed",
    omitted: "Omitted",
    unresolved: "Needs attention",
    errors: "Errors",
  };
  const details = document.createElement("details");
  details.className = `pob-import-report-group ${key}`;
  details.open = key === "errors" || key === "unresolved";
  const summary = document.createElement("summary");
  summary.textContent = `${labels[key]} · ${values.length}`;
  details.appendChild(summary);
  const list = document.createElement("ul");
  for (const entry of values) {
    const item = document.createElement("li");
    const message = document.createElement("span");
    message.textContent = entry.message;
    const source = document.createElement("code");
    source.textContent = entry.sourceField;
    item.append(message, source);
    list.appendChild(item);
  }
  details.appendChild(list);
  return details;
}

function renderReport(
  value: PoBCompatibilityReport,
  heading: string,
): void {
  if (!report) return;
  report.innerHTML = "";
  const title = document.createElement("h3");
  title.textContent = heading;
  report.appendChild(title);
  const groups: Array<keyof PoBCompatibilityReport> = [
    "errors",
    "unresolved",
    "omitted",
    "transformed",
    "imported",
  ];
  let count = 0;
  for (const key of groups) {
    const group = reportGroup(key, value[key]);
    if (!group) continue;
    count++;
    report.appendChild(group);
  }
  if (!count) {
    const clean = document.createElement("p");
    clean.className = "pob-import-clean";
    clean.textContent = "No compatibility losses were found at this stage.";
    report.appendChild(clean);
  }
}

function candidateRow(
  proposal: PoBStateProposal,
  candidate: PoBImportPreview["resolution"]["candidates"][number],
): HTMLElement {
  const row = document.createElement("div");
  row.className = "pob-import-state";
  row.dataset.candidateId = proposal.candidateId;

  const include = document.createElement("input");
  include.type = "checkbox";
  include.className = "pob-state-include";
  include.checked = candidate.complete;
  include.setAttribute("aria-label", `Import ${candidate.name}`);

  const identity = document.createElement("label");
  identity.className = "pob-state-identity";
  const source = document.createElement("span");
  source.className = "pob-state-source";
  source.textContent = candidate.name;
  const name = document.createElement("input");
  name.type = "text";
  name.className = "pob-state-name";
  name.maxLength = 120;
  name.value = proposal.name;
  identity.append(source, name);
  if (candidate.missingSections.length) {
    const missing = document.createElement("span");
    missing.className = "pob-state-missing";
    missing.textContent = "Missing " + candidate.missingSections.join(", ");
    identity.appendChild(missing);
  }

  const phase = document.createElement("select");
  phase.className = "pob-state-phase";
  for (const option of PHASES) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    element.selected = option.value === proposal.phase;
    phase.appendChild(element);
  }

  const level = document.createElement("input");
  level.type = "number";
  level.className = "pob-state-level";
  level.min = "1";
  level.max = "100";
  level.placeholder = "—";
  if (proposal.characterLevel != null) {
    level.value = String(proposal.characterLevel);
  }

  const range = document.createElement("span");
  range.className = "pob-state-range";
  const from = document.createElement("input");
  from.type = "number";
  from.className = "pob-state-range-from";
  from.min = "1";
  from.max = "100";
  from.placeholder = "from";
  const dash = document.createElement("span");
  dash.textContent = "–";
  const to = document.createElement("input");
  to.type = "number";
  to.className = "pob-state-range-to";
  to.min = "1";
  to.max = "100";
  to.placeholder = "to";
  if (proposal.recommendedLevelRange) {
    from.value = String(proposal.recommendedLevelRange[0]);
    to.value = String(proposal.recommendedLevelRange[1]);
  }
  range.append(from, dash, to);

  row.append(include, identity, phase, level, range);
  return row;
}

function selectedRows(): HTMLElement[] {
  if (!states) return [];
  return [...states.querySelectorAll<HTMLElement>(".pob-import-state")]
    .filter((row) =>
      row.querySelector<HTMLInputElement>(".pob-state-include")?.checked
    );
}

function updateDefaultOptions(preferred?: string): void {
  if (!defaultState) return;
  const previous = preferred ?? defaultState.value;
  defaultState.innerHTML = "";
  for (const row of selectedRows()) {
    const id = row.dataset.candidateId!;
    const option = document.createElement("option");
    option.value = id;
    option.textContent =
      row.querySelector<HTMLInputElement>(".pob-state-name")?.value ||
      row.querySelector<HTMLElement>(".pob-state-source")?.textContent ||
      id;
    defaultState.appendChild(option);
  }
  if ([...defaultState.options].some((option) => option.value === previous)) {
    defaultState.value = previous;
  }
}

function invalidatePreparedReview(): void {
  if (!preview) return;
  pending = null;
  if (confirmButton) {
    confirmButton.textContent = "Review compatibility";
    confirmButton.classList.remove("ready");
  }
  renderReport(preview.report, "Source inspection");
}

function renderPreview(value: PoBImportPreview): void {
  if (
    !states || !sourceSummary || !planName || !reviewSection ||
    !confirmButton || !defaultState
  ) return;
  states.innerHTML = "";
  for (const proposal of value.proposals) {
    const candidate = value.resolution.candidates.find((item) =>
      item.id === proposal.candidateId
    );
    if (candidate) states.appendChild(candidateRow(proposal, candidate));
  }
  const complete = value.resolution.candidates.filter((item) => item.complete)
    .length;
  const actorSets = value.resolution.actorItemSets.length;
  sourceSummary.textContent =
    `${value.source.treeSets.length} tree profiles · ${complete} complete · ` +
    `${value.source.skillSets.length} skill sets · ` +
    `${value.source.itemSets.length} item sets · ${actorSets} actor item ` +
    `${actorSets === 1 ? "set" : "sets"}`;
  planName.value = [
    value.source.className,
    value.source.ascendancyName,
    "PoB import",
  ].filter(Boolean).join(" · ");
  if (arrangement) arrangement.value = "siblings";
  if (includeActors) includeActors.checked = actorSets > 0;
  updateDefaultOptions(
    value.resolution.candidates.find((item) =>
      item.tree.index === value.source.activeTreeIndex
    )?.id,
  );
  pending = null;
  renderReport(value.report, "Source inspection");
  reviewSection.classList.remove("hidden");
  confirmButton.hidden = false;
  confirmButton.textContent = "Review compatibility";
  setStatus("Source parsed. Review every selected state before continuing.");
}

async function resolveInput(raw: string): Promise<string> {
  if (!/^https?:\/\//i.test(raw.trim())) {
    sourceUrl = undefined;
    return raw;
  }
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    throw new Error(
      "The static local server cannot resolve pobb.in links. Paste the PoB code or choose a local file for local testing.",
    );
  }
  let response: Response;
  try {
    response = await fetch("/pob/raw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: raw.trim() }),
    });
  } catch {
    throw new Error(
      "Could not reach the pobb.in resolver. Paste the PoB code or choose a local file instead.",
    );
  }
  if (
    !response.ok &&
    response.status === 404 &&
    (location.hostname === "127.0.0.1" || location.hostname === "localhost")
  ) {
    throw new Error(
      "The static local server cannot resolve pobb.in links. Paste the PoB code or choose a local file for local testing.",
    );
  }
  let body: { ok?: boolean; code?: string; sourceUrl?: string; error?: string };
  try {
    body = await response.json() as typeof body;
  } catch {
    throw new Error(
      location.hostname === "127.0.0.1" || location.hostname === "localhost"
        ? "The static local server cannot resolve pobb.in links. Paste the PoB code or choose a local file for local testing."
        : "The pobb.in resolver returned an invalid response.",
    );
  }
  if (!response.ok || !body.ok || !body.code) {
    throw new Error(body.error || "Could not resolve that pobb.in link.");
  }
  sourceUrl = body.sourceUrl;
  return body.code;
}

async function inspectCurrentInput(): Promise<void> {
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) {
    setStatus("Paste a PoB code, XML, or pobb.in link first.", true);
    return;
  }
  setBusy(true);
  setStatus("Decoding and inspecting the authored PoB sets…");
  try {
    const resolved = await resolveInput(raw);
    preview = await inspectPoBImport(resolved, {}, PROFILE);
    renderPreview(preview);
  } catch (error) {
    preview = null;
    pending = null;
    reviewSection?.classList.add("hidden");
    if (confirmButton) confirmButton.hidden = true;
    setStatus(
      error instanceof Error ? error.message : String(error),
      true,
    );
  } finally {
    setBusy(false);
  }
}

function numberValue(
  input: HTMLInputElement | null,
  label: string,
): number | undefined {
  if (!input?.value.trim()) return undefined;
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`${label} must be a whole number from 1 to 100.`);
  }
  return value;
}

function collectReview(): PoBImportReview {
  if (
    !preview || !planName || !arrangement || !defaultState ||
    !includeActors
  ) {
    throw new Error("Inspect a PoB source before reviewing it.");
  }
  const rows = selectedRows();
  if (!rows.length) throw new Error("Select at least one PoB profile.");
  const stateReview: PoBImportReview["states"] = {};
  const order: string[] = [];
  for (const row of rows) {
    const id = row.dataset.candidateId!;
    const name = row.querySelector<HTMLInputElement>(".pob-state-name")
      ?.value.trim();
    if (!name) throw new Error("Every selected state needs a name.");
    const phase = row.querySelector<HTMLSelectElement>(".pob-state-phase")
      ?.value as CharacterStatePhase;
    const level = numberValue(
      row.querySelector<HTMLInputElement>(".pob-state-level"),
      `${name} level`,
    );
    const from = numberValue(
      row.querySelector<HTMLInputElement>(".pob-state-range-from"),
      `${name} guidance start`,
    );
    const to = numberValue(
      row.querySelector<HTMLInputElement>(".pob-state-range-to"),
      `${name} guidance end`,
    );
    if (from != null && to != null && from > to) {
      throw new Error(`${name} guidance start cannot exceed its end.`);
    }
    const range = from != null || to != null
      ? [from ?? to!, to ?? from!] as [number, number]
      : undefined;
    order.push(id);
    stateReview[id] = {
      name,
      phase,
      ...(level != null ? { characterLevel: level } : {}),
      ...(range ? { recommendedLevelRange: range } : {}),
    };
  }
  if (!order.includes(defaultState.value)) {
    throw new Error("Choose a default state from the selected profiles.");
  }
  return {
    planName: planName.value,
    candidateOrder: order,
    arrangement: arrangement.value === "linear" ? "linear" : "siblings",
    defaultLeafCandidateId: defaultState.value,
    states: stateReview,
    includeActorLoadouts: includeActors.checked,
  };
}

async function clusterSkills(): Promise<
  NonNullable<NonNullable<ClusterEnvelope["cluster"]>["skills"]>
> {
  if (!PROFILE.definition.jewels.clusterExpansion) return [];
  if (clusterSkillsPromise) return clusterSkillsPromise;
  clusterSkillsPromise = (async () => {
    const url = assetUrl("jewels");
    if (!url) throw new Error("This game profile has no jewel data source.");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        "Could not load the first-party cluster-jewel catalogue.",
      );
    }
    const data = await response.json() as ClusterEnvelope;
    if (!Array.isArray(data.cluster?.skills)) {
      throw new Error("The cluster-jewel catalogue has an invalid shape.");
    }
    return data.cluster.skills;
  })();
  return clusterSkillsPromise;
}

async function buildReviewedResult(): Promise<PoBImportResult> {
  if (!preview) throw new Error("Inspect a PoB source first.");
  const result = normalizePoBImport(preview, collectReview(), {
    profile: PROFILE,
    patch: window.BuildwrightPatch ??
      window.BuildwrightPlan?.native.get().patch ?? null,
    knownNodeIds: PATCH_NODE_IDS,
    clusterSkills: await clusterSkills(),
    sourceUrl,
  });
  const errors = validatePlanForSelectedGame(result.plan, PROFILE);
  if (errors.length) {
    throw new Error("The normalized plan is invalid: " + errors.join("; "));
  }
  return result;
}

async function prepareOrImport(): Promise<void> {
  if (!confirmButton) return;
  setBusy(true);
  try {
    if (!pending) {
      pending = await buildReviewedResult();
      renderReport(pending.report, "Final compatibility review");
      confirmButton.textContent = "Import reviewed plan";
      confirmButton.classList.add("ready");
      setStatus(
        "Compatibility review is ready. Read the final report, then confirm the local replacement.",
      );
      return;
    }
    const plan: PlanV3 = pending.plan;
    if (!window.BuildwrightPlan?.native.replace(plan)) {
      throw new Error("The local plan store refused the normalized import.");
    }
    const stateCount = plan.states.length;
    hide();
    window.BuildwrightPlan.flash(
      `Imported ${stateCount} reviewed PoB ${
        stateCount === 1 ? "state" : "states"
      } locally`,
    );
  } catch (error) {
    pending = null;
    confirmButton.textContent = "Review compatibility";
    confirmButton.classList.remove("ready");
    setStatus(
      error instanceof Error ? error.message : String(error),
      true,
    );
  } finally {
    setBusy(false);
  }
}

if (
  PROFILE.integrations.pobImport !== "enabled" ||
  !openButton || !modal
) {
  entry?.remove();
  openButton?.remove();
  modal?.remove();
} else {
  if (entryGame) entryGame.textContent = PROFILE.definition.shortLabel;
  if (modalKicker) {
    modalKicker.textContent =
      `${PROFILE.definition.pathOfBuilding.label.toLocaleUpperCase()} · ` +
      PROFILE.definition.shortLabel.toLocaleUpperCase();
  }
  const isLocal = location.hostname === "127.0.0.1" ||
    location.hostname === "localhost";
  if (entry) entry.hidden = false;
  openButton.hidden = false;
  if (isLocal) {
    if (sourceLabel) sourceLabel.textContent = "PoB export code or XML";
    if (input) {
      input.placeholder =
        "Paste a PoB export code or PathOfBuilding XML, or choose a local file…";
    }
    if (sourceHelp) {
      sourceHelp.textContent =
        "Local testing: paste the export code copied from PoB/pobb.in, or choose an XML/text file. Direct pobb.in links require the deployed resolver.";
    }
  } else if (sourceHelp) {
    sourceHelp.textContent =
      "Paste a PoB export code/XML, choose a file, or use a canonical https://pobb.in/… link.";
  }
  openButton.addEventListener("click", show);
  closeButton?.addEventListener("click", hide);
  cancelButton?.addEventListener("click", hide);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) hide();
  });
  inspectButton?.addEventListener("click", () => void inspectCurrentInput());
  fileButton?.addEventListener("click", () => {
    void (async () => {
      const file = await pickFile(".xml,.pob,.txt,text/xml,text/plain");
      if (!file || !input) return;
      if (file.size > 16 * 1024 * 1024) {
        setStatus("That file is larger than the 16 MiB XML limit.", true);
        return;
      }
      input.value = await file.text();
      sourceUrl = undefined;
      await inspectCurrentInput();
    })();
  });
  states?.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains("pob-state-name")) updateDefaultOptions();
    invalidatePreparedReview();
  });
  states?.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains("pob-state-include")) {
      updateDefaultOptions();
    }
    invalidatePreparedReview();
  });
  arrangement?.addEventListener("change", invalidatePreparedReview);
  defaultState?.addEventListener("change", invalidatePreparedReview);
  planName?.addEventListener("input", invalidatePreparedReview);
  includeActors?.addEventListener("change", invalidatePreparedReview);
  confirmButton?.addEventListener("click", () => void prepareOrImport());
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) hide();
  });
}
