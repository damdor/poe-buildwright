# PoE2 build-making primer for agents

You may be new to Path of Exile 2. This is the minimum game knowledge
needed to author a COHERENT build here, beyond what the data files give
you. Everything below is stable game design, not patch numbers.

## What a build is

A build = class + ascendancy + a passive-tree route + skill gems with
supports + gear direction. Coherence comes from ONE primary damage
skill, ONE main damage type/theme, and defences appropriate to the
class's side of the tree.

## Point budgets

- Passive points: ~99 at endgame (level ≈ points+1). A leveling guide
  targets 40-70; use nodes.json `cost` values to stay in budget.
- Ascendancy points: 8 total (earned in 2-point chunks from trials).
  That's 3-4 asc_notables — pick the 2 that define the archetype first.
- Weapon-set points: up to 24 bonus passive points that only apply
  while a specific weapon set (1 or 2) is active. They are NOT all
  available from level 1 — they are earned gradually from quest rewards
  as the character levels toward 100, so a low-level capture has few or
  none. Some ascendancy nodes also change this economy — Witch Hunter's
  Weapon Master reads "100 Passive Skill Points become Weapon Set Skill
  Points": it raises the weapon-set point cap by 100, meaning
  effectively ALL of your regular passive points can also be mirrored
  into per-set allocations. A target may be tagged
  {"node": ..., "set": "set1"|"set2"} to allocate it in one set only,
  and a skill may be bound with {"gem": ..., "set": "set1"|"set2"}.

  THE DECISION RULE — use weapon-set points when the build has two
  MODES; skip them when it has one. The test: would any node be dead
  weight half the time? Then it belongs to a set. Worked patterns:
  - Slow heavy weapon in one set (scale raw damage — speed is wasted
    on it), fast weapon in the other (scale attack/cast speed).
  - Clear mode vs boss mode: projectile/chain notables in set1 for
    mapping, single-target/mark notables in set2 for bosses.
  - Attack set vs defence set: damage notables swap out for
    block/shield notables while "Raise Shield"-style skills are up.
  The craft: bind each mode's SKILL to its set, tag that mode's
  notables the same set, and keep set-tagged nodes ADJACENT to paths
  you already walk (travel still costs main points — the set point
  only pays for the destination). Each set point is nearly free
  power for its mode: a two-mode build that ignores them leaves up
  to 24 points on the table. Validate reports per-capture
  weapon_set_points {set1, set2, used, cap} so leveling captures
  can't overspend points not yet earned.

## The tree's geography (matters for cost)

Damage/attack nodes cluster by theme near the classes that use them:
melee/armour south-west (Warrior), bow/evasion east (Ranger/Huntress),
spell/minion/ES north (Witch/Sorceress), crit/speed north-east (Monk),
hybrid south (Mercenary/Duelist region), nature/shapeshift north-west
(Druid). Cross-tree targets are EXPENSIVE: prefer targets whose `cost`
for your class is under ~25, and cluster targets so paths share travel.

## Defence layers — every build needs a survival plan

A build that is all damage does not survive. Commit to ONE primary
defensive layer (sometimes a hybrid pair) plus life — deliberately, in
the plan, with passives spent on it.

The layer also DICTATES ATTRIBUTES: armour gear requires Strength,
evasion gear Dexterity, energy-shield gear Intelligence, hybrid bases a
mix (str/dex, dex/int, str/int). Your skills' attribute needs, your
class's tree region, and your defensive layer should therefore agree —
that alignment is usually what makes one layer the logically sound
choice for a given build type:

- Armour (phys mitigation) — str gear, Warrior region. Pairs with life,
  block (shield), stun threshold. Weak vs elemental — cap resistances
  on gear.
- Evasion / Deflection (avoid or deflect hits) — dex gear,
  Ranger/Huntress/Monk region. Strong vs attacks, weaker vs many
  spells; pair with acrobatic-style keystones and a recovery source.
- Energy Shield (a second, recharging pool) — int gear,
  Witch/Sorceress region. Watch for "ES does not recharge" downsides on
  keystones.
- Mana as a layer — Mind-over-Matter-style nodes redirect a share of
  damage to mana; with strong mana regen a caster can treat a deep pool
  as extra life. Only works if casting isn't consuming the whole pool.
- Ward / runic ward and similar flat-absorb layers (mostly gear/runes) —
  flat per-hit absorption; effective at low investment, needs upkeep to
  stay relevant.
- Hybrids (armour+evasion, evasion+ES, armour+ES) are legitimate — they
  match hybrid gear bases and split-attribute builds.
- Universal, regardless of layer: maximum Life nodes (~30% of points is
  normal), capped elemental resistances (mostly gear), and ONE recovery
  mechanism (regen, leech, or flask-centric nodes).

State the chosen layer(s) in the build's notes so the user knows the
survival plan — e.g. "defence: evasion + acrobatics, life on every
cluster, recovery via leech".

## Skills & supports

- One 5-support "main skill" carries damage; 1-3 utility skills (a
  curse, a movement skill, a buff/herald) take the rest.
- SPIRIT — the most-skipped ingredient in agent builds, and one of
  the most important in real ones. Spirit is PoE2's reservation
  resource: persistent buffs (gems tagged HasReservation — heralds,
  auras, Grim Feast-style effects) stay on permanently and reserve
  it. The base pool is quest-earned: +30 (Act 1 boss), +30 (Act 3),
  +40 (post-Act-4 interlude) = 100; read the conservative per-level
  schedule and every gem's reservation cost from
  /assets/agent/spirit.json. A typical real build reserves 60-100
  spirit on 1-3 persistent buffs — if your plan reserves zero, ask
  yourself why. SUPPORTS MULTIPLY RESERVATIONS: each support's
  cost_multiplier/100 compounds (spirit.json
  support_cost_multipliers), so a heavily-supported herald can cost
  half again its base — a classic overspend trap. Gear extends the
  pool: sceptres carry exact base Spirit (granted_skills.json
  `bases`), +Spirit uniques count at their low roll; minion builds
  live and die on it. Validate reports spirit.{reserved,
  base_available, gear_bonus} per capture and warns (not errors) on
  overspend beyond base+gear.
- ITEM-GRANTED SKILLS: uniques and base items grant skills while
  equipped (/assets/agent/granted_skills.json, `uniques` + `bases`).
  Sceptres are the famous case — each grants its aura/minion skill
  AND exactly 100 Spirit; wands and staves grant their attack spell.
  Free: no gem slot, and supports socket into them at no gem cost
  (2 sockets at granted level 1, 3 at 10, 4 at 15, 5 at 20 —
  spirit.json granted_skill_sockets). If your gear names one, build
  around it instead of re-adding it to skills[].
- Supports must be type-compatible (the require/exclude data) AND
  thematically sensible: more-damage supports on the main skill,
  duration/area/utility on utility skills. Each support once per build.
- Damage-over-time skills don't crit; attack skills scale with weapon;
  spells scale with gem level — pick passives accordingly.

## Leveling realism — captures must be obtainable at their level

Nobody has an endgame setup in Act 1. Each capture's skills and gear
must be plausible AT ITS LEVEL:

- Gems: skill_catalogue's `req_level` is when a gem becomes obtainable —
  don't put Comet (req 42) in a level-22 capture. Gem level rises with
  you: keep `level` ≤ roughly the capture level minus the gem's
  req_level (and never above natural_max_level). Mana costs grow with
  gem level — an early capture often runs a LOWER gem level than the
  maximum on purpose.
- Supports: early captures realistically run 1-3 supports on the main
  skill; the full 5-support setup belongs in maps-level captures. Add
  supports capture by capture as they'd be acquired.
- Gear: bases.json `lvl` is the drop level — early captures use
  low-tier bases with 1-2 mods ("Rare Cloaked Mail, +life +res"),
  endgame captures the expert tiers with 3-4 mods. Snapshot the tier
  progression the same way you snapshot gems.
- /agent/validate checks all of this per capture (gem req_level vs
  capture level, gem level vs character level, base drop level).

## Gear direction (what to write in gear[])

Uniques from item_catalogue (exact names) for the slots that define the
build — usually the weapon and one or two key items. Uniques ARE their
rarity — never give a unique a rarity or a mods list. For every OTHER
slot, don't hand-wave "any rare with ES": pick a real base from
/assets/agent/bases.json whose defence type and attribute requirements
match the build's layer (pure-es body for an int caster, ar/ev hybrid
for str/dex), then spec {base, rarity, mods} with the 2-4 mods that
matter most, most-important first. That's the difference between a
build guide and a shrug.

Copy mod lines from /assets/agent/mods.json — each family has `text`
(the real rolled form, e.g. "+(10-214) to maximum Life") and `slots`
(the spawn tags gating where it rolls: body_armour, int_armour, mace,
ring…). A mod whose slots don't match the base can't roll on it.
Rarity follows mod count: an item with no mods is normal, 1-2 mods is
magic, more than two is rare. Stating "rare" with only the 2 priority
mods listed is fine — the floor is what's enforced, not the ceiling.

## Archetype cheat sheet

- Melee bruiser (Warrior/Titan): mace + shield, armour+life+stun nodes,
  Slam skills, totems for extra damage.
- Bow crit (Ranger/Deadeye, Huntress/Amazon): evasion+crit+projectile
  nodes, Lightning Arrow / gas arrow style mains.
- Caster (Sorceress/Stormweaver, Witch): ES+spell damage+cast speed,
  one element, exposure/penetration supports.
- Minions (Witch/Infernalist or Lich): Spirit stacking, minion
  life/damage nodes, your own damage barely matters.
- Trigger/DoT/hybrids exist — only attempt if the user asks.

## Common agent mistakes (from real audits)

- Picking notables on the far side of the tree (check `cost`).
- Reusing the same support gem in two skills (once per character).
- Guessing community gem names — supports are tiered ("Multishot I");
  always copy names from skill_catalogue.
- Forgetting Life: a build with 15 damage notables and no life dies in
  act 2. ~1 life/defence node per 2 damage nodes is a sane ratio.
- Spirit-reserving more than the build can have.

Validate before delivering: GET /agent/validate?plan=<b64url> returns
resolved targets, point totals, and gem compatibility problems.
