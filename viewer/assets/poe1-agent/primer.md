# PoE1 (3.26) tree primer for agents

This deployment also plans the ORIGINAL Path of Exile's passive tree at
`/planner-poe1.html`. It is tree-only: class + ascendancy + a passive
route. No gems, gear, jewel socketing, or mastery-effect picking here
(those are PoE2-planner features). The `#agent=` URL contract is the
same one documented in /llms.txt — hand the user
`/planner-poe1.html#agent=<base64url poe2-agent-plan JSON>` with
`class`, `ascendancy`, and `targets` by name; the importer pathfinds.
Ground every name in /assets/poe1-agent/nodes.json — PoE1 reuses node
ids with PoE2, so never mix grounding files across games.

## Point budgets

- Passive points: 123 maximum (levels + quest rewards). Real endgame
  characters on poe.ninja run 100-125 allocated; a leveling target is
  40-80. nodes.json `cost` values budget exactly like PoE2's.
- Ascendancy points: 8, from labyrinth trials — the start node plus
  roughly 4 notables. "Pick one" notables (Ascendant's class picks,
  Assassin's Assassination Style, Reliquarian's displays…) are a
  single target: name the PARENT; its option is chosen in the planner
  popout and costs nothing extra.
- No weapon-set points and no spirit — those are PoE2 systems.

## What differs from PoE2 (the part that ruins naive builds)

- **% maximum Life on the tree is the PoE1 backbone.** PoE2's tree has
  almost none; PoE1's tree is full of "+% increased maximum Life"
  small nodes and wheels, and builds are expected to take them.
  Measured from 20 level-100 poe.ninja Mirage-league meta characters:
  median ~100% increased life from tree alone; armour/regen
  archetypes (RF Chieftain, Juggernaut) 115-160%; evasion-side ranged
  (Deadeye, Pathfinder) 50-100% and compensate with other layers. If
  you're life-based and below ~80% at endgame point counts, the build
  is squishy — say so or fix it.
- **Spell suppression is PoE1-only.** Dex-side nodes; at the 100%
  chance cap suppressed spell hits deal half damage. It is the
  standard evasion-archetype answer to spells (PoE2 has no such
  layer, and PoE1 has no PoE2-style honour/spirit systems).
- **Defence layers by tree region:** strength side = % life, armour,
  endurance charges, Unwavering Stance; dex side = evasion, spell
  suppression, Acrobatics/Ghost Dance-style recovery; int side =
  energy shield, CI/low-life archetypes; shield wheels = block.
  Recovery (regen or leech) is its own required layer everywhere.
- **Resistances are a gear job, not a tree job.** Cap is 75%
  elemental; meta trees carry almost no resistance nodes. Don't spend
  tree points fixing resists in a plan.
- **Keystones define archetypes** (Chaos Inoculation, Mind over
  Matter, Eldritch Battery, Resolute Technique, Elemental Overload,
  Acrobatics, Point Blank…). They're regular `targets` — but each
  reshapes the build; never take one incidentally.
- Masteries and jewel sockets exist on the tree and render here, but
  this planner doesn't pick mastery effects or socket jewels — don't
  plan around them.

## Tree geography

Seven classes sit on one wheel — Scion at the centre, the other six
around the rim. Each has 3 ascendancies except Scion (Ascendant +
Reliquarian). Class starts sit far apart: cross-tree targets are
expensive, exactly like PoE2 — use `cost` per class and the `near`
lists to cluster.

## Grounding + worked examples

- /assets/poe1-agent/nodes.json — classes, ascendancies, every
  targetable node with per-class cost and near-lists (same shape as
  the PoE2 file).
- /assets/poe1-agent/graph.json — adjacency, if you want to reason
  about routes yourself.
- /assets/poe1-agent/examples/index.json — two known-good plans
  modeled on popular poe.ninja Mirage-league builds, validated against
  this 3.26 tree: an RF Chieftain (armour/regen archetype) and a
  Kinetic Blast Deadeye (evasion archetype). Imitate their shape.
- There is no server-side /agent/validate for PoE1 yet — the `#agent=`
  import is forgiving: unknown names are skipped and reported in-page.
