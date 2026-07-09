//! Dev tool: decode a `.dds` to `.png`. `cargo run --example ddspng --
//! in.dds out.png`. Handy for eyeballing textures during art work.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: ddspng <in.dds> <out.png>");
        std::process::exit(2);
    }
    let bytes = std::fs::read(&args[1]).expect("read dds");
    let img = data_miner::dds::decode(&bytes).expect("decode dds");
    let png = data_miner::png::encode_rgba(img.width, img.height, &img.rgba);
    std::fs::write(&args[2], png).expect("write png");
    eprintln!("{}x{} → {}", img.width, img.height, args[2]);
}
