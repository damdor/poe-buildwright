//! serve — std-only static-file HTTP server for the PoE2 planner viewer.
//! Single TCP listener, one OS thread per connection. Not production-grade
//! — local dev only.
//!
//! Routes:
//!   GET  /                          → static index.html (if present)
//!   GET  /assets/sprites/…          → cached `immutable` long-lived
//!   GET  /*.html                    → cached `no-cache, must-revalidate`
//!
//! Anything else: 404. (The old `/api/builds` save-selection endpoints
//! were removed once the Captures system + landing-page localStorage
//! list covered all the same use cases.)

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use std::thread;

const USAGE: &str = "\
serve — std-only static-file server for the PoE2 planner

USAGE:
    serve [--dir <path>] [--host <addr>] [--port <num>]

OPTIONS:
    --dir <path>          static files root (default: ./viewer)
    --host <addr>         bind address (default: 127.0.0.1)
    --port <num>          port (default: 8000)
";

struct Args {
    dir: PathBuf,
    host: String,
    port: u16,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    let dir = fs::canonicalize(&args.dir)
        .map_err(|e| format!("cannot resolve --dir {}: {e}", args.dir.display()))?;
    if !dir.is_dir() {
        return Err(format!("--dir is not a directory: {}", dir.display()));
    }

    let listener = TcpListener::bind((args.host.as_str(), args.port))
        .map_err(|e| format!("bind {}:{}: {e}", args.host, args.port))?;
    eprintln!(
        "serve: http://{}:{}/  (static={})  Ctrl-C to stop",
        args.host,
        args.port,
        dir.display(),
    );
    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let dir = dir.clone();
                thread::spawn(move || {
                    if let Err(e) = handle(s, &dir) {
                        eprintln!("serve: connection error: {e}");
                    }
                });
            }
            Err(e) => eprintln!("serve: accept error: {e}"),
        }
    }
    Ok(())
}

fn parse_args() -> Result<Args, String> {
    let mut argv = env::args().skip(1);
    let mut dir = PathBuf::from("viewer");
    let mut host = String::from("127.0.0.1");
    let mut port: u16 = 8000;
    while let Some(a) = argv.next() {
        match a.as_str() {
            "--help" | "-h" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            "--dir" => {
                dir = argv
                    .next()
                    .map(PathBuf::from)
                    .ok_or("missing value for --dir")?;
            }
            "--host" => host = argv.next().ok_or("missing value for --host")?,
            "--port" => {
                let v = argv.next().ok_or("missing value for --port")?;
                port = v.parse().map_err(|_| format!("bad port {v:?}"))?;
            }
            other => return Err(format!("unknown arg: {other}\n\n{USAGE}")),
        }
    }
    Ok(Args { dir, host, port })
}

// --- request parsing --------------------------------------------------------

struct Request {
    method: String,
    path: String,
}

fn read_request(reader: &mut BufReader<TcpStream>) -> std::io::Result<Option<Request>> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let line = line.trim_end_matches(['\r', '\n']).to_string();
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    // Drain the remaining header lines so the socket is positioned at
    // the body (we don't currently inspect any header, so just skip).
    loop {
        let mut h = String::new();
        let n = reader.read_line(&mut h)?;
        if n == 0 || h == "\r\n" || h == "\n" {
            break;
        }
    }
    Ok(Some(Request { method, path }))
}

// --- top-level dispatch -----------------------------------------------------

fn handle(mut stream: TcpStream, dir: &Path) -> std::io::Result<()> {
    let peer = stream
        .peer_addr()
        .map(|p| p.to_string())
        .unwrap_or_else(|_| "?".into());
    let mut reader = BufReader::new(stream.try_clone()?);
    let req = match read_request(&mut reader)? {
        Some(r) => r,
        None => return Ok(()),
    };
    eprintln!("[serve] {peer}  {} {}", req.method, req.path);

    // Strip query string for routing.
    let path_only = req.path.split('?').next().unwrap_or("/").to_string();
    handle_static(&mut stream, &req.method, &path_only, dir)
}

// --- static files -----------------------------------------------------------

fn handle_static(
    stream: &mut TcpStream,
    method: &str,
    raw_path: &str,
    dir: &Path,
) -> std::io::Result<()> {
    if method != "GET" && method != "HEAD" {
        return write_text(
            stream,
            405,
            "Method Not Allowed",
            "text/plain; charset=utf-8",
            "no-store",
            b"405\n",
        );
    }
    let lookup = if raw_path == "/" || raw_path.ends_with('/') {
        format!("{}index.html", raw_path)
    } else {
        raw_path.to_string()
    };
    let rel = match safe_relative(&lookup) {
        Some(p) => p,
        None => {
            return write_text(
                stream,
                400,
                "Bad Request",
                "text/plain",
                "no-store",
                b"400\n",
            );
        }
    };
    let mut full = dir.to_path_buf();
    for c in rel.components() {
        full.push(c);
    }
    let canonical = match fs::canonicalize(&full) {
        Ok(p) => p,
        Err(_) => return write_text(stream, 404, "Not Found", "text/plain", "no-store", b"404\n"),
    };
    if !canonical.starts_with(dir) {
        return write_text(stream, 403, "Forbidden", "text/plain", "no-store", b"403\n");
    }
    if canonical.is_dir() {
        let location = if raw_path.ends_with('/') {
            format!("{raw_path}index.html")
        } else {
            format!("{raw_path}/")
        };
        return write_redirect(stream, &location);
    }
    let body = match fs::read(&canonical) {
        Ok(b) => b,
        Err(_) => return write_text(stream, 404, "Not Found", "text/plain", "no-store", b"404\n"),
    };

    let mime = mime_for(&canonical);
    let cache = cache_header_for(raw_path);
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: {cache}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    if method == "GET" {
        stream.write_all(&body)?;
    }
    stream.flush()
}

fn cache_header_for(url_path: &str) -> &'static str {
    if url_path.starts_with("/assets/sprites/") || url_path.starts_with("/assets/lib/") {
        // Content-addressed enough for local dev — these PNG/JS files only
        // change when we re-run the extractor / re-download the lib.
        "public, max-age=31536000, immutable"
    } else if url_path.ends_with(".html") || url_path == "/" {
        // Always revalidate the HTML so a re-render shows up on refresh.
        "no-cache, must-revalidate"
    } else {
        "no-store"
    }
}

// --- helpers ----------------------------------------------------------------

fn safe_relative(url_path: &str) -> Option<PathBuf> {
    let trimmed = url_path.trim_start_matches('/');
    let decoded = url_decode(trimmed)?;
    let candidate = PathBuf::from(decoded);
    for c in candidate.components() {
        match c {
            Component::Normal(_) => {}
            _ => return None,
        }
    }
    Some(candidate)
}

fn url_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            let v = (hi as u8) * 16 + lo as u8;
            if v == 0 {
                return None;
            }
            out.push(v);
            i += 3;
        } else if b == b'+' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "application/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("txt" | "md" | "tsv" | "csv") => "text/plain; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn write_text(
    stream: &mut TcpStream,
    code: u16,
    reason: &str,
    mime: &str,
    cache: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: {cache}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn write_redirect(stream: &mut TcpStream, location: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 301 Moved Permanently\r\nLocation: {location}\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())?;
    stream.flush()
}

#[allow(dead_code)]
fn _read_trait_keeper(_r: &mut dyn Read) {}
