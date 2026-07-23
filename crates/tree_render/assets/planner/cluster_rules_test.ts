/// <reference lib="deno.ns" />

import {
  CLUSTER_SOCKET_FRAME, clusterLayout, clusterSocketCount,
} from "./cluster_rules.ts";

const LARGE = {
  small_indices: [0, 4, 6, 8, 10, 2, 7, 5, 9, 3, 11, 1],
  notable_indices: [6, 4, 8, 10, 2],
  socket_indices: [4, 8, 6],
};
const MEDIUM = {
  small_indices: [0, 6, 8, 4, 10, 2],
  notable_indices: [6, 10, 2, 0],
  socket_indices: [6],
};
const SMALL = {
  small_indices: [0, 4, 2],
  notable_indices: [4],
  socket_indices: [4],
};

function equal(got: unknown, want: unknown, label: string): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
}

Deno.test("regular cluster-jewel enchants own their socket counts", () => {
  equal(
    ["Small", "Medium", "Large"].map(size =>
      clusterSocketCount(size as "Small" | "Medium" | "Large")
    ),
    [0, 1, 2],
    "socket counts",
  );
});

Deno.test("large cluster placement matches PoB's three-pass layout", () => {
  const layout = clusterLayout("Large", LARGE, 8, 3);
  equal(layout.socketIndices, [4, 8], "large sockets");
  equal(layout.socketChildIndices, [0, 2], "large child sockets");
  equal(layout.notableIndices, [2, 6, 10], "large notables");
  equal(layout.smallIndices, [0, 7, 5], "large small passives");
});

Deno.test("legacy one-socket Large clusters use PoB's centred child socket", () => {
  const layout = clusterLayout("Large", LARGE, 8, 2, 1);
  equal(layout.socketIndices, [6], "centred socket");
  equal(layout.socketChildIndices, [1], "centred child socket");
});

Deno.test("medium four-passive placement applies PoB's shifted indices", () => {
  const layout = clusterLayout("Medium", MEDIUM, 4, 2);
  equal(layout.socketIndices, [6], "medium socket");
  equal(layout.notableIndices, [3, 9], "medium notables");
  equal(layout.smallIndices, [0], "medium small passive");
});

Deno.test("small cluster placement remains an open two-node path", () => {
  const layout = clusterLayout("Small", SMALL, 2, 1);
  equal(layout.socketIndices, [], "small sockets");
  equal(layout.notableIndices, [4], "small notable");
  equal(layout.smallIndices, [0], "small passive");
});

Deno.test("generated sockets use PoB's alternate socket frames", () => {
  if (!CLUSTER_SOCKET_FRAME.unallocated.endsWith("JewelSocketAltNormal.png") ||
      !CLUSTER_SOCKET_FRAME.allocated.endsWith("JewelSocketAltActive.png") ||
      CLUSTER_SOCKET_FRAME.unallocated.includes("ClusterAlt")) {
    throw new Error("generated jewel sockets regressed to cluster placeholder art");
  }
});
