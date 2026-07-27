/// <reference lib="deno.ns" />

// Stable command-line adapter for Buildwright interoperability.
//
// The Rust `buildwright` binary owns the public commands and the Deno
// permission envelope. This module deliberately reuses the exact pure
// parser, normalizer, game profiles, and validators bundled into the
// browser; there is no second PoB implementation to drift.

import type { GameId, PlanV3 } from "../../../../types/shared.d.ts";
import {
  createGameProfile,
  validatePlanForSelectedGame,
} from "./game_profile.ts";
import type { PoBImportPreview, PoBImportReview } from "./pob_normalize.ts";
import { inspectPoBImport, normalizePoBImport } from "./pob_normalize.ts";
import {
  POBB_TIMEOUT_MS,
  resolvePobbCode,
} from "../../../../viewer/functions/pob/_resolver.ts";
import { buildOfficialCatalogueData } from "./ggg_build_core.ts";
import type {
  OfficialItemCatalogueEnvelope,
  OfficialSkillCatalogueEnvelope,
} from "./ggg_build_core.ts";
import { importOfficialBuild } from "./official_build_import.ts";
import type {
  OfficialBuildImportContext,
  OfficialBuildImportReport,
  OfficialBuildRuntimeMetadata,
} from "./official_build_import.ts";

type CommandName =
  | "pob-inspect"
  | "pob-import"
  | "build-inspect"
  | "build-import";

interface CliOptions {
  command: CommandName;
  game: GameId;
  source?: string;
  url?: string;
  output?: string;
  review?: string;
  report?: string;
  patch?: string;
  /** Injected by the Rust command; not a browser/public workflow flag. */
  dataManifest?: string;
}

interface ReviewEnvelope {
  format: "buildwright-pob-import-review";
  version: 1;
  game: GameId;
  source: {
    sha256: string;
    targetVersion?: string;
    className?: string;
    ascendancyName?: string;
    candidateCount: number;
  };
  candidates: Array<{
    id: string;
    name: string;
    complete: boolean;
    missingSections: string[];
  }>;
  review: PoBImportReview;
  report: PoBImportPreview["report"];
}

interface OfficialReviewEnvelope {
  format: "buildwright-official-build-import-review";
  version: 1;
  game: "poe2";
  source: {
    sha256: string;
    name: string;
  };
  report: OfficialBuildImportReport;
}

interface NodeEnvelope {
  game?: string;
  nodes?: Array<{ id: string | number }>;
}

interface ClusterEnvelope {
  game?: string;
  cluster?: {
    skills?: Array<{
      id: string;
      size: "Small" | "Medium" | "Large";
      stats: string;
      name?: string;
    }>;
  };
}

interface BuildMetaEnvelope {
  game?: string;
  patch?: string;
}

interface PatchManifestEnvelope {
  schema_version?: number;
  patch?: string;
  rollup?: string;
  source_lock_sha256?: string;
}

const ADAPTER_VERSION = "buildwright-interop-v1";

function fail(message: string): never {
  throw new Error(message);
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const command = args.shift();
  if (
    command !== "pob-inspect" &&
    command !== "pob-import" &&
    command !== "build-inspect" &&
    command !== "build-import"
  ) {
    fail("expected pob-inspect, pob-import, build-inspect, or build-import");
  }
  const values = new Map<string, string>();
  const known = new Set([
    "--game",
    "--source",
    "--url",
    "--output",
    "--review",
    "--report",
    "--patch",
    "--data-manifest",
  ]);
  for (let index = 0; index < args.length; index++) {
    const raw = args[index]!;
    const equals = raw.indexOf("=");
    const flag = equals >= 0 ? raw.slice(0, equals) : raw;
    if (!known.has(flag)) fail(`unknown option ${flag}`);
    if (values.has(flag)) fail(`duplicate option ${flag}`);
    const value = equals >= 0
      ? raw.slice(equals + 1)
      : valueAfter(args, index++, flag);
    if (!value) fail(`${flag} requires a value`);
    values.set(flag, value);
  }
  const rawGame = values.get("--game");
  if (rawGame !== "poe1" && rawGame !== "poe2") {
    fail("--game must be poe1 or poe2");
  }
  const source = values.get("--source");
  const url = values.get("--url");
  if (command.startsWith("build-")) {
    if (!source || url) {
      fail("official .build commands require --source <file>");
    }
    if (rawGame !== "poe2") {
      fail("the official .build format is currently PoE2-only");
    }
  } else if (!!source === !!url) {
    fail("provide exactly one of --source <file> or --url <pobb.in link>");
  }
  if (command === "pob-import" || command === "build-import") {
    if (!values.get("--review")) {
      fail(`${command} requires the reviewed --review <file>`);
    }
    if (!values.get("--output")) {
      fail(`${command} requires --output <plan.json>`);
    }
  }
  return {
    command,
    game: rawGame,
    source,
    url,
    output: values.get("--output"),
    review: values.get("--review"),
    report: values.get("--report"),
    patch: values.get("--patch"),
    dataManifest: values.get("--data-manifest"),
  };
}

function localAssetPath(url: string): string {
  if (!url.startsWith("/assets/")) {
    fail(`profile asset is not local: ${url}`);
  }
  return "viewer" + url;
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (error) {
    fail(
      `could not read ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function acquireSource(
  options: CliOptions,
): Promise<{ input: string; sourceUrl?: string }> {
  if (options.source) {
    try {
      return { input: await Deno.readTextFile(options.source) };
    } catch (error) {
      fail(
        `could not read ${options.source}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POBB_TIMEOUT_MS);
  try {
    const resolved = await resolvePobbCode(options.url!, {
      signal: controller.signal,
    });
    return { input: resolved.code, sourceUrl: resolved.sourceUrl };
  } catch (error) {
    fail(
      controller.signal.aborted
        ? "pobb.in did not respond before the timeout"
        : error instanceof Error
        ? error.message
        : String(error),
    );
  } finally {
    clearTimeout(timeout);
  }
}

function proposedReview(preview: PoBImportPreview): PoBImportReview {
  let selected = preview.resolution.candidates.filter((candidate) =>
    candidate.complete
  );
  if (!selected.length) selected = preview.resolution.candidates.slice();
  if (!selected.length) fail("the PoB source contains no tree profiles");
  const proposals = new Map(
    preview.proposals.map((proposal) => [proposal.candidateId, proposal]),
  );
  const states: PoBImportReview["states"] = {};
  for (const candidate of selected) {
    const proposal = proposals.get(candidate.id);
    if (!proposal) fail(`missing proposal for ${candidate.id}`);
    states[candidate.id] = {
      name: proposal.name,
      phase: proposal.phase,
      ...(proposal.characterLevel != null
        ? { characterLevel: proposal.characterLevel }
        : {}),
      ...(proposal.recommendedLevelRange
        ? { recommendedLevelRange: proposal.recommendedLevelRange }
        : {}),
    };
  }
  return {
    planName: preview.source.className
      ? `${preview.source.className} PoB import`
      : "Imported PoB build",
    candidateOrder: selected.map((candidate) => candidate.id),
    arrangement: selected.length > 1 ? "siblings" : "linear",
    defaultLeafCandidateId: selected.at(-1)!.id,
    states,
    includeActorLoadouts: true,
  };
}

function reviewEnvelope(
  game: GameId,
  preview: PoBImportPreview,
  sourceSha256: string,
): ReviewEnvelope {
  return {
    format: "buildwright-pob-import-review",
    version: 1,
    game,
    source: {
      sha256: sourceSha256,
      ...(preview.source.targetVersion
        ? { targetVersion: preview.source.targetVersion }
        : {}),
      ...(preview.source.className
        ? { className: preview.source.className }
        : {}),
      ...(preview.source.ascendancyName
        ? { ascendancyName: preview.source.ascendancyName }
        : {}),
      candidateCount: preview.resolution.candidates.length,
    },
    candidates: preview.resolution.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      complete: candidate.complete,
      missingSections: candidate.missingSections,
    })),
    review: proposedReview(preview),
    report: preview.report,
  };
}

function assertReviewEnvelope(
  value: unknown,
  game: GameId,
): asserts value is ReviewEnvelope {
  if (!value || typeof value !== "object") fail("review must be a JSON object");
  const review = value as Partial<ReviewEnvelope>;
  if (
    review.format !== "buildwright-pob-import-review" ||
    review.version !== 1
  ) {
    fail("review file has an unsupported format or version");
  }
  if (review.game !== game) {
    fail(`review belongs to ${review.game || "unknown"}, expected ${game}`);
  }
  if (!review.review || typeof review.review !== "object") {
    fail("review file is missing its review choices");
  }
  if (!review.source?.sha256) fail("review file has no source digest");
}

async function writeJson(
  path: string | undefined,
  value: unknown,
): Promise<string> {
  const json = JSON.stringify(value, null, 2) + "\n";
  if (path) {
    await Deno.writeTextFile(path, json);
  } else {
    await Deno.stdout.write(new TextEncoder().encode(json));
  }
  return json;
}

async function normalizationAssets(game: GameId): Promise<{
  patch: string | null;
  knownNodeIds: Set<string>;
  clusterSkills: NonNullable<ClusterEnvelope["cluster"]>["skills"];
}> {
  const profile = createGameProfile(game);
  const nodes = await readJson<NodeEnvelope>(
    localAssetPath(profile.definition.assets.nodes),
  );
  if (nodes.game !== game || !Array.isArray(nodes.nodes)) {
    fail(`node catalogue does not belong to ${game}`);
  }
  const meta = await readJson<BuildMetaEnvelope>(
    localAssetPath(profile.definition.assets.buildMeta),
  );
  if (meta.game !== game) fail(`build metadata does not belong to ${game}`);
  let clusterSkills: NonNullable<
    ClusterEnvelope["cluster"]
  >["skills"] = [];
  if (profile.definition.jewels.clusterExpansion) {
    const jewelUrl = profile.definition.assets.jewels;
    if (!jewelUrl) fail(`${game} has no jewel catalogue`);
    const jewels = await readJson<ClusterEnvelope>(localAssetPath(jewelUrl));
    if (jewels.game !== game || !Array.isArray(jewels.cluster?.skills)) {
      fail(`cluster-jewel catalogue does not belong to ${game}`);
    }
    clusterSkills = jewels.cluster.skills;
  }
  return {
    patch: meta.patch || null,
    knownNodeIds: new Set(nodes.nodes.map((node) => String(node.id))),
    clusterSkills,
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function approvedReview<T>(path: string): Promise<{
  value: T;
  sha256: string;
}> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    fail(
      `could not read ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    return { value: JSON.parse(text) as T, sha256: await sha256(text) };
  } catch (error) {
    fail(
      `could not parse ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function dataRollup(options: CliOptions): Promise<string> {
  if (!options.dataManifest) {
    fail("Rust CLI did not provide a patch manifest; imports must be data-locked");
  }
  const manifest = await readJson<PatchManifestEnvelope>(options.dataManifest);
  if (
    (manifest.schema_version ?? 0) < 4 ||
    typeof manifest.rollup !== "string" ||
    manifest.rollup.length !== 64 ||
    typeof manifest.source_lock_sha256 !== "string" ||
    manifest.source_lock_sha256.length !== 64
  ) {
    fail("patch manifest is not source-locked schema v4; rebuild and verify it");
  }
  return manifest.rollup;
}

function stampProvenance(
  plan: PlanV3,
  sourceSha256: string,
  reviewSha256: string,
  rollup: string,
): void {
  const provenance = plan.provenance?.[0];
  if (!provenance) fail("normalized plan has no provenance record");
  provenance.sourceSha256 = sourceSha256;
  provenance.reviewSha256 = reviewSha256;
  provenance.adapterVersion = ADAPTER_VERSION;
  provenance.dataRollup = rollup;
}

async function writeImportReceipt(
  options: CliOptions,
  adapter: "pob-import" | "official-build-import",
  plan: PlanV3,
  planText: string,
  sourceSha256: string,
  reviewSha256: string,
  rollup: string,
  report: unknown,
): Promise<void> {
  const receiptPath = options.report ?? `${options.output}.receipt.json`;
  await writeJson(receiptPath, {
    format: "buildwright-import-receipt",
    version: 1,
    adapter,
    adapterVersion: ADAPTER_VERSION,
    game: options.game,
    patch: plan.patch,
    sourceSha256,
    reviewSha256,
    normalizedPlanSha256: await sha256(planText),
    dataRollup: rollup,
    report,
  });
}

async function officialImportContext(): Promise<OfficialBuildImportContext> {
  const profile = createGameProfile("poe2");
  const [metadata, nodes, skills, items] = await Promise.all([
    readJson<OfficialBuildRuntimeMetadata>(
      localAssetPath(profile.definition.assets.buildMeta),
    ),
    readJson<NodeEnvelope>(localAssetPath(profile.definition.assets.nodes)),
    readJson<OfficialSkillCatalogueEnvelope>(
      localAssetPath(profile.definition.assets.skillCatalogue),
    ),
    readJson<OfficialItemCatalogueEnvelope>(
      localAssetPath(profile.definition.assets.itemCatalogue),
    ),
  ]);
  if (
    metadata.game !== "poe2" ||
    nodes.game !== "poe2" ||
    !Array.isArray(nodes.nodes)
  ) {
    fail("official interop catalogues are not an isolated PoE2 patch set");
  }
  if (
    !metadata.passive_ids ||
    !Object.keys(metadata.passive_ids.buildToGraph).length
  ) {
    fail(
      "build_meta.json has no official passive-id map; rerun ./bw render --game poe2",
    );
  }
  return {
    profile,
    metadata,
    nativeNodeIds: new Set(nodes.nodes.map((node) => String(node.id))),
    catalogue: buildOfficialCatalogueData(skills, items),
  };
}

function assertOfficialReview(
  value: unknown,
): asserts value is OfficialReviewEnvelope {
  if (!value || typeof value !== "object") fail("review must be a JSON object");
  const review = value as Partial<OfficialReviewEnvelope>;
  if (
    review.format !== "buildwright-official-build-import-review" ||
    review.version !== 1 ||
    review.game !== "poe2" ||
    !review.source?.sha256
  ) {
    fail("official .build review has an unsupported format or version");
  }
}

async function main(): Promise<void> {
  const options = parseArgs([...Deno.args]);
  const profile = createGameProfile(options.game);
  const acquired = await acquireSource(options);
  const sourceSha256 = await sha256(acquired.input);

  if (
    options.command === "build-inspect" || options.command === "build-import"
  ) {
    let source: unknown;
    try {
      source = JSON.parse(acquired.input);
    } catch {
      fail("official .build source is not valid JSON");
    }
    const result = importOfficialBuild(source, await officialImportContext());
    const review: OfficialReviewEnvelope = {
      format: "buildwright-official-build-import-review",
      version: 1,
      game: "poe2",
      source: {
        sha256: sourceSha256,
        name: result.plan.identity.name,
      },
      report: result.report,
    };
    if (options.command === "build-inspect") {
      await writeJson(options.output, review);
      return;
    }
    const approved = await approvedReview<unknown>(options.review!);
    assertOfficialReview(approved.value);
    if (approved.value.source.sha256 !== sourceSha256) {
      fail("review digest does not match this .build source; inspect it again");
    }
    const errors = validatePlanForSelectedGame(result.plan, profile);
    if (errors.length) {
      fail("normalized plan is invalid: " + errors.join("; "));
    }
    const rollup = await dataRollup(options);
    stampProvenance(result.plan, sourceSha256, approved.sha256, rollup);
    const planText = await writeJson(options.output, result.plan satisfies PlanV3);
    await writeImportReceipt(
      options,
      "official-build-import",
      result.plan,
      planText,
      sourceSha256,
      approved.sha256,
      rollup,
      result.report,
    );
    console.error(
      `Imported ${result.plan.states.length} official state(s) for poe2`,
    );
    return;
  }

  const preview = await inspectPoBImport(acquired.input, {}, profile);

  if (options.command === "pob-inspect") {
    await writeJson(
      options.output,
      reviewEnvelope(options.game, preview, sourceSha256),
    );
    return;
  }

  const approved = await approvedReview<unknown>(options.review!);
  assertReviewEnvelope(approved.value, options.game);
  const envelope = approved.value;
  if (envelope.source.sha256 !== sourceSha256) {
    fail("review digest does not match this PoB source; inspect it again");
  }
  const assets = await normalizationAssets(options.game);
  const result = normalizePoBImport(preview, envelope.review, {
    profile,
    patch: options.patch ?? assets.patch,
    knownNodeIds: assets.knownNodeIds,
    clusterSkills: assets.clusterSkills,
    sourceUrl: acquired.sourceUrl,
  });
  const errors = validatePlanForSelectedGame(result.plan, profile);
  if (errors.length) {
    fail("normalized plan is invalid: " + errors.join("; "));
  }
  const rollup = await dataRollup(options);
  stampProvenance(result.plan, sourceSha256, approved.sha256, rollup);
  const planText = await writeJson(options.output, result.plan satisfies PlanV3);
  await writeImportReceipt(
    options,
    "pob-import",
    result.plan,
    planText,
    sourceSha256,
    approved.sha256,
    rollup,
    result.report,
  );
  const counts = Object.fromEntries(
    Object.entries(result.report).map(([name, entries]) => [
      name,
      entries.length,
    ]),
  );
  console.error(
    `Imported ${result.plan.states.length} state(s) for ${options.game}: ` +
      JSON.stringify(counts),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      "error: " + (error instanceof Error ? error.message : String(error)),
    );
    Deno.exit(1);
  }
}
