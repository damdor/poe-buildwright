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
    "/assets/skill_catalogue.json",
    "/assets/item_catalogue.json",
  ],
  // Directory listings don't exist on this host — the manifest IS the
  // examples index (ids, tags, points, direct urls).
  examples_index: "/assets/agent/examples/index.json",
  openapi: "/assets/agent/openapi.json",
  human_page: "/agents.html",
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

// ---- crawler files ---------------------------------------------------------
// robots.txt always; sitemap.xml only when the deploy knows its
// public origin (the sitemap spec requires absolute URLs).
const origin = (process.env.POE2_SITE_ORIGIN ?? "").replace(/\/+$/, "");
const pages = [
  "/", "/planner.html", "/share.html", "/agents.html", "/llms.txt",
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
