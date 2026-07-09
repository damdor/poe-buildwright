//! Reader for GGG's `.psg` passive-skill-graph files — the binary that
//! holds the passive tree's *geometry and topology* (group positions,
//! per-node orbit placement, and the connection graph). It is **not** a
//! `.datc64` table, so [`crate::dat`] can't read it; this is its own
//! reverse-engineered reader.
//!
//! Live path: `metadata/passiveskillgraph.psg` (character tree). The
//! atlas + league variants (`metadata/atlasskillgraphs/*.psg`, …) use the
//! same layout, so one reader covers all.
//!
//! ## Why this matters
//!
//! Node *metadata* (name, icon, keystone/notable flags, mastery, stat
//! ids) lives in `PassiveSkills.datc64`, joined by `PassiveSkillGraphId`
//! = the node id here. But the *layout* — where each node sits — is only
//! in this file. Together they make the tree fully first-party, with no
//! Path-of-Building dependency.
//!
//! ## Format (PoE2 0.5, reverse-engineered; validated to 4276 exact node
//! positions against the parsed 0.5 baseline, 27/165144 bytes unparsed)
//!
//! ```text
//! u16 version            (= 3)
//! u16 group_count-ish    (266 on 0.5 — exact meaning unconfirmed)
//! preamble               a fixed central block (through the first node)
//!                        holding the class-start hub; treated specially.
//! then, repeating:
//!   group header  21 bytes: x:f32, y:f32, u32=0, u32 flags, u32 flags2,
//!                 u8 — the lone byte is why records aren't 4-aligned.
//!                 `x`,`y` are the group centre in render space.
//!   node run      the nodes belonging to that group, back to back.
//!
//! node record (variable length):
//!   id:u32           node id (PassiveSkillGraphId; u16-range)
//!   orbit:u32        which concentric orbit (radius index 0..9)
//!   orbit_index:u32  slot on that orbit
//!   conn_count:u32
//!   connections × ( target:u32, orbit:i32 )
//!                    orbit is the arc curvature (signed); the sentinel
//!                    [`STRAIGHT`] means a straight connector.
//! ```
//!
//! A node carries no group field — membership is positional (the run it
//! sits in). The reader assigns each node the most recent group header.
//! Discriminator while walking a run: the first word of a node is a
//! u16-range id (`< 0x10000`); a group header's first word is an `f32`
//! coordinate whose bit pattern is `> 0x10000`. So `first_word < 0x10000`
//! ⇒ node, else ⇒ a new 21-byte group header.

/// Connection `orbit` value meaning "straight line, no arc" (`i32::MAX`).
pub const STRAIGHT: i32 = 0x7FFF_FFFF;

/// Node ids are 16-bit (`PassiveSkillGraphId`); a first word at or above
/// this is therefore a group header's `f32`, not a node id.
const NODE_ID_LIMIT: u32 = 0x1_0000;

/// The 21-byte group-header length (the trailing lone `u8` makes it odd).
const HEADER_LEN: usize = 21;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PsgError {
    /// File too short for the `u16 version` + `u16` header.
    TooSmall,
    /// No node record found while scanning past the preamble.
    NoNodes,
}

impl std::fmt::Display for PsgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooSmall => write!(f, "psg: file smaller than a 4-byte header"),
            Self::NoNodes => write!(f, "psg: no node records found past the preamble"),
        }
    }
}

impl std::error::Error for PsgError {}

/// One edge out of a node: the neighbour it connects to and the arc
/// curvature ([`STRAIGHT`] for a straight connector).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Connection {
    pub target: u16,
    pub orbit: i32,
}

/// A passive node's placement + outgoing connections. `group` indexes
/// into [`Graph::groups`]; `orbit`/`orbit_index` place it on that group's
/// concentric orbits (final x/y is computed with the orbit constants).
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub id: u16,
    pub group: usize,
    pub orbit: u8,
    pub orbit_index: u16,
    pub connections: Vec<Connection>,
}

/// A group centre in render coordinate space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Group {
    pub x: f32,
    pub y: f32,
}

/// A parsed passive-skill graph: the group centres and the nodes placed
/// against them. Positions/edges are derived downstream (the shaper
/// applies orbit radii/angles and joins `PassiveSkills` metadata).
#[derive(Debug, Clone)]
pub struct Graph {
    pub version: u16,
    pub groups: Vec<Group>,
    pub nodes: Vec<Node>,
    /// Nodes seen before the first group header (the class-start hub).
    /// They carry `group == 0`, a synthetic group at the preamble origin.
    pub preamble_nodes: usize,
    /// Bytes the walk couldn't classify as a node or header — a health
    /// signal. Expected tiny (preamble tail); a large value means the
    /// schema drifted and should be investigated, not trusted.
    pub unparsed_bytes: usize,
}

#[inline]
fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
#[inline]
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
#[inline]
fn i32_at(b: &[u8], o: usize) -> i32 {
    u32_at(b, o) as i32
}
#[inline]
fn f32_at(b: &[u8], o: usize) -> f32 {
    f32::from_bits(u32_at(b, o))
}

/// Try to read a node record at `o`. Returns the parsed node and the
/// offset just past it, or `None` if the bytes there aren't a plausible
/// node. `skills_per_orbit` bounds `orbit_index` so header/garbage bytes
/// don't masquerade as nodes.
fn read_node(b: &[u8], o: usize, spo: &[u16]) -> Option<(RawNode, usize)> {
    if o + 16 > b.len() {
        return None;
    }
    let id = u32_at(b, o);
    let orbit = u32_at(b, o + 4);
    let orbit_index = u32_at(b, o + 8);
    let cc = u32_at(b, o + 12);
    if id == 0
        || id >= NODE_ID_LIMIT
        || orbit as usize >= spo.len()
        || orbit_index >= spo[orbit as usize] as u32
        || cc > 16
    {
        return None;
    }
    let mut p = o + 16;
    let mut conns = Vec::with_capacity(cc as usize);
    for _ in 0..cc {
        if p + 8 > b.len() {
            return None;
        }
        let target = u32_at(b, p);
        let corbit = i32_at(b, p + 4);
        if target == 0 || target >= NODE_ID_LIMIT || !valid_conn_orbit(corbit) {
            return None;
        }
        conns.push(Connection {
            target: target as u16,
            orbit: corbit,
        });
        p += 8;
    }
    Some((
        RawNode {
            id: id as u16,
            orbit: orbit as u8,
            orbit_index: orbit_index as u16,
            connections: conns,
        },
        p,
    ))
}

#[inline]
fn valid_conn_orbit(o: i32) -> bool {
    o == STRAIGHT || (-16..=16).contains(&o)
}

struct RawNode {
    id: u16,
    orbit: u8,
    orbit_index: u16,
    connections: Vec<Connection>,
}

/// Try to read a 21-byte group header at `o`. A header is `x:f32, y:f32`
/// in render range followed by a zero `u32` (the invariant that
/// distinguishes it from arbitrary float-looking bytes).
fn read_header(b: &[u8], o: usize) -> Option<(Group, usize)> {
    if o + HEADER_LEN > b.len() {
        return None;
    }
    let x = f32_at(b, o);
    let y = f32_at(b, o + 4);
    if !x.is_finite() || !y.is_finite() || x.abs() > 30_000.0 || y.abs() > 30_000.0 {
        return None;
    }
    if u32_at(b, o + 8) != 0 {
        return None;
    }
    Some((Group { x, y }, o + HEADER_LEN))
}

impl Graph {
    /// Parse a decompressed `.psg` payload. `skills_per_orbit` is the
    /// per-orbit slot count (a stable tree constant) used to validate
    /// `orbit_index` while walking — pass the known PoE2 values.
    pub fn parse(data: &[u8], skills_per_orbit: &[u16]) -> Result<Self, PsgError> {
        if data.len() < 4 {
            return Err(PsgError::TooSmall);
        }
        let version = u16_at(data, 0);

        // Skip the preamble: scan to the first offset that reads as a
        // valid node. Everything before is the central/class-start block.
        let mut o = 4;
        while o + 16 <= data.len() && read_node(data, o, skills_per_orbit).is_none() {
            o += 1;
        }
        if o + 16 > data.len() {
            return Err(PsgError::NoNodes);
        }

        let mut groups: Vec<Group> = Vec::new();
        let mut nodes: Vec<Node> = Vec::new();
        // Synthetic group 0 for pre-header (class-start) nodes: the
        // preamble origin. Positioned by the metadata join downstream.
        groups.push(Group { x: 0.0, y: 0.0 });
        let mut current = 0usize;
        let mut preamble_nodes = 0usize;
        let mut unparsed = 0usize;

        while o + 16 <= data.len() {
            // Discriminator: node id is u16-range; a header's first word
            // is an f32 coordinate (bit pattern ≥ 0x10000).
            if u32_at(data, o) < NODE_ID_LIMIT {
                if let Some((rn, end)) = read_node(data, o, skills_per_orbit) {
                    if current == 0 {
                        preamble_nodes += 1;
                    }
                    nodes.push(Node {
                        id: rn.id,
                        group: current,
                        orbit: rn.orbit,
                        orbit_index: rn.orbit_index,
                        connections: rn.connections,
                    });
                    o = end;
                    continue;
                }
                // Looked like a node but wasn't; step past it.
                o += 1;
                unparsed += 1;
            } else if let Some((g, end)) = read_header(data, o) {
                groups.push(g);
                current = groups.len() - 1;
                o = end;
            } else {
                o += 1;
                unparsed += 1;
            }
        }
        // Trailing bytes (< 16) can't start a record.
        unparsed += data.len().saturating_sub(o);

        Ok(Graph {
            version,
            groups,
            nodes,
            preamble_nodes,
            unparsed_bytes: unparsed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The stable PoE2 per-orbit slot counts (validated against the tree
    /// constants). Kept here so tests don't depend on external data.
    const SPO: &[u16] = &[1, 12, 24, 24, 72, 72, 72, 24, 72, 144];

    /// Assemble one node record's bytes.
    fn node_bytes(id: u32, orbit: u32, oi: u32, conns: &[(u32, i32)]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&id.to_le_bytes());
        v.extend_from_slice(&orbit.to_le_bytes());
        v.extend_from_slice(&oi.to_le_bytes());
        v.extend_from_slice(&(conns.len() as u32).to_le_bytes());
        for (t, o) in conns {
            v.extend_from_slice(&t.to_le_bytes());
            v.extend_from_slice(&o.to_le_bytes());
        }
        v
    }

    fn header_bytes(x: f32, y: f32) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&x.to_le_bytes());
        v.extend_from_slice(&y.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes()); // +8 == 0 invariant
        v.extend_from_slice(&0u32.to_le_bytes()); // +12 flags
        v.extend_from_slice(&0u32.to_le_bytes()); // +16 flags2
        v.push(0u8); // +20 lone byte → 21 total
        v
    }

    #[test]
    fn parses_header_node_runs() {
        let mut d = Vec::new();
        d.extend_from_slice(&3u16.to_le_bytes()); // version
        d.extend_from_slice(&0u16.to_le_bytes()); // count-ish
        // A preamble node (before any header) → group 0.
        d.extend_from_slice(&node_bytes(100, 0, 0, &[]));
        // Group A at (10, 20) with two nodes.
        d.extend_from_slice(&header_bytes(10.0, 20.0));
        d.extend_from_slice(&node_bytes(200, 2, 5, &[(200, 0), (999, STRAIGHT)]));
        d.extend_from_slice(&node_bytes(201, 4, 33, &[]));
        // Group B at (-30, 40) with one node.
        d.extend_from_slice(&header_bytes(-30.0, 40.0));
        d.extend_from_slice(&node_bytes(300, 0, 0, &[(200, -7)]));
        // Padding so the last record has room to be read.
        d.extend_from_slice(&[0u8; 16]);

        let g = Graph::parse(&d, SPO).expect("parse");
        assert_eq!(g.version, 3);
        assert_eq!(g.preamble_nodes, 1);
        // groups: synthetic 0 + A + B
        assert_eq!(g.groups.len(), 3);
        assert_eq!(g.groups[1], Group { x: 10.0, y: 20.0 });
        assert_eq!(g.groups[2], Group { x: -30.0, y: 40.0 });

        let n100 = g.nodes.iter().find(|n| n.id == 100).unwrap();
        assert_eq!(n100.group, 0); // preamble
        let n200 = g.nodes.iter().find(|n| n.id == 200).unwrap();
        assert_eq!(n200.group, 1);
        assert_eq!(n200.orbit, 2);
        assert_eq!(n200.orbit_index, 5);
        assert_eq!(n200.connections.len(), 2);
        assert_eq!(n200.connections[1].orbit, STRAIGHT);
        let n300 = g.nodes.iter().find(|n| n.id == 300).unwrap();
        assert_eq!(n300.group, 2);
        assert_eq!(n300.connections[0].orbit, -7);
        // Only the 16 bytes of zero padding are unparsed.
        assert!(g.unparsed_bytes <= 16, "unparsed={}", g.unparsed_bytes);
    }

    /// Known-answer test against the live `.psg`. Gated on PSG_TESTFILE
    /// (a decompressed `metadata/passiveskillgraph.psg`) — we don't
    /// vendor copyrighted game data. Fetch with
    /// `buildwright get metadata/passiveskillgraph.psg <path>`.
    #[test]
    fn real_passiveskillgraph() {
        let Ok(path) = std::env::var("PSG_TESTFILE") else {
            eprintln!("skipped: set PSG_TESTFILE to a decompressed .psg");
            return;
        };
        let bytes = std::fs::read(path).unwrap();
        let g = Graph::parse(&bytes, SPO).expect("parse real psg");
        // 0.5 live: ~1500 groups, ~4900 nodes, near-total byte coverage.
        assert!(g.groups.len() > 1000, "groups={}", g.groups.len());
        assert!(g.nodes.len() > 4000, "nodes={}", g.nodes.len());
        assert!(
            g.unparsed_bytes < 256,
            "unparsed={} — schema may have drifted",
            g.unparsed_bytes
        );
        // Every connection target must be a real node id.
        let ids: std::collections::HashSet<u16> = g.nodes.iter().map(|n| n.id).collect();
        let dangling = g
            .nodes
            .iter()
            .flat_map(|n| &n.connections)
            .filter(|c| !ids.contains(&c.target))
            .count();
        eprintln!(
            "psg: version={} groups={} nodes={} unparsed={} dangling_conns={}",
            g.version,
            g.groups.len(),
            g.nodes.len(),
            g.unparsed_bytes,
            dangling
        );
        assert!(dangling < 50, "too many dangling connections: {dangling}");
    }
}
