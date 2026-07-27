// Pure, bounded Path of Building import primitives.
//
// This module has no DOM, window, active-game, or persistence dependency.
// It decodes the public PoB share representation, parses the authored XML
// into a deliberately small intermediate model, and reproduces PoB's
// loadout-title/link-identifier matching. Normalization and user review sit
// outside this boundary so no inferred chronology can be saved implicitly.

import type { ItemModV3, ItemSocketV3 } from "../../../../types/shared.d.ts";

export interface PoBImportLimits {
  maxEncodedBytes: number;
  maxCompressedBytes: number;
  maxXmlBytes: number;
  maxXmlNodes: number;
  maxXmlDepth: number;
}

export const DEFAULT_POB_IMPORT_LIMITS: PoBImportLimits = {
  maxEncodedBytes: 6 * 1024 * 1024,
  maxCompressedBytes: 4 * 1024 * 1024,
  maxXmlBytes: 16 * 1024 * 1024,
  maxXmlNodes: 200_000,
  maxXmlDepth: 128,
};

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export interface PoBTitle {
  raw: string;
  display: string;
  setName: string;
  identifiers: string[];
}

export interface PoBTreeSet {
  index: number;
  title: PoBTitle;
  treeVersion?: string;
  classId?: number;
  ascendancyId?: number;
  nodes: string[];
  masteries: Array<{ nodeId: string; effectId: string }>;
  sockets: Array<{ nodeId: string; itemId: string }>;
  overrideCount: number;
}

export interface PoBGem {
  sourceId: string;
  name?: string;
  role: "active" | "support" | "granted";
  level?: number;
  quality?: number;
  variant?: string;
  enabled: boolean;
  minionItemSetId?: string;
}

export interface PoBSkillGroup {
  index: number;
  label?: string;
  slot?: string;
  enabled: boolean;
  gems: PoBGem[];
}

export interface PoBSkillSet {
  id: string;
  index: number;
  title: PoBTitle;
  groups: PoBSkillGroup[];
}

export interface PoBItem {
  id: string;
  name?: string;
  base?: string;
  rarity?: string;
  uniqueName?: string;
  itemLevel?: number;
  quality?: number;
  corrupted?: boolean;
  sockets?: ItemSocketV3[];
  mods?: ItemModV3[];
  cluster?: {
    size: "Small" | "Medium" | "Large";
    passiveCount?: number;
    jewelSocketCount?: number;
    smallPassiveText?: string;
  };
  sourceText: string;
}

export interface PoBItemPlacement {
  slotName: string;
  itemId: string;
  socketNodeId?: string;
}

export interface PoBItemSet {
  id: string;
  index: number;
  title: PoBTitle;
  useSecondWeaponSet: boolean;
  placements: PoBItemPlacement[];
}

export interface PoBConfigSet {
  id: string;
  index: number;
  title: PoBTitle;
  inputCount: number;
  customMods?: string;
}

export interface PoBSourceModel {
  targetVersion?: string;
  className?: string;
  ascendancyName?: string;
  activeLevel?: number;
  activeTreeIndex?: number;
  notes?: string;
  calculatedPlayerStatCount: number;
  treeSets: PoBTreeSet[];
  skillSets: PoBSkillSet[];
  items: Record<string, PoBItem>;
  itemSets: PoBItemSet[];
  configSets: PoBConfigSet[];
  omittedSections: Array<{ name: string; count: number }>;
}

export interface PoBLoadoutCandidate {
  id: string;
  name: string;
  identifier?: string;
  tree: PoBTreeSet;
  skills?: PoBSkillSet;
  items?: PoBItemSet;
  config?: PoBConfigSet;
  complete: boolean;
  missingSections: Array<"skills" | "items" | "config">;
}

export interface PoBLoadoutResolution {
  candidates: PoBLoadoutCandidate[];
  actorItemSets: Array<{
    itemSet: PoBItemSet;
    kind: "animate-guardian" | "companion" | "minion";
    sourceSkill: string;
    skillSetIds: string[];
  }>;
  unmatched: {
    skills: PoBSkillSet[];
    items: PoBItemSet[];
    config: PoBConfigSet[];
  };
}

function fail(message: string): never {
  throw new Error("Invalid Path of Building input: " + message);
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertXmlSize(xml: string, limits: PoBImportLimits): void {
  if (utf8Size(xml) > limits.maxXmlBytes) {
    fail(`decompressed XML exceeds ${limits.maxXmlBytes} bytes`);
  }
}

async function inflateBounded(
  bytes: Uint8Array,
  limits: PoBImportLimits,
): Promise<string> {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream()
      .pipeThrough(
        new DecompressionStream("deflate"),
      );
  } catch {
    fail("share code is not valid deflate data");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limits.maxXmlBytes) {
        await reader.cancel();
        fail(`decompressed XML exceeds ${limits.maxXmlBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Invalid Path of Building input:")
    ) throw error;
    fail("share code could not be decompressed");
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    fail("decompressed payload is not valid UTF-8");
  }
}

/** Accept raw PoB XML or the URL-safe base64/deflate share representation.
 * Remote URLs are intentionally rejected here; only the allowlisted server
 * resolver may turn a pobb.in URL into a raw share code. */
export async function decodePoBInput(
  input: string,
  overrides: Partial<PoBImportLimits> = {},
): Promise<string> {
  const limits = { ...DEFAULT_POB_IMPORT_LIMITS, ...overrides };
  const trimmed = input.trim();
  if (!trimmed) fail("input is empty");
  if (/^https?:\/\//i.test(trimmed)) {
    fail("remote URLs must be resolved by the allowlisted server endpoint");
  }
  if (trimmed.startsWith("<")) {
    assertXmlSize(trimmed, limits);
    return trimmed;
  }
  const encoded = trimmed.replace(/\s+/g, "");
  if (encoded.length > limits.maxEncodedBytes) {
    fail(`share code exceeds ${limits.maxEncodedBytes} characters`);
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) {
    fail("share code contains characters outside URL-safe base64");
  }
  const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard + "=".repeat((4 - standard.length % 4) % 4);
  let raw: string;
  try {
    raw = atob(padded);
  } catch {
    fail("share code is not valid base64");
  }
  if (raw.length > limits.maxCompressedBytes) {
    fail(`compressed payload exceeds ${limits.maxCompressedBytes} bytes`);
  }
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  const xml = await inflateBounded(bytes, limits);
  assertXmlSize(xml, limits);
  return xml;
}

function decodeEntity(entity: string): string {
  if (entity === "amp") return "&";
  if (entity === "lt") return "<";
  if (entity === "gt") return ">";
  if (entity === "quot") return '"';
  if (entity === "apos") return "'";
  const decimal = /^#(\d+)$/.exec(entity);
  const hex = /^#x([0-9A-Fa-f]+)$/.exec(entity);
  const value = decimal
    ? Number(decimal[1])
    : hex
    ? Number.parseInt(hex[1]!, 16)
    : NaN;
  if (
    !Number.isInteger(value) || value < 0 || value > 0x10ffff ||
    (value >= 0xd800 && value <= 0xdfff)
  ) {
    fail(`unsupported XML entity &${entity};`);
  }
  return String.fromCodePoint(value);
}

function decodeXmlText(value: string): string {
  return value.replace(
    /&([^;\s]+);/g,
    (_match, entity: string) => decodeEntity(entity),
  );
}

function parseTag(
  raw: string,
): { name: string; attrs: Record<string, string>; selfClosing: boolean } {
  const selfClosing = /\/\s*$/.test(raw);
  const body = raw.replace(/\/\s*$/, "");
  const nameMatch = /^\s*([A-Za-z_][\w:.-]*)/.exec(body);
  if (!nameMatch) fail("malformed opening tag");
  const name = nameMatch[1]!;
  const attrs: Record<string, string> = {};
  let pos = nameMatch[0].length;
  while (pos < body.length) {
    const rest = body.slice(pos);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      pos += whitespace[0].length;
      continue;
    }
    const attr = /^([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/.exec(rest);
    if (!attr) fail(`malformed attribute on <${name}>`);
    if (Object.hasOwn(attrs, attr[1]!)) {
      fail(`duplicate attribute ${attr[1]} on <${name}>`);
    }
    attrs[attr[1]!] = decodeXmlText(attr[3]!);
    pos += attr[0].length;
  }
  return { name, attrs, selfClosing };
}

function parseXml(xml: string, limits: PoBImportLimits): XmlNode {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    fail("DTD and entity declarations are forbidden");
  }
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let nodes = 0;
  let pos = 0;
  while (pos < xml.length) {
    const open = xml.indexOf("<", pos);
    if (open < 0) {
      if (stack.length) stack.at(-1)!.text += decodeXmlText(xml.slice(pos));
      pos = xml.length;
      break;
    }
    if (open > pos && stack.length) {
      stack.at(-1)!.text += decodeXmlText(xml.slice(pos, open));
    }
    if (xml.startsWith("<!--", open)) {
      const close = xml.indexOf("-->", open + 4);
      if (close < 0) fail("unterminated XML comment");
      pos = close + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const close = xml.indexOf("]]>", open + 9);
      if (close < 0) fail("unterminated CDATA section");
      if (!stack.length) fail("CDATA outside the root element");
      stack.at(-1)!.text += xml.slice(open + 9, close);
      pos = close + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const close = xml.indexOf("?>", open + 2);
      if (close < 0) fail("unterminated processing instruction");
      pos = close + 2;
      continue;
    }
    const close = xml.indexOf(">", open + 1);
    if (close < 0) fail("unterminated XML tag");
    const raw = xml.slice(open + 1, close);
    if (/^\s*!/.test(raw)) fail("unsupported XML declaration");
    const ending = /^\s*\/\s*([A-Za-z_][\w:.-]*)\s*$/.exec(raw);
    if (ending) {
      const current = stack.pop();
      if (!current || current.name !== ending[1]) {
        fail(`mismatched closing tag </${ending[1]}>`);
      }
      pos = close + 1;
      continue;
    }
    const parsed = parseTag(raw);
    const node: XmlNode = {
      name: parsed.name,
      attrs: parsed.attrs,
      children: [],
      text: "",
    };
    nodes++;
    if (nodes > limits.maxXmlNodes) {
      fail(`XML exceeds ${limits.maxXmlNodes} elements`);
    }
    if (stack.length >= limits.maxXmlDepth) {
      fail(`XML exceeds nesting depth ${limits.maxXmlDepth}`);
    }
    if (stack.length) stack.at(-1)!.children.push(node);
    else if (root) fail("XML contains multiple root elements");
    else root = node;
    if (!parsed.selfClosing) stack.push(node);
    pos = close + 1;
  }
  if (stack.length) fail(`unclosed <${stack.at(-1)!.name}> element`);
  if (!root) fail("XML has no root element");
  return root;
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((value) => value.name === name);
}

function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node?.children.filter((value) => value.name === name) ?? [];
}

function finiteInteger(value: string | undefined): number | undefined {
  if (value == null || value === "" || value === "nil") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function parsePoBTitle(raw = "Default"): PoBTitle {
  const match = /\{([\w,]+)\}/.exec(raw);
  const identifiers = match ? match[1]!.split(",").filter(Boolean) : [];
  const withoutIdentifier = match ? raw.replace(match[0], "") : raw;
  const stripColors = (value: string): string =>
    value.replace(/\^(?:x[0-9A-Fa-f]{6}|\d)/g, "").trim();
  return {
    raw,
    display: stripColors(raw) || "Default",
    setName: stripColors(withoutIdentifier) || "Default",
    identifiers,
  };
}

function parseMasteries(value = ""): PoBTreeSet["masteries"] {
  const result: PoBTreeSet["masteries"] = [];
  for (const match of value.matchAll(/\{(\d+),(\d+)\}/g)) {
    result.push({ nodeId: match[1]!, effectId: match[2]! });
  }
  return result;
}

function gemRole(sourceId: string): PoBGem["role"] {
  if (/SupportGem/i.test(sourceId)) return "support";
  if (/SkillGem/i.test(sourceId)) return "active";
  return "granted";
}

function parseSkillSet(node: XmlNode, index: number): PoBSkillSet {
  const groups = children(node, "Skill").map((group, groupIndex) => {
    const gems = children(group, "Gem").map((gem) => {
      const sourceId = gem.attrs.gemId || gem.attrs.skillId ||
        gem.attrs.nameSpec;
      if (!sourceId) fail("Gem has no source identity");
      return {
        sourceId,
        ...(gem.attrs.nameSpec ? { name: gem.attrs.nameSpec } : {}),
        role: gemRole(sourceId),
        ...(finiteInteger(gem.attrs.level) != null
          ? { level: finiteInteger(gem.attrs.level) }
          : {}),
        ...(finiteInteger(gem.attrs.quality) != null
          ? { quality: finiteInteger(gem.attrs.quality) }
          : {}),
        ...(gem.attrs.variantId ? { variant: gem.attrs.variantId } : {}),
        enabled: gem.attrs.enabled !== "false",
        ...(gem.attrs.skillMinionItemSet &&
            gem.attrs.skillMinionItemSet !== "nil"
          ? { minionItemSetId: gem.attrs.skillMinionItemSet }
          : {}),
      } satisfies PoBGem;
    });
    return {
      index: groupIndex,
      ...(group.attrs.label ? { label: group.attrs.label } : {}),
      ...(group.attrs.slot ? { slot: group.attrs.slot } : {}),
      enabled: group.attrs.enabled !== "false",
      gems,
    };
  });
  return {
    id: node.attrs.id || String(index + 1),
    index,
    title: parsePoBTitle(node.attrs.title),
    groups,
  };
}

function normalizedItemSource(text: string): string {
  return text.replace(/^\s*\n/, "").replace(/\n\s*$/, "").trim();
}

function socketsFromText(value: string): ItemSocketV3[] {
  const result: ItemSocketV3[] = [];
  value.trim().split(/\s+/).filter(Boolean).forEach((group, groupIndex) => {
    group.split("-").filter(Boolean).forEach((token) => {
      const upper = token.toUpperCase();
      if (["R", "G", "B", "W"].includes(upper)) {
        result.push({ group: groupIndex, color: upper, kind: "gem" });
      } else if (upper === "A") {
        result.push({ group: groupIndex, kind: "abyss" });
      } else {
        result.push({ group: groupIndex, kind: token.toLocaleLowerCase() });
      }
    });
  });
  return result;
}

function stripPoBStatMarkup(
  line: string,
  selectedVariant?: string,
): string | null {
  const variant = /^\{variant:([^}]+)\}/.exec(line);
  if (
    variant && selectedVariant &&
    !variant[1]!.split(",").includes(selectedVariant)
  ) return null;
  let value = line.replace(/^(?:\{[^}]+\})+/, "").trim();
  value = value.replace(/^(?:crafted|fractured|scourge|implicit)\s+/i, "");
  return value || null;
}

function itemHeaderMetadata(line: string | undefined): boolean {
  return !line ||
    /^(?:Armour|Evasion|Energy Shield|Ward|Quality|Catalyst|CatalystQuality|Item Level|LevelReq|Sockets|Crafted|Prefix|Suffix|Implicits|Variant|Selected Variant):/i
      .test(line) ||
    /^(?:Searing Exarch Item|Eater of Worlds Item|Shaper Item|Elder Item)$/i
      .test(line);
}

function meaningfulItemName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : undefined;
}

function parseItem(node: XmlNode): PoBItem {
  const sourceText = normalizedItemSource(node.text);
  const lines = sourceText.split(/\r?\n/).map((value) => value.trim());
  const rarityIndex = lines.findIndex((value) => /^Rarity:/i.test(value));
  const rarity = rarityIndex >= 0
    ? lines[rarityIndex]!.slice(lines[rarityIndex]!.indexOf(":") + 1)
      .trim().toLocaleLowerCase()
    : undefined;
  const firstHeader = rarityIndex >= 0
    ? lines[rarityIndex + 1] || undefined
    : undefined;
  const secondHeader = rarityIndex >= 0
    ? lines[rarityIndex + 2] || undefined
    : undefined;
  const name = rarity === "normal"
    ? undefined
    : meaningfulItemName(firstHeader);
  const base = rarity === "normal"
    ? firstHeader
    : !itemHeaderMetadata(secondHeader)
    ? secondHeader
    : undefined;
  const selectedVariant = lines.find((value) =>
    /^Selected Variant:/i.test(value)
  )
    ?.split(":").at(-1)?.trim();
  const readNumber = (label: RegExp): number | undefined => {
    const found = lines.find((value) => label.test(value));
    const parsed = found ? Number(found.split(":").at(-1)?.trim()) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const socketLine = lines.find((value) => /^Sockets:/i.test(value));
  const implicitIndex = lines.findIndex((value) => /^Implicits:/i.test(value));
  const clusterSize = /^(Small|Medium|Large) Cluster Jewel$/i.exec(base || "")
    ?.[1] as "Small" | "Medium" | "Large" | undefined;
  const passiveCount = lines.map((value) =>
    /^Adds (\d+) Passive Skills$/i.exec(value)
  ).find(Boolean)?.[1];
  const jewelSocketCount = lines.map((value) =>
    /^(\d+) Added Passive Skills? (?:is|are) Jewel Sockets?$/i.exec(value)
  ).find(Boolean)?.[1];
  const smallPassiveText = lines.map((value) =>
    /^Added Small Passive Skills grant:\s*(.+)$/i.exec(value)
  ).find(Boolean)?.[1];
  const mods: ItemModV3[] = [];
  if (implicitIndex >= 0) {
    for (const line of lines.slice(implicitIndex + 1)) {
      if (
        !line ||
        /^(?:Corrupted|Split|Mirrored)$/i.test(line) ||
        /^Adds \d+ Passive Skills$/i.test(line) ||
        /^Added Small Passive Skills grant:/i.test(line) ||
        /^\d+ Added Passive Skills? (?:is|are) Jewel Sockets?$/i.test(line)
      ) continue;
      const stat = stripPoBStatMarkup(line, selectedVariant);
      if (stat) mods.push({ kind: "pob-text", text: stat });
    }
  }
  return {
    id: node.attrs.id || "",
    ...(name ? { name } : {}),
    ...(base ? { base } : {}),
    ...(rarity ? { rarity } : {}),
    ...(rarity === "unique" && name ? { uniqueName: name } : {}),
    ...(readNumber(/^Item Level:/i) != null
      ? { itemLevel: readNumber(/^Item Level:/i) }
      : {}),
    ...(readNumber(/^Quality:/i) != null
      ? { quality: readNumber(/^Quality:/i) }
      : {}),
    ...(lines.some((value) => /^Corrupted$/i.test(value))
      ? { corrupted: true }
      : {}),
    ...(socketLine
      ? {
        sockets: socketsFromText(socketLine.slice(socketLine.indexOf(":") + 1)),
      }
      : {}),
    ...(mods.length ? { mods } : {}),
    ...(clusterSize
      ? {
        cluster: {
          size: clusterSize,
          ...(passiveCount ? { passiveCount: Number(passiveCount) } : {}),
          ...(jewelSocketCount
            ? { jewelSocketCount: Number(jewelSocketCount) }
            : {}),
          ...(smallPassiveText ? { smallPassiveText } : {}),
        },
      }
      : {}),
    sourceText,
  };
}

function parseItemSet(node: XmlNode, index: number): PoBItemSet {
  const placements: PoBItemPlacement[] = [];
  for (const slot of children(node, "Slot")) {
    if (!slot.attrs.name || !slot.attrs.itemId || slot.attrs.itemId === "0") {
      continue;
    }
    placements.push({
      slotName: slot.attrs.name,
      itemId: slot.attrs.itemId,
    });
  }
  for (const socket of children(node, "SocketIdURL")) {
    if (
      !socket.attrs.nodeId || !socket.attrs.itemId ||
      socket.attrs.itemId === "0"
    ) continue;
    placements.push({
      slotName: socket.attrs.name || "Jewel " + socket.attrs.nodeId,
      itemId: socket.attrs.itemId,
      socketNodeId: socket.attrs.nodeId,
    });
  }
  return {
    id: node.attrs.id || String(index + 1),
    index,
    title: parsePoBTitle(node.attrs.title),
    useSecondWeaponSet: node.attrs.useSecondWeaponSet === "true",
    placements,
  };
}

/** Parse PoB XML into source-owned independent sets. Calculated values are
 * counted for the review report but never promoted into authored facts. */
export function parsePoBXml(
  xml: string,
  overrides: Partial<PoBImportLimits> = {},
): PoBSourceModel {
  const limits = { ...DEFAULT_POB_IMPORT_LIMITS, ...overrides };
  assertXmlSize(xml, limits);
  const root = parseXml(xml, limits);
  if (root.name !== "PathOfBuilding") {
    fail("root element must be PathOfBuilding");
  }
  const build = child(root, "Build");
  const tree = child(root, "Tree");
  const skills = child(root, "Skills");
  const itemRoot = child(root, "Items");
  const config = child(root, "Config");
  if (!build || !tree) fail("Build and Tree sections are required");

  const treeSets = children(tree, "Spec").map((spec, index) => {
    const sockets = children(child(spec, "Sockets"), "Socket")
      .filter((value) => value.attrs.nodeId && value.attrs.itemId)
      .map((value) => ({
        nodeId: value.attrs.nodeId!,
        itemId: value.attrs.itemId!,
      }));
    return {
      index,
      title: parsePoBTitle(spec.attrs.title),
      ...(spec.attrs.treeVersion
        ? { treeVersion: spec.attrs.treeVersion }
        : {}),
      ...(finiteInteger(spec.attrs.classId) != null
        ? { classId: finiteInteger(spec.attrs.classId) }
        : {}),
      ...(finiteInteger(spec.attrs.ascendClassId) != null
        ? { ascendancyId: finiteInteger(spec.attrs.ascendClassId) }
        : {}),
      nodes: (spec.attrs.nodes || "").split(",").filter(Boolean),
      masteries: parseMasteries(spec.attrs.masteryEffects),
      sockets,
      overrideCount: children(child(spec, "Overrides"), "Override").length,
    } satisfies PoBTreeSet;
  });
  const skillSets = children(skills, "SkillSet").map(parseSkillSet);
  const items = Object.fromEntries(
    children(itemRoot, "Item").map((value) => {
      const parsed = parseItem(value);
      return [parsed.id, parsed];
    }),
  );
  const itemSets = children(itemRoot, "ItemSet").map(parseItemSet);
  const configSets = children(config, "ConfigSet").map((set, index) => {
    const inputs = children(set, "Input");
    const customMods = inputs.find((value) => value.attrs.name === "customMods")
      ?.attrs.string;
    return {
      id: set.attrs.id || String(index + 1),
      index,
      title: parsePoBTitle(set.attrs.title),
      inputCount: inputs.length,
      ...(customMods ? { customMods } : {}),
    };
  });
  const omittedNames = ["Calcs", "TreeView", "Party", "Import"];
  return {
    ...(build.attrs.targetVersion
      ? { targetVersion: build.attrs.targetVersion }
      : {}),
    ...(build.attrs.className ? { className: build.attrs.className } : {}),
    ...(build.attrs.ascendClassName
      ? { ascendancyName: build.attrs.ascendClassName }
      : {}),
    ...(finiteInteger(build.attrs.level) != null
      ? { activeLevel: finiteInteger(build.attrs.level) }
      : {}),
    ...(finiteInteger(tree.attrs.activeSpec) != null
      ? { activeTreeIndex: finiteInteger(tree.attrs.activeSpec)! - 1 }
      : {}),
    ...(child(root, "Notes")?.text.trim()
      ? { notes: child(root, "Notes")!.text.trim() }
      : {}),
    calculatedPlayerStatCount: children(build, "PlayerStat").length,
    treeSets,
    skillSets,
    items,
    itemSets,
    configSets,
    omittedSections: omittedNames.flatMap((name) => {
      const section = child(root, name);
      return section ? [{ name, count: 1 }] : [];
    }),
  };
}

function linkedSet<T extends { title: PoBTitle }>(
  sets: T[],
  tree: PoBTreeSet,
  identifier?: string,
): T | undefined {
  if (sets.length === 1) return sets[0];
  if (identifier) {
    let match: T | undefined;
    for (const set of sets) {
      if (set.title.identifiers.includes(identifier)) match = set;
    }
    return match;
  }
  return sets.find((set) => set.title.raw === tree.title.raw);
}

function actorKindForGem(
  gem: PoBGem,
): "animate-guardian" | "companion" | "minion" {
  const identity = [gem.name, gem.sourceId, gem.variant].filter(Boolean)
    .join(" ");
  if (/Animate Guardian|AnimateArmour|AnimateGuardian/i.test(identity)) {
    return "animate-guardian";
  }
  if (/Companion|BeastCompanion/i.test(identity)) return "companion";
  return "minion";
}

/** Reproduce PoB's tree-driven loadout matching. A single set in a section
 * broadcasts; multi-set sections match exact raw titles or brace IDs.
 * Incomplete tree candidates remain visible for explicit review. */
export function resolvePoBLoadouts(
  model: PoBSourceModel,
): PoBLoadoutResolution {
  const candidates: PoBLoadoutCandidate[] = [];
  const usedSkills = new Set<string>();
  const usedItems = new Set<string>();
  const usedConfig = new Set<string>();
  const actorRefs = new Map<string, {
    kind: "animate-guardian" | "companion" | "minion";
    sourceSkill: string;
    skillSetIds: Set<string>;
  }>();
  for (const set of model.skillSets) {
    for (const group of set.groups) {
      for (const gem of group.gems) {
        if (!gem.minionItemSetId) continue;
        const existing = actorRefs.get(gem.minionItemSetId);
        if (existing) existing.skillSetIds.add(set.id);
        else {
          actorRefs.set(gem.minionItemSetId, {
            kind: actorKindForGem(gem),
            sourceSkill: gem.name || gem.sourceId,
            skillSetIds: new Set([set.id]),
          });
        }
      }
    }
  }

  for (const tree of model.treeSets) {
    const identifiers = tree.title.identifiers.length
      ? tree.title.identifiers
      : [undefined];
    for (const identifier of identifiers) {
      const skills = linkedSet(model.skillSets, tree, identifier);
      const items = linkedSet(model.itemSets, tree, identifier);
      const config = linkedSet(model.configSets, tree, identifier);
      if (skills) usedSkills.add(skills.id);
      if (items) usedItems.add(items.id);
      if (config) usedConfig.add(config.id);
      const missingSections: PoBLoadoutCandidate["missingSections"] = [];
      if (!skills) missingSections.push("skills");
      if (!items) missingSections.push("items");
      if (!config) missingSections.push("config");
      candidates.push({
        id: "pob:" + tree.index + ":" + (identifier || "title"),
        name: identifier
          ? tree.title.setName + " {" + identifier + "}"
          : tree.title.display,
        ...(identifier ? { identifier } : {}),
        tree,
        ...(skills ? { skills } : {}),
        ...(items ? { items } : {}),
        ...(config ? { config } : {}),
        complete: missingSections.length === 0,
        missingSections,
      });
    }
  }

  const actorItemSets = [...actorRefs].flatMap(([id, relation]) => {
    const itemSet = model.itemSets.find((set) => set.id === id);
    if (!itemSet) return [];
    usedItems.add(itemSet.id);
    return [{
      itemSet,
      kind: relation.kind,
      sourceSkill: relation.sourceSkill,
      skillSetIds: [...relation.skillSetIds],
    }];
  });
  return {
    candidates,
    actorItemSets,
    unmatched: {
      skills: model.skillSets.filter((set) => !usedSkills.has(set.id)),
      items: model.itemSets.filter((set) => !usedItems.has(set.id)),
      config: model.configSets.filter((set) => !usedConfig.has(set.id)),
    },
  };
}
