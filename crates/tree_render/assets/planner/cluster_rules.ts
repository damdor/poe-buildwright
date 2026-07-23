// Pure PoE1 cluster-jewel rules. These mirror Path of Building's
// BuildClusterJewelSubgraph passes, but consume only GGG-derived
// templates. Keeping the placement policy DOM-free makes it possible
// to lock the Small/Medium/Large special cases down with unit tests.

export type ClusterSize = "Small" | "Medium" | "Large";

export interface ClusterLayoutTemplate {
  small_indices: number[];
  notable_indices: number[];
  socket_indices: number[];
}

export interface ClusterLayout {
  socketIndices: number[];
  socketChildIndices: number[];
  notableIndices: number[];
  smallIndices: number[];
}

/** Current regular cluster-jewel enchants always provide this many
 * child sockets. This is structural item data, not a rollable affix. */
export function clusterSocketCount(size: ClusterSize): number {
  return size === "Large" ? 2 : size === "Medium" ? 1 : 0;
}

/** Expansion sockets use the alternate socket frame regardless of the
 * size of the cluster jewel that generated them. The socketed jewel
 * overlay supplies the Large/Medium/Small colour separately. */
export const CLUSTER_SOCKET_FRAME = {
  unallocated: "/assets/sprites/poe1_JewelSocketAltNormal.png",
  allocated: "/assets/sprites/poe1_JewelSocketAltActive.png",
  width: 200,
} as const;

/** Select the exact template indices occupied by sockets, notables and
 * repeated small passives. Ordering is significant: callers must pass
 * notables already sorted by GGG Stats row, the same key PoB uses. */
export function clusterLayout(
  size: ClusterSize,
  template: ClusterLayoutTemplate,
  nodeCount: number,
  requestedNotables: number,
  requestedSockets = clusterSocketCount(size),
): ClusterLayout {
  const maxSockets = clusterSocketCount(size);
  const socketCount = Math.max(
    0,
    Math.min(requestedSockets, maxSockets, template.socket_indices.length),
  );
  const notableCount = Math.max(
    0,
    Math.min(
      requestedNotables,
      template.notable_indices.length,
      nodeCount - socketCount,
    ),
  );
  const smallCount = Math.max(0, nodeCount - socketCount - notableCount);
  const occupied = new Set<number>();
  const socketIndices: number[] = [];
  const socketChildIndices: number[] = [];

  if (size === "Large" && socketCount === 1) {
    socketIndices.push(6);
    socketChildIndices.push(1);
    occupied.add(6);
  } else {
    const childOrder = [0, 2, 1];
    for (let i = 0; i < socketCount; i++) {
      const index = template.socket_indices[i];
      if (index == null) break;
      socketIndices.push(index);
      socketChildIndices.push(childOrder[i]!);
      occupied.add(index);
    }
  }

  const notableIndices: number[] = [];
  for (let index of template.notable_indices) {
    if (notableIndices.length === notableCount) break;
    if (size === "Medium") {
      if (socketCount === 0 && notableCount === 2) {
        if (index === 6) index = 4;
        else if (index === 10) index = 8;
      } else if (nodeCount === 4) {
        if (index === 10) index = 9;
        else if (index === 2) index = 3;
      }
    }
    if (!occupied.has(index)) notableIndices.push(index);
  }
  notableIndices.sort((a, b) => a - b);
  for (const index of notableIndices) occupied.add(index);

  const smallIndices: number[] = [];
  for (let index of template.small_indices) {
    if (smallIndices.length === smallCount) break;
    if (size === "Medium") {
      if (nodeCount === 5 && index === 4) index = 3;
      else if (nodeCount === 4) {
        if (index === 8) index = 9;
        else if (index === 4) index = 3;
      }
    }
    if (!occupied.has(index)) {
      smallIndices.push(index);
      occupied.add(index);
    }
  }

  return { socketIndices, socketChildIndices, notableIndices, smallIndices };
}
