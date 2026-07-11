// First-party spirit data that the normal bake pipeline cannot currently
// deliver end-to-end: GGG upgraded their Oodle compressor at patch
// 4.5.4.3 and the vendored ooz decoder silently mis-decodes some 128K
// quanta (dense byte corruption inside affected regions, perfect output
// elsewhere). SkillGems/BaseItemTypes don't decode at all at that patch,
// so instead of rebaking skill_stats.json wholesale, this script pulls
// ONLY the spirit-economy values out of the mined TSVs and VALIDATES
// each one before it may ship:
//
//   support_cost_multipliers — a support gem's CostMultiplier ladder is
//     accepted only if it is CONSTANT across every gem level and within
//     [50, 400]. Corrupt quanta produce wild or inconsistent values and
//     are dropped (at 4.5.4.3: 569 of 574 ladders pass, 189 non-100).
//   granted_skill_sockets — GrantedSkillSocketNumbers, accepted only if
//     sockets increase monotonically with level.
//   base_spirit_by_class — ItemSpirit; accepted only if every row
//     carries the same value AND the row count equals the number of
//     sceptre bases in the baked bases.json (the join table
//     BaseItemTypes is undecodable, so the attribution is corroborated
//     by count).
//
// Usage: node scripts/extract_spirit_extras.mjs <patch>   (e.g. 4.5.4.3)
// Writes: data/curated/spirit_extras.json  (committed; read by
//         scripts/gen_agent_meta.mjs as fallback when the baked
//         skill_stats.json predates these fields)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const patch = process.argv[2];
if (!patch) {
  console.error("usage: node scripts/extract_spirit_extras.mjs <patch>");
  process.exit(1);
}
const dat = `data/parsed/${patch}_native/dat`;

function tsv(path) {
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const hdr = lines[0].split("\t");
  return lines.slice(1).map(l => {
    const cells = l.split("\t");
    return Object.fromEntries(hdr.map((h, i) => [h, cells[i] ?? ""]));
  });
}

// ---- support cost multipliers ----------------------------------------------
const cat = JSON.parse(readFileSync("viewer/assets/skill_catalogue.json", "utf-8"));
const supportByEffect = new Map(
  (cat.gems ?? [])
    .filter(g => g.gem_type === "Support" && g.granted_effect_id)
    .map(g => [g.granted_effect_id, g.name]),
);
const ladders = new Map(); // effect -> Map(level -> multiplier)
for (const r of tsv(`${dat}/GrantedEffectsPerLevel.tsv`)) {
  if (!supportByEffect.has(r.GrantedEffect)) continue;
  const lvl = Number(r.Level), m = Number(r.CostMultiplier);
  if (!Number.isInteger(lvl) || !Number.isInteger(m)) continue;
  if (!ladders.has(r.GrantedEffect)) ladders.set(r.GrantedEffect, new Map());
  ladders.get(r.GrantedEffect).set(lvl, m);
}
const multipliers = {};
let dropped = 0;
for (const [eff, lm] of ladders) {
  const vals = new Set(lm.values());
  const constant = vals.size === 1;
  const v = [...vals][0];
  if (constant && v >= 50 && v <= 400) {
    if (v !== 100) multipliers[supportByEffect.get(eff)] = { 1: v };
  } else {
    dropped++;
    console.error(`  dropped ${supportByEffect.get(eff)}: ladder ${[...vals].join(",")}`);
  }
}

// ---- granted-skill sockets --------------------------------------------------
const sockets = {};
for (const r of tsv(`${dat}/GrantedSkillSocketNumbers.tsv`)) {
  const lvl = Number(r.Level), s = Number(r.Sockets);
  if (Number.isInteger(lvl) && Number.isInteger(s)) sockets[lvl] = s;
}
{
  const lvls = Object.keys(sockets).map(Number).sort((a, b) => a - b);
  const mono = lvls.every((l, i) => i === 0 || sockets[l] > sockets[lvls[i - 1]]);
  if (!lvls.length || !mono) {
    console.error("granted_skill_sockets failed validation — refusing to write");
    process.exit(1);
  }
}

// ---- base spirit by slot ----------------------------------------------------
const spiritRows = tsv(`${dat}/ItemSpirit.tsv`).map(r => Number(r.SpiritGranted));
const bases = JSON.parse(readFileSync("viewer/assets/agent/bases.json", "utf-8"));
const sceptres = (bases.bases ?? []).filter(b => b.class === "Sceptre");
const uniform = new Set(spiritRows).size === 1;
const base_spirit_by_class = {};
if (uniform && spiritRows.length === sceptres.length && spiritRows.length > 0) {
  base_spirit_by_class.Sceptre = spiritRows[0];
} else {
  console.error(
    `ItemSpirit not corroborated (rows ${spiritRows.length}, sceptre bases ${sceptres.length}, uniform ${uniform}) — omitting base_spirit_by_class`,
  );
}

mkdirSync("data/curated", { recursive: true });
writeFileSync("data/curated/spirit_extras.json", JSON.stringify({
  format: "poe2-spirit-extras",
  version: 1,
  patch,
  method: "mined first-party from GGG CDN tables; per-value validated (see scripts/extract_spirit_extras.mjs)",
  support_cost_multipliers: Object.fromEntries(Object.entries(multipliers).sort()),
  granted_skill_sockets: sockets,
  base_spirit_by_class,
}, null, 1));
console.log(
  `spirit extras: ${Object.keys(multipliers).length} support multipliers (${dropped} dropped), sockets ${JSON.stringify(sockets)}, base spirit ${JSON.stringify(base_spirit_by_class)}`,
);
