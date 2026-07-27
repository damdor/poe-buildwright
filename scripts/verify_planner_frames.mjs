#!/usr/bin/env node
// Deployment guard for generated planner artifacts. tree_render validates the
// source sprite manifest before a new bake; this script independently checks
// the already-rendered HTML and every referenced frame PNG so deploy.sh cannot
// publish an old or externally generated frameless tree.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) files.push("viewer/planner.html", "viewer/planner-poe1.html");

const START = "<script>const TREE = ";
const END_MARKERS = [
  ";window.BuildwrightGame",
  ";window.PoE2Game",
];
let failed = false;

for (const file of files) {
  const html = readFileSync(file, "utf8");
  const start = html.indexOf(START);
  const payloadStart = start + START.length;
  const end = start < 0
    ? -1
    : END_MARKERS
      .map((marker) => html.indexOf(marker, payloadStart))
      .filter((index) => index >= 0)
      .reduce((first, index) => first < 0 || index < first ? index : first, -1);
  if (start < 0 || end < 0) {
    console.error(`FAIL: ${file} has no embedded TREE payload`);
    failed = true;
    continue;
  }

  const tree = JSON.parse(html.slice(payloadStart, end));
  const nodes = Object.values(tree.nodes ?? {});
  for (const [label, group] of [
    ["main", nodes.filter((node) => !node.a)],
    ["ascendancy", nodes.filter((node) => Boolean(node.a))],
  ]) {
    const framed = group.filter((node) => Number(node.fw) > 0);
    const complete = framed.filter((node) => node.f0 && node.f1);
    const percent = framed.length === 0 ? 100 : complete.length * 100 / framed.length;
    console.log(`  ${file} ${label}: ${complete.length}/${framed.length} nodes (${percent.toFixed(1)}%)`);
    if (framed.length >= 10 && percent < 95) {
      console.error(`FAIL: ${file} ${label} node-frame coverage is below 95%`);
      failed = true;
    }
  }

  const missingFiles = new Set();
  for (const node of nodes) {
    for (const url of [node.f0, node.f1]) {
      if (typeof url !== "string" || !url.startsWith("/assets/")) continue;
      const local = join(dirname(file), url.slice(1));
      if (!existsSync(local)) missingFiles.add(url);
    }
  }
  if (missingFiles.size > 0) {
    console.error(`FAIL: ${file} references ${missingFiles.size} missing frame PNG(s)`);
    for (const url of [...missingFiles].slice(0, 8)) console.error(`  ${url}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("Planner frame coverage verified.");
