// Deploy-time generator for the agent metadata + crawler files:
//
//   viewer/assets/agent/capabilities.json   — feature discovery, so
//     agents don't have to probe endpoints to learn what works here
//   viewer/assets/agent/support_compat.json — precomputed active-gem →
//     compatible-support lists, so agents don't re-derive the RPN
//     type algebra (and burn tokens) for every pairing
//   viewer/robots.txt + viewer/sitemap.xml  — generated (not
//     committed) because they need ABSOLUTE urls: the repo stays
//     domain-neutral and every fork gets correct SEO for its own
//     domain by setting POE2_SITE_ORIGIN in .cloudflare.env.
//
// Run by scripts/deploy.sh before upload (node, no dependencies).
// Compatibility semantics MUST mirror functions/agent/_lib.ts
// evalTypeExpr: unknown active types (empty skill_types) = allowed.

import { readFileSync, writeFileSync } from "node:fs";

const cat = JSON.parse(readFileSync("viewer/assets/skill_catalogue.json", "utf-8"));
let patch = "(unknown)";
try {
  const meta = JSON.parse(readFileSync("viewer/assets/build_meta.json", "utf-8"));
  patch = meta.patch ?? patch;
} catch { /* keep unknown */ }

const gems = cat.gems ?? [];
const supports = gems.filter(g => g.gem_type === "Support");
const actives = gems.filter(g => g.gem_type !== "Support");

function evalTypeExpr(expr, types) {
  if (!expr || expr.length === 0) return false;
  const st = [];
  for (const t of expr) {
    if (t === "AND") { const b = st.pop() ?? true; const a = st.pop() ?? true; st.push(a && b); }
    else if (t === "OR") { const b = st.pop() ?? false; const a = st.pop() ?? false; st.push(a || b); }
    else if (t === "NOT") { st.push(!(st.pop() ?? false)); }
    else st.push(types.has(t));
  }
  return st.some(Boolean);
}

const compat = {};
for (const a of actives) {
  const types = new Set(a.skill_types ?? []);
  const ok = [];
  for (const s of supports) {
    if (types.size === 0) { ok.push(s.name); continue; } // compat unknown → allowed
    const req = s.require_skill_types;
    const bad = (req && req.length > 0 && !evalTypeExpr(req, types)) || evalTypeExpr(s.exclude_skill_types, types);
    if (!bad) ok.push(s.name);
  }
  compat[a.name] = ok.sort();
}

writeFileSync("viewer/assets/agent/support_compat.json", JSON.stringify({
  format: "poe2-agent-support-compat",
  version: 1,
  patch,
  note: "active gem name -> support gem names that pass the same type algebra /agent/validate uses; actives with unknown types list every support",
  actives: compat,
}));

writeFileSync("viewer/assets/agent/capabilities.json", JSON.stringify({
  format: "poe2-agent-capabilities",
  agent_schema_version: 1,
  patch,
  validate: true,        // GET/POST /agent/validate — always JSON
  agent_build: true,     // POST /agent/build — plan in, share_url out
  live: true,            // /live/<token> channel functions
  share_encode: true,    // /share.html#code= (or use /agent/build)
  grounding: [
    "/assets/agent/nodes.json",
    "/assets/agent/graph.json",
    "/assets/agent/bases.json",
    "/assets/agent/mods.json",
    "/assets/agent/support_compat.json",
    "/assets/agent/spirit.json",
    "/assets/agent/granted_skills.json",
    "/assets/skill_catalogue.json",
    "/assets/item_catalogue.json",
  ],
  // Directory listings don't exist on this host — the manifest IS the
  // examples index (ids, tags, points, direct urls).
  examples_index: "/assets/agent/examples/index.json",
  openapi: "/assets/agent/openapi.json",
  human_page: "/agents.html",
  source: "https://github.com/damdor/poe-buildwright",
  license: {
    code: "PolyForm-Noncommercial-1.0.0",
    url: "https://polyformproject.org/licenses/noncommercial/1.0.0",
    note: "Site code + original content: free for noncommercial use; Grinding Gear Games may use anything, any purpose. The GAME DATA these endpoints serve (nodes, gems, bases, art) is (c) Grinding Gear Games and is NOT covered by this license.",
  },
  // gear[].slot vocabulary: bases.json slot values are canonical
  // singles ("ring1"); the plan schema accepts every alias here.
  slots: {
    weapon1: ["weapon1", "bow", "crossbow", "staff", "wand", "sceptre", "mace", "spear", "flail", "axe", "sword", "dagger", "claw"],
    offhand1: ["offhand1", "shield", "focus", "quiver", "buckler"],
    weapon2: ["weapon2"],
    offhand2: ["offhand2"],
    helmet: ["helmet"],
    body: ["body"],
    gloves: ["gloves"],
    boots: ["boots"],
    amulet: ["amulet"],
    ring1: ["ring1", "ring"],
    ring2: ["ring2"],
    belt: ["belt"],
    flask: ["flask"],
    jewel: ["jewel"],
  },
}, null, 1));

// ---- spirit + granted-skills grounding --------------------------------------
// agent/spirit.json: the spirit economy in one small file — the base
// quest schedule plus per-gem reservation ladders (extracted from the
// 824 KB skill_stats.json down to ~18 KB so the validator can afford
// to read it per request, and agents don't have to dig).
//
// Base spirit: +30 (Act 1, King in the Mists), +30 (Act 3, Ignagduk),
// +40 (post-Act-4 interlude, Lythara) = 100. Level mapping is
// DELIBERATELY CONSERVATIVE (latest plausible level for each boss) so
// leveling captures never overpromise spirit the player might not
// have yet. Gear (+Spirit mods, sceptres) extends the pool beyond
// this — the validator warns rather than errors for that reason.
const stats = JSON.parse(readFileSync("viewer/assets/skill_stats.json", "utf-8"));
const SPIRIT_REWARDS = [
  { lvl: 18, pts: 30, source: "Act 1: King in the Mists" },
  { lvl: 36, pts: 30, source: "Act 3: Ignagduk, the Bog Witch" },
  { lvl: 50, pts: 40, source: "Interlude: Lythara, the Wayward Spear" },
];
const reservations = {};
const supportMultipliers = {};
for (const g of gems) {
  const eff = stats.effects?.[g.granted_effect_id];
  if (eff && eff.reservation) reservations[g.name] = eff.reservation;
  if (eff && eff.cost_multiplier && g.gem_type === "Support") {
    supportMultipliers[g.name] = eff.cost_multiplier;
  }
}
const grantedSkillSockets = stats.granted_skill_sockets ?? {};
writeFileSync("viewer/assets/agent/spirit.json", JSON.stringify({
  format: "poe2-agent-spirit",
  version: 2,
  patch,
  note: "Base spirit is quest-earned (conservative level estimates). reservations = gem name -> {gem level: spirit cost}. EACH SUPPORT multiplies its skill's reservation: effective = base * product(support_cost_multipliers[support][level] / 100). granted_skill_sockets = free support sockets on item-granted skills by granted level. Gear can extend the base pool.",
  base_schedule: SPIRIT_REWARDS,
  base_total: 100,
  reservations,
  support_cost_multipliers: supportMultipliers,
  granted_skill_sockets: grantedSkillSockets,
}));

// agent/granted_skills.json: uniques whose stats grant a skill while
// equipped — the skill is available to the build for free (no gem
// slot), and supports can be socketed into it in-game.
const itemCat = JSON.parse(readFileSync("viewer/assets/item_catalogue.json", "utf-8"));
// Two grant phrasings in GGG stat text as of 4.5.4.3:
//   "Grants Skill: Level (1-20) Purity of Fire"   (always-available)
//   "Trigger Lightning Bolt Skill on Critical Hit" (condition-fired —
//    still item-granted: no gem slot, supports socket into it)
const grantPat = /Grants? Skill: (?:Level \(?[\d\-]+\)? )?([A-Z][A-Za-z '\-]+?)(?= ·|$)/g;
const triggerPat = /Trigger ([A-Z][A-Za-z '\-]+?) Skill (?=on|when)/g;
const grantedByUnique = {};
for (const u of itemCat.uniques ?? []) {
  const s = u.latest_stats || "";
  const skills = [
    ...[...s.matchAll(grantPat)].map(m => m[1].trim()),
    ...[...s.matchAll(triggerPat)].map(m => m[1].trim()),
  ];
  const spiritM = s.match(/\+\(?([\d\-]+)\)? to Spirit/);
  if (skills.length || spiritM) {
    grantedByUnique[u.name] = {
      slot: u.slot,
      ...(skills.length ? { grants: skills } : {}),
      ...(spiritM ? { spirit_bonus: spiritM[1] } : {}),
    };
  }
}
// Base-item grants (mined ItemSpirit + ItemInherentSkills, merged
// into bases.json by the pipeline): sceptres/wands/staves granting
// their skill, sceptres granting spirit.
const basesData = JSON.parse(readFileSync("viewer/assets/agent/bases.json", "utf-8"));
const grantedByBase = {};
for (const b of basesData.bases ?? []) {
  if (b.grants?.length || b.spirit) {
    grantedByBase[b.name] = {
      slot: b.slot,
      ...(b.grants?.length ? { grants: b.grants } : {}),
      ...(b.spirit ? { spirit: b.spirit } : {}),
    };
  }
}
// A unique IS its base: it grants the base's inherent skill and base
// Spirit too (an Alkem Eira is a shield → Raise Shield; a unique
// sceptre still carries the sceptre's 100 Spirit). Fold each unique's
// base grants into its own entry so agents that only know the unique
// name see the full picture; `spirit_base` is the exact base amount
// (distinct from `spirit_bonus`, a rolled "+(x-y) to Spirit" range).
const baseByName = new Map((basesData.bases ?? []).map(b => [b.name, b]));
for (const u of itemCat.uniques ?? []) {
  const b = u.base ? baseByName.get(u.base) : undefined;
  if (!b || (!b.grants?.length && !b.spirit)) continue;
  const e = grantedByUnique[u.name] ?? (grantedByUnique[u.name] = { slot: u.slot });
  if (b.grants?.length) {
    e.grants = [...new Set([...(e.grants ?? []), ...b.grants])];
  }
  if (b.spirit) e.spirit_base = b.spirit;
}
writeFileSync("viewer/assets/agent/granted_skills.json", JSON.stringify({
  format: "poe2-agent-granted-skills",
  version: 2,
  patch,
  note: "Equipping these grants the listed skills for free (no gem slot; supports attach in-game — see spirit.json granted_skill_sockets for how many) and/or Spirit. `uniques` keys are unique item names (their base's inherent grants and exact base Spirit are folded in as `grants`/`spirit_base`); `bases` keys are base-item names (sceptres, wands, staves, shields, spears…).",
  uniques: grantedByUnique,
  bases: grantedByBase,
}));
// ---- jewels: unique-jewel radii -------------------------------------------
// jewels.json is written by tree_render (sockets/rings/bases, all
// first-party); the UNIQUE jewels' radii derive from the catalogue
// text + the mined radius stats, so this deploy step folds them in:
//   - Timeless Jewel uniques: every mined UniqueJewelAlternateTreeInRadius*
//     mod carries local_jewel_effect_base_radius = 1500
//   - "… in <Name> Ring" stat text names a PassiveJewelRadii ring
//     (annulus): Controlled Metamorphosis variants
try {
  const jewelsPath = "viewer/assets/agent/jewels.json";
  const jw = JSON.parse(readFileSync(jewelsPath, "utf-8"));
  const uniques = {};
  for (const u of itemCat.uniques ?? []) {
    if (u.slot !== "jewel") continue;
    const text = u.latest_stats || "";
    const ringM = /in (\w[\w]*) Ring/.exec(text);
    if (ringM && jw.rings[ringM[1]]) uniques[u.name] = { ring: ringM[1] };
    else if (u.base === "Timeless Jewel") uniques[u.name] = { radius: 1500 };
  }
  jw.uniques = uniques;
  writeFileSync(jewelsPath, JSON.stringify(jw));
  console.log(`jewels: ${jw.sockets.length} sockets, ${Object.keys(uniques).length} unique radii folded in`);
} catch { console.log("jewels.json absent — skipped unique radii"); }

console.log(`spirit: ${Object.keys(reservations).length} reservation ladders; granted skills/spirit: ${Object.keys(grantedByUnique).length} uniques`);

// ---- crawler files ---------------------------------------------------------
// robots.txt always; sitemap.xml only when the deploy knows its
// public origin (the sitemap spec requires absolute URLs).
const origin = (process.env.POE2_SITE_ORIGIN ?? "").replace(/\/+$/, "");
const pages = [
  "/", "/planner", "/share", "/agents", "/llms.txt",
  "/assets/agent/capabilities.json", "/assets/agent/openapi.json",
  "/assets/agent/examples/index.json",
];
let robots = "User-agent: *\nAllow: /\n";
if (origin) {
  robots += "\nSitemap: " + origin + "/sitemap.xml\n";
  const now = new Date().toISOString().slice(0, 10);
  writeFileSync("viewer/sitemap.xml",
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    pages.map(p => "  <url><loc>" + origin + p + "</loc><lastmod>" + now + "</lastmod></url>").join("\n") +
    "\n</urlset>\n");
} else {
  console.log("POE2_SITE_ORIGIN unset — robots.txt written without a Sitemap line, sitemap.xml skipped");
}
writeFileSync("viewer/robots.txt", robots);

console.log(`agent meta: ${Object.keys(compat).length} actives x ${supports.length} supports -> support_compat.json + capabilities.json (patch ${patch})` + (origin ? `; robots.txt + sitemap.xml for ${origin}` : ""));
