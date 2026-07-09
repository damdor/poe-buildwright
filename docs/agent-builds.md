# Agent-collaborative builds — design

**Goal:** any AI agent (any model, any harness) can create a working,
openable PoE2 build on this site **without logging in**, from nothing
but a user prompt like *"make me a lightning Druid on
poe2planner"* — and hand the user a URL. Stretch: the user opens the
URL early and **watches the build grow live** while the agent (or a
friend) keeps editing.

This is a genuine gap in the planner landscape: existing sites encode
builds as opaque compressed blobs and expect a human driving a mouse.
Agents fail on them for one structural reason —

## Why agents can't build passive trees today

The tree is a ~5000-node connectivity graph. A valid build is a
*connected subgraph rooted at the class start*. Every existing share
format (PoB codes, site URLs) serializes the **full node-id list,
compressed** — so an agent must (a) know thousands of numeric node ids,
(b) solve graph connectivity, and (c) emit a bit-exact binary encoding.
Each step alone defeats a language model.

**The design move: make intent the interface, not node lists.** An
agent is excellent at *"this build wants Brain Storm, Heart of the
Storm, and the Shaman ascendancy"* and terrible at *"node 50498 connects
via 23961→8791→…"*. So the agent speaks **targets**; the site's own
deterministic pathfinder (already in the page for hover previews)
resolves travel nodes. Any model that can write JSON and copy names from
a list can produce a working build.

## The three layers

### 1. Grounding — machine-readable site data (static, shipped now)

Agents hallucinate names unless given the real vocabulary. We publish
first-party catalogues as plain JSON, served statically (works on CF
Pages, no backend):

| Endpoint | Contents | Status |
|---|---|---|
| `/llms.txt` | agent-facing instructions + schema + examples | **shipped** |
| `/assets/agent/nodes.json` | every targetable node: id, name, kind, ascendancy, stats | **shipped** |
| `/assets/skill_catalogue.json` | all gems: name, type, tags, compat fields | already existed |
| `/assets/item_catalogue.json` | all uniques: name, base, slot, stats | already existed |

`llms.txt` is the discovery root (the emerging convention agents check,
like robots.txt). It tells the agent: fetch the catalogues, ground every
name against them, build the plan JSON, emit the URL.

### 2. The agent plan format + `#agent=` importer (shipped now)

A **goal-oriented** JSON document; forgiving by design (unknown names
are *reported*, never fatal):

```json
{
  "format": "poe2-agent-plan",
  "version": 1,
  "name": "Stormcaller Druid",
  "class": "Druid",
  "ascendancy": "Shaman",
  "targets": ["Brain Storm", "Heart of the Storm", 58197],
  "skills": [
    { "gem": "Spark", "level": 12, "supports": ["Arcane Surge", "Lightning Penetration"] }
  ],
  "gear": [
    { "slot": "weapon1", "name": "Quill Rain", "note": "swap at 60" },
    { "slot": "body", "name": "any rare with +life and lightning res" }
  ],
  "notes": "Totem-flavored lightning leveling; respec into crit at maps."
}
```

- `targets`: notables/keystones by **name** (case-insensitive) or id.
  The importer multi-source-BFSes from the class start, allocating the
  shortest connecting path to each target greedily (nearest-first).
  Travel nodes are chosen by the site, deterministically.
- `skills`/`gear`: names grounded against the catalogues; gear accepts
  freetext (rare-item descriptions are legitimate guidance).
- Delivery: `planner.html#agent=<base64url(utf8 JSON)>`. Pure URL
  fragment — never sent to a server, no login, no state; the page
  materializes it into a normal local plan the user owns and can edit.
  Import summary is flashed, including anything unresolved
  ("2 targets not found: 'Storm Weaver' — closest match 'Stormweaver'").

Result: **the agent's entire job is: fetch 2–3 JSON files, write one
JSON object, base64url it, print a URL.** Every frontier and most small
models can do this reliably.

### 3. Live collaboration — watch the agent build (designed, not built)

The URL-fragment flow is one-shot. For *"watch my agent work"*:

- **Channel = capability URL.** `planner.html?live=<token>`, token =
  128-bit random. Knowing the URL is the permission (no accounts,
  same trust model as unlisted links).
- **Writer:** agent `PUT https://<site>/live/<token>` with the same
  agent-plan JSON (or a full internal plan), each time it changes.
  A monotonically-increasing `rev` in the body settles ordering.
- **Reader:** the planner in live mode polls `GET /live/<token>` every
  ~2.5 s with `If-None-Match` (ETag = rev). On change: re-run the
  importer diff, animate newly-allocated nodes, show a **LIVE** badge
  ("agent edited 3 s ago"). Read-only while live; a *Take over* button
  detaches the copy into a normal editable plan.
- **Infra:** one Cloudflare Worker + KV namespace (~60 lines): PUT
  stores body (size-capped ~256 KB, TTL 48 h), GET serves with ETag.
  Polling KV is effectively free at this cadence. Upgrade path to a
  Durable Object + SSE for true push, same URL shape — reader falls
  back to polling if EventSource fails, so the MVP and the upgrade
  coexist.
- **Human↔human works identically** — a friend streams their build to
  your screen with zero extra code.

Deliberately NOT in scope: accounts, presence/cursors, CRDT merging.
Last-write-wins with `rev` + read-only viewers is enough for the
"agent builds, human watches, human takes over" loop.

## Failure & abuse posture

- Malformed JSON / wrong format string → clear flash, planner still
  boots empty. Never a broken page from a bad link.
- Unresolvable names → imported anyway minus those entries, with a
  visible report (fuzzy-match suggestions where cheap).
- Fragment size: base64url of realistic plans is 1–4 KB; browsers are
  comfortable beyond 32 KB. The live channel caps at 256 KB server-side.
- The live channel stores whatever it's given (it's a capability URL,
  same as any paste service): TTL + size cap + no listing keeps the
  abuse surface small.

## Sequencing

1. **Shipped in this change:** `llms.txt`, `/assets/agent/nodes.json`,
   the `#agent=` importer with greedy BFS auto-pathing, import summary
   flashes.
2. Next: an "Agent link" action in the ⌘K palette (export the CURRENT
   plan as an agent-plan URL — lets agents also *read* builds, and
   humans round-trip them).
3. Then: the live channel Worker + `?live=` mode as above.
4. Later: `nodes.json` gains per-node coordinates + cluster labels so
   sophisticated agents can reason spatially; validator endpoint
   (`POST /validate` in the same Worker) so agents can lint a plan
   before sharing it.
