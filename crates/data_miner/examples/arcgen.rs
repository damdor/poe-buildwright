//! Dev tool: synthesise a connector arc from a line `.dds`.
//! `cargo run --example arcgen -- line.dds <size> <radius> out.png`.

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let line = data_miner::dds::decode(&std::fs::read(&a[1]).unwrap()).unwrap();
    let size: u32 = a[2].parse().unwrap();
    let radius: f32 = a[3].parse().unwrap();
    let prof = data_miner::arc::line_profile(&line);
    let img = data_miner::arc::synth_arc(&prof, size, radius);
    let png = data_miner::png::encode_rgba(img.width, img.height, &img.rgba);
    std::fs::write(&a[4], png).unwrap();
    eprintln!(
        "arc {size}px r={radius} center_row={:.1} → {}",
        prof.center, a[4]
    );
}
