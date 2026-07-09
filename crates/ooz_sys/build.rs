use std::path::Path;
use std::process::Command;

/// The ooz decoder sources are NOT distributable by us: kraken.cpp is
/// GPL-3.0-or-later and lzna.cpp/bitknit.cpp carry no license at all
/// (see VENDOR.md). So this repo ships none of them — the build
/// fetches each file from zao/ooz at the pinned commit into vendor/
/// (gitignored) and verifies its SHA-256 before compiling. Each user
/// downloads the sources themselves, directly from the upstream repo;
/// we distribute nothing but this recipe.
const OOZ_COMMIT: &str = "ff5aeb9e45e362e8d6bb1199aa82406285dd2a18";
const OOZ_FILES: &[(&str, &str)] = &[
    (
        "kraken.cpp",
        "bb208fad85e558839175bdb0993090b3400b1a2a5d56f437aa69c3e192cd0b08",
    ),
    (
        "bitknit.cpp",
        "dc2cc2447c8a3a06e125678ee98a829025a8653f7e055f96e7005e29e0ed368c",
    ),
    (
        "lzna.cpp",
        "50cd7aa179e5d571814a5bc132d2344f2151bcaf3eea56714d391f88a25e61c9",
    ),
    (
        "stdafx.h",
        "6a667c8822ca70cd8bc808f33a280639205f461390036af8786c3dca1f6a4528",
    ),
];

fn sha256_hex(bytes: &[u8]) -> String {
    // A std-only SHA-256 would be overkill for a build script: defer
    // to the `sha256sum` binary present on every supported dev host.
    let out = Command::new("sha256sum")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut c| {
            use std::io::Write;
            c.stdin.take().unwrap().write_all(bytes)?;
            c.wait_with_output()
        })
        .expect("sha256sum not runnable — install coreutils");
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string()
}

fn ensure_vendor(dir: &Path) {
    std::fs::create_dir_all(dir).expect("create vendor dir");
    for (name, want) in OOZ_FILES {
        let path = dir.join(name);
        if let Ok(bytes) = std::fs::read(&path) {
            if sha256_hex(&bytes) == *want {
                continue;
            }
            panic!(
                "{} exists but does not match the pinned SHA-256 — delete it and rebuild",
                path.display()
            );
        }
        let url = format!("https://raw.githubusercontent.com/zao/ooz/{OOZ_COMMIT}/{name}");
        eprintln!("ooz_sys: fetching {url}");
        let out = Command::new("curl")
            .args(["-fsSL", "--retry", "3", &url])
            .output()
            .expect("curl not runnable — install curl");
        assert!(
            out.status.success(),
            "download failed for {url} — offline? fetch it manually into {}",
            dir.display()
        );
        let got = sha256_hex(&out.stdout);
        assert_eq!(
            &got, want,
            "SHA-256 mismatch for {name} — refusing to compile"
        );
        std::fs::write(&path, &out.stdout).expect("write vendor file");
    }
}

fn main() {
    let vendor = Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor");
    ensure_vendor(&vendor);
    println!("cargo:rerun-if-changed=vendor");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        // Compiles out the CLI half of kraken.cpp (main, file I/O, the
        // oo2core dll loader, compressor externs) — decode-only library.
        .define("OOZ_BUILD_DLL", "1")
        .include(&vendor)
        .files([
            vendor.join("kraken.cpp"),
            vendor.join("bitknit.cpp"),
            vendor.join("lzna.cpp"),
        ])
        // Always optimize: dev-profile (-O0) Oodle decode is ~10x slower,
        // and we decode hundreds of MiB even in tests.
        .opt_level(2)
        .warnings(false)
        .compile("ooz");
}
