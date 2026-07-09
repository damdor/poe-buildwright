# tree_render

Renders the PoE2 passive tree as a single self-contained HTML+SVG file, with selected nodes highlighted. Std-only Rust (no crates.io deps).

## Pipeline

```
GGG data.json export (grindinggear/poe2-skilltree-export, pinned commit)
                    ↓ buildwright shape tree   (+ masteries, sprites)
data/parsed/<patch>/tree/{nodes,edges,meta,sprites,masteries}.tsv
                    ↓ tree_render
viewer/planner.html                        (self-contained)
```

The shape step decodes GGG's export into flat first-party TSVs, then the renderer reads only `nodes.tsv` (id, x, y, kind, klass, ascendancy, name, stats, …), `edges.tsv` (from, to, orbit), `meta.tsv` (canvas bounds + ascendancy map), `sprites.tsv`, and `masteries.tsv`. No Python, no PoB dependency.

## Build

From the workspace root:
```
cargo build --release
```

Builds in 1-2s. No deps.

## Run

```
./target/release/tree_render \
    --tree-dir data/parsed/tree_render \
    --output viewer/planner.html \
    [--selected path/to/nodes.txt] \
    [--title "Some title"]
```

`--selected` takes a plain text file with one numeric node ID per line. Lines starting with `#` are comments, inline `# comment` is also stripped. Example: [builds/sample_amazon_ascendancy.nodes.txt](../../builds/sample_amazon_ascendancy.nodes.txt).

## Output

Single HTML file containing inline `<style>` + SVG. Open in any browser. Hover a node to see its name + stats via the SVG `<title>` element. Selected nodes are outlined in gold; edges between two selected nodes are gold too.

CSS classes set per-node kind (`small` / `notable` / `keystone` / `asc_small` / `asc_notable` / `asc_start` / `jewel` / `mastery` / `class_start`); restyle by editing the `render_html` function or post-processing the file.

## Known limitations

- **Nodes are circles, not in-game icons.** The DDS sprites in `data/pob2/src/TreeData/0_4/` are compressed with `.zst` and use BC7 texture format; embedding them would require zstd + DDS-decoding + Canvas/base64 conversion, all of which are non-trivial without crates. Circles are readable enough as a planning aid.
- **Edges are straight lines.** The in-game tree curves edges along orbit arcs; this is a cosmetic detail we skip.
- **Mastery groups not collapsed.** A few masteries cluster at the same point and overdraw; harmless.
- **Selected-node ID format is the numeric tree.json key.** That does NOT match the short-name IDs used by GGG's `.build` format (e.g. `projectiles18`). If you have a `.build` file, you'll need to translate — see [BUILD_FORMAT_SPEC.md](../../builds/BUILD_FORMAT_SPEC.md).
