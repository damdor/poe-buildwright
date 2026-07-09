# serve

Tiny std-only static-file HTTP server for local development. No crates.io deps.

Intended for serving the rendered tree HTML files in `viewer/` so HTMX (and any other fetch-based interactivity) can work — `file://` blocks those for CORS.

## Build

From the workspace root:
```
cargo build --release
```

## Run

```
./target/release/serve [--dir <path>] [--host <addr>] [--port <num>]
```

Defaults: `--dir viewer --host 127.0.0.1 --port 8000`.

Open `http://localhost:8000/` and you'll see the index of available build views.

## What it does

- Threaded — one OS thread per connection (fine for dev traffic).
- Returns proper Content-Type per file extension (html/css/js/svg/png/json/wasm/woff2/...).
- Rejects path traversal (`..`, absolute paths) at the URL parser before touching disk.
- Canonicalizes the resolved path and verifies it stays under `--dir`.
- Sends `Cache-Control: no-store` so changes show up on refresh without browser caching.
- HEAD and GET only. Other methods get `405 Method Not Allowed`.
- Directory requests get a 301 redirect to add a trailing slash → `index.html` lookup.
- URL-decodes `%XX` sequences in the path (rejects `%00`).

## What it deliberately doesn't do

- No HTTPS, no compression, no chunked transfer, no range requests, no keep-alive (connection closes after each response), no auto-index of directories (you make your own `index.html`).
- Not safe for hostile traffic — local dev only.

## Sharing on your LAN

```
./target/release/serve --host 0.0.0.0 --port 8000
```

Then other devices can reach `http://<your-machine-ip>:8000/`. Watch your firewall, and remember this server has no auth.
