// PoE1 cluster jewels are item-generated passive subgraphs. GGG ships
// the templates, passive definitions, socket/proxy topology and orbit
// offsets separately; jewels.json joins those first-party tables and
// this module materialises only the subgraphs active in the capture.

import { state } from "./state.ts";
import { rebuildGraphIndexes } from "./pathfind.ts";
import { buildStaticGeometry } from "./static_geom.ts";
import { requestRender } from "./render.ts";
import { streamSprites } from "./lazy_art.ts";
import { flushPersistNow, hydrateFromActiveCapture } from "./wizard_sync.ts";
import {
  CLUSTER_SOCKET_FRAME, clusterLayout, clusterSocketCount,
} from "./cluster_rules.ts";
import type { Item, TreeNode } from "../../../../types/shared.d.ts";
import type { ClusterSize } from "./cluster_rules.ts";

export interface ClusterTemplate {
  size_index: number;
  min_nodes: number;
  max_nodes: number;
  total_indices: number;
  small_indices: number[];
  notable_indices: number[];
  socket_indices: number[];
  base: string;
}
export interface ClusterSkill {
  id: string;
  size: "Small" | "Medium" | "Large";
  node_id: number;
  name: string;
  stats: string;
  icon: string;
  mastery_icon: string;
}
export interface ClusterSpecial {
  node_id: number;
  name: string;
  stats: string;
  icon: string;
  kind: "small" | "notable" | "keystone";
  order: number;
}
export interface ClusterSlot {
  size: "Small" | "Medium" | "Large";
  size_index: number;
  cluster_index: number;
  parent: number | null;
  proxy: number;
  group: number;
  cx: number;
  cy: number;
  start_indices: number[];
}
export interface ClusterData {
  templates: Record<string, ClusterTemplate>;
  skills: ClusterSkill[];
  specials: Record<string, ClusterSpecial>;
  slots: Record<string, ClusterSlot>;
}
export interface ClusterModFamily {
  type: string;
  text?: string;
  stats?: string[];
}

const SIZE_BY_BASE: Record<string, "Small" | "Medium" | "Large"> = {
  "small cluster jewel": "Small",
  "medium cluster jewel": "Medium",
  "large cluster jewel": "Large",
};
const FRAME = {
  small: {
    f0: "/assets/sprites/poe1_PSSkillFrame.png",
    f1: "/assets/sprites/poe1_PSSkillFrameActive.png",
    iw: 68, fw: 102,
  },
  notable: {
    f0: "/assets/sprites/poe1_NotableFrameUnallocated.png",
    f1: "/assets/sprites/poe1_NotableFrameAllocated.png",
    iw: 98, fw: 152,
  },
  keystone: {
    f0: "/assets/sprites/poe1_KeystoneFrameUnallocated.png",
    f1: "/assets/sprites/poe1_KeystoneFrameAllocated.png",
    iw: 136, fw: 218,
  },
} as const;
const ORBIT_16_DEG = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330];
const CLUSTER_ID_BASE = 0x10000;

let clusterData: ClusterData | null = null;
let baseEdgesForSel: typeof TREE.edges_for_sel | null = null;
let baseEdgesMeta: typeof TREE.edges_meta | null = null;
const dynamicNodeIds = new Set<string>();
const requestedSprites = new Set<string>();
let lastSignature = "";

export function clusterSizeForItem(item: Item): "Small" | "Medium" | "Large" | null {
  if (item.cluster?.size) return item.cluster.size;
  const base = (item.base || item.name || "").replace(/^(?:Normal|Magic|Rare)\s+/i, "").trim().toLowerCase();
  return SIZE_BY_BASE[base] ?? null;
}

export function defaultClusterConfig(
  size: ClusterSize,
  data: ClusterData | null = clusterData,
): NonNullable<Item["cluster"]> | null {
  const template = data?.templates[size];
  const skill = data?.skills.find(s => s.size === size);
  if (!template || !skill) return null;
  return {
    size,
    skill: skill.id,
    nodeCount: template.min_nodes,
    sockets: clusterSocketCount(size),
  };
}

export function clusterSkillsForSize(size: string): ClusterSkill[] {
  return (clusterData?.skills ?? []).filter(s => s.size === size);
}

export function clusterTemplateForSize(size: string): ClusterTemplate | null {
  return clusterData?.templates[size] ?? null;
}

/** Remove the dormant proxy/nested-socket skeleton baked into GGG's
 * tree and retain immutable base edge lists for subsequent rebuilds. */
export function configureClusterJewels(data: ClusterData): void {
  if (clusterData) return;
  clusterData = data;
  const dormant = new Set<string>();
  for (const [id, slot] of Object.entries(data.slots)) {
    dormant.add(String(slot.proxy));
    if (slot.parent != null) dormant.add(String(id));
  }
  for (const id of dormant) delete TREE.nodes[id];
  baseEdgesForSel = TREE.edges_for_sel.filter(([a, b]) => !dormant.has(String(a)) && !dormant.has(String(b)));
  baseEdgesMeta = TREE.edges_meta.filter(m => !dormant.has(String(m[1])) && !dormant.has(String(m[2])));
  TREE.edges_for_sel = baseEdgesForSel.slice();
  TREE.edges_meta = baseEdgesMeta.slice();
  rebuildGraphIndexes();
  lastSignature = "";
}

function clampConfig(item: Item): NonNullable<Item["cluster"]> | null {
  if (!clusterData) return null;
  const size = clusterSizeForItem(item);
  if (!size) return null;
  const fallback = defaultClusterConfig(size);
  const template = clusterData.templates[size];
  if (!fallback || !template) return null;
  const raw = item.cluster?.size === size ? item.cluster : fallback;
  const skill = clusterData.skills.some(s => s.size === size && s.id === raw.skill)
    ? raw.skill : fallback.skill;
  return {
    size,
    skill,
    nodeCount: Math.max(template.min_nodes, Math.min(template.max_nodes, Math.round(raw.nodeCount))),
    // Current regular cluster jewels get child sockets from their
    // enchant. Normalise older planner saves that exposed this as a
    // free selector instead of carrying stale/illegal structures.
    sockets: clusterSocketCount(size),
  };
}

function familyFor(label: string, families: ClusterModFamily[]): ClusterModFamily | undefined {
  const key = label.toLowerCase();
  return families.find(f => (f.text || f.type).toLowerCase() === key);
}

function translateOrbitIndex(index: number, sourceCount: number, destCount: number): number {
  if (sourceCount === destCount) return index;
  if (sourceCount === 12 && destCount === 16) return [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15][index] ?? 0;
  if (sourceCount === 6 && destCount === 16) return [0, 3, 5, 8, 11, 13][index] ?? 0;
  return Math.floor(index * destCount / sourceCount);
}

function orbitAngle(index: number, count: number): number {
  if (count === 16) return (ORBIT_16_DEG[index] ?? 0) * Math.PI / 180;
  return 2 * Math.PI * index / count;
}

function nodePosition(slot: ClusterSlot, templateIndex: number, config: NonNullable<Item["cluster"]>): {
  x: number; y: number; orbit: number; orbitIndex: number;
} {
  const template = clusterData!.templates[config.size]!;
  const orbit = template.size_index + 1;
  const count = orbit === 1 ? 6 : 16;
  const start = slot.start_indices[template.size_index] ?? 0;
  const relative = (templateIndex + start) % template.total_indices;
  const orbitIndex = translateOrbitIndex(relative, template.total_indices, count);
  const angle = orbitAngle(orbitIndex, count);
  const radius = TREE.orbit_radii[orbit] ?? 0;
  return {
    x: slot.cx + radius * Math.sin(angle),
    y: slot.cy - radius * Math.cos(angle),
    orbit,
    orbitIndex,
  };
}

function passiveNode(
  id: string,
  slot: ClusterSlot,
  templateIndex: number,
  kind: "small" | "notable" | "keystone",
  name: string,
  stats: string,
  icon: string,
  config: NonNullable<Item["cluster"]>,
): TreeNode {
  const pos = nodePosition(slot, templateIndex, config);
  const frame = FRAME[kind];
  return {
    x: pos.x, y: pos.y, k: kind, n: name, s: stats, g: slot.group,
    i: icon, iw: frame.iw, f0: frame.f0, f1: frame.f1, fw: frame.fw,
  };
}

function socketNode(
  id: string,
  positionSlot: ClusterSlot,
  socketSize: "Small" | "Medium" | "Large",
  templateIndex: number,
  config: NonNullable<Item["cluster"]>,
): TreeNode {
  const pos = nodePosition(positionSlot, templateIndex, config);
  const size = socketSize;
  return {
    x: pos.x, y: pos.y, k: "jewel", n: `${size} Jewel Socket`, g: positionSlot.group,
    f0: CLUSTER_SOCKET_FRAME.unallocated,
    f1: CLUSTER_SOCKET_FRAME.allocated,
    iw: 0, fw: CLUSTER_SOCKET_FRAME.width,
  };
}

type DynamicEdge = { a: string; b: string; meta: (string | number)[] };

function lineMeta(a: string, b: string): (string | number)[] {
  const na = TREE.nodes[a]!, nb = TREE.nodes[b]!;
  const dx = nb.x - na.x, dy = nb.y - na.y;
  return ["l", a, b, (na.x + nb.x) / 2, (na.y + nb.y) / 2, Math.hypot(dx, dy), Math.atan2(dy, dx), ""];
}

function arcMeta(a: string, b: string, slot: ClusterSlot, orbit: number): (string | number)[] {
  const na = TREE.nodes[a]!, nb = TREE.nodes[b]!;
  const aa = Math.atan2(na.y - slot.cy, na.x - slot.cx);
  const ab = Math.atan2(nb.y - slot.cy, nb.x - slot.cx);
  let delta = ab - aa;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return ["a", a, b, slot.cx, slot.cy, aa + delta / 2, orbit, ""];
}

function addNode(id: string, node: TreeNode, nextIds: Set<string>, sprites: Set<string>): void {
  TREE.nodes[id] = node;
  nextIds.add(id);
  for (const url of [node.i, node.f0, node.f1, node.me]) if (url) sprites.add(url);
}

/** Materialise all active cluster subgraphs and nested jewels. Returns
 * the number of allocations removed because their generating jewel
 * disappeared or changed shape. */
export function syncClusterJewelTrees(items: Item[], families: ClusterModFamily[]): number {
  if (!clusterData || !baseEdgesForSel || !baseEdgesMeta) return 0;
  const effective = window.PoE2Plan?.data.effective("passives");
  const effectiveAlloc = effective instanceof Map ? effective : state.selected;
  const allocatedSockets = [...effectiveAlloc.keys()]
    .filter(id => clusterData!.slots[String(id)])
    .map(String)
    .sort();
  const clusterItems = items
    .filter(it => (it.slot ?? "") === "jewel" && clusterSizeForItem(it))
    .map(it => ({
      socket: it.socket ?? null,
      config: clampConfig(it),
      mods: (it.mods ?? []).slice().sort(),
      item: it,
    }))
    .sort((a, b) => (a.socket ?? 0) - (b.socket ?? 0));
  const signature = JSON.stringify({
    allocatedSockets,
    items: clusterItems.map(v => ({
      socket: v.socket,
      config: v.config,
      mods: v.mods.map(label => {
        const family = familyFor(label, families);
        return [label, family?.type ?? "", family?.stats ?? []];
      }),
    })),
  });
  if (signature === lastSignature) return 0;
  lastSignature = signature;

  for (const id of dynamicNodeIds) delete TREE.nodes[id];
  const previousDynamic = new Set(dynamicNodeIds);
  dynamicNodeIds.clear();
  TREE.edges_for_sel = baseEdgesForSel.slice();
  TREE.edges_meta = baseEdgesMeta.slice();

  const bySocket = new Map<number, Item>();
  for (const entry of clusterItems) {
    if (entry.socket != null && entry.config) bySocket.set(entry.socket, entry.item);
  }
  const nextIds = new Set<string>();
  const nextEdges: DynamicEdge[] = [];
  const spriteUrls = new Set<string>();

  const build = (item: Item, socketId: number, inheritedId = CLUSTER_ID_BASE): void => {
    const slot = clusterData!.slots[String(socketId)];
    const config = clampConfig(item);
    if (!slot || !config) return;
    const template = clusterData!.templates[config.size];
    if (!template || template.size_index > slot.size_index) return;

    let graphId = inheritedId;
    if (slot.size_index === 2) graphId += slot.cluster_index << 6;
    else if (slot.size_index === 1) graphId += slot.cluster_index << 9;
    const nodeBase = graphId + (template.size_index << 4);
    const skill = clusterData!.skills.find(s => s.id === config.skill && s.size === config.size)
      ?? clusterData!.skills.find(s => s.size === config.size);
    if (!skill) return;

    const selectedFamilies = (item.mods ?? [])
      .map(label => ({ label, family: familyFor(label, families) }))
      .filter((v): v is { label: string; family: ClusterModFamily } => !!v.family);
    const notableById = new Map<string, ClusterSpecial>();
    const addedSmall: string[] = [];
    for (const selected of selectedFamilies) {
      let structural = false;
      for (const stat of selected.family.stats ?? []) {
        const special = clusterData!.specials[stat];
        if (special) {
          notableById.set(String(special.node_id), special);
          structural = true;
        }
      }
      if (!structural) addedSmall.push(selected.label);
    }
    const notables = [...notableById.values()].sort((a, b) => a.order - b.order);
    const layout = clusterLayout(
      config.size,
      template,
      config.nodeCount,
      notables.length,
      config.sockets,
    );
    const at = new Map<number, string>();

    const makeSocket = (templateIndex: number, childIndex: number): void => {
      const child = Object.entries(clusterData!.slots).find(([, candidate]) =>
        candidate.parent === socketId && candidate.cluster_index === childIndex);
      if (!child) return;
      const [childId, childSlot] = child;
      addNode(childId, socketNode(childId, slot, childSlot.size, templateIndex, config), nextIds, spriteUrls);
      at.set(templateIndex, childId);
    };
    for (let i = 0; i < layout.socketIndices.length; i++) {
      makeSocket(layout.socketIndices[i]!, layout.socketChildIndices[i]!);
    }

    for (let i = 0; i < layout.notableIndices.length; i++) {
      const special = notables[i], index = layout.notableIndices[i];
      if (!special || index == null) continue;
      const id = String(nodeBase + index);
      addNode(id, passiveNode(id, slot, index, special.kind, special.name, special.stats, special.icon, config), nextIds, spriteUrls);
      at.set(index, id);
    }

    const smallStats = [skill.stats, ...addedSmall].filter(Boolean).join("; ");
    for (let i = 0; i < layout.smallIndices.length; i++) {
      const index = layout.smallIndices[i];
      if (index == null) continue;
      const id = String(nodeBase + index);
      addNode(id, passiveNode(id, slot, index, "small", skill.name, smallStats, skill.icon, config), nextIds, spriteUrls);
      at.set(index, id);
    }
    const entrance = at.get(0);
    if (!entrance) return;

    if (skill.mastery_icon) {
      const id = String(nodeBase + 12);
      addNode(id, {
        x: slot.cx, y: slot.cy, k: "mastery", n: "Cluster Mastery", g: slot.group,
        i: skill.mastery_icon, iw: 226, fw: 0,
      }, nextIds, spriteUrls);
    }

    let first: string | null = null;
    let last: string | null = null;
    for (let index = 0; index < template.total_indices; index++) {
      const current = at.get(index);
      if (!current) continue;
      if (!first) first = current;
      if (last) nextEdges.push({ a: last, b: current, meta: arcMeta(last, current, slot, template.size_index + 1) });
      last = current;
    }
    if (first && last && first !== last && config.size !== "Small") {
      nextEdges.push({ a: first, b: last, meta: arcMeta(first, last, slot, template.size_index + 1) });
    }
    nextEdges.push({ a: entrance, b: String(socketId), meta: lineMeta(entrance, String(socketId)) });

    for (const [index, childId] of at) {
      void index;
      const child = Number(childId);
      const nested = bySocket.get(child);
      if (nested && effectiveAlloc.has(String(child))) build(nested, child, graphId);
    }
  };

  for (const [id, slot] of Object.entries(clusterData.slots)) {
    if (slot.parent != null || !effectiveAlloc.has(id)) continue;
    const item = bySocket.get(Number(id));
    if (item) build(item, Number(id));
  }

  for (const edge of nextEdges) {
    TREE.edges_for_sel.push([edge.a, edge.b]);
    TREE.edges_meta.push(edge.meta);
  }
  for (const id of nextIds) dynamicNodeIds.add(id);
  rebuildGraphIndexes();

  const fresh = [...spriteUrls].filter(url => !requestedSprites.has(url));
  for (const url of fresh) requestedSprites.add(url);
  if (fresh.length) void streamSprites(fresh);
  if (state.geomReady) {
    buildStaticGeometry();
    requestRender();
  }

  const removedIds = [...previousDynamic].filter(id => !nextIds.has(id) && effectiveAlloc.has(id));
  hydrateFromActiveCapture();
  const removed = removedIds.length;
  if (removed) flushPersistNow();
  return removed;
}
