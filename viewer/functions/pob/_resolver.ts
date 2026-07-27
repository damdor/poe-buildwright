// Pure, testable boundary for resolving a public pobb.in share URL.
//
// The browser never fetches an arbitrary URL. It sends a reviewed pobb.in
// link to the Pages Function, which constructs the one permitted `/raw`
// endpoint itself and reads it through a hard byte limit.

export const MAX_POBB_INPUT_BYTES = 2 * 1024;
export const MAX_POBB_CODE_BYTES = 6 * 1024 * 1024;
export const POBB_TIMEOUT_MS = 8_000;

export interface PobbLocation {
  slug: string;
  sourceUrl: string;
  rawUrl: string;
}

export interface ResolvePobbOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  maxBytes?: number;
}

export function parsePobbUrl(input: string): PobbLocation {
  const raw = input.trim();
  if (!raw || raw.length > MAX_POBB_INPUT_BYTES) {
    throw new Error("Enter a reasonably sized pobb.in URL.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a complete https://pobb.in/<code> URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "pobb.in" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Only direct https://pobb.in/<code> links are allowed.");
  }
  const match = /^\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname);
  if (!match) {
    throw new Error("The pobb.in link must contain exactly one build code.");
  }
  const slug = match[1]!;
  return {
    slug,
    sourceUrl: `https://pobb.in/${slug}`,
    rawUrl: `https://pobb.in/${slug}/raw`,
  };
}

async function readBoundedUtf8(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("The pobb.in build is larger than the import limit.");
  }
  if (!response.body) throw new Error("pobb.in returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("The pobb.in build is larger than the import limit.");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    throw new Error("pobb.in returned non-UTF-8 build data.");
  }
}

export async function resolvePobbCode(
  input: string,
  options: ResolvePobbOptions = {},
): Promise<{ code: string; sourceUrl: string }> {
  const location = parsePobbUrl(input);
  const response = await (options.fetcher ?? fetch)(location.rawUrl, {
    method: "GET",
    redirect: "error",
    headers: {
      "Accept": "text/plain",
      "User-Agent": "poe-buildwright-pobb-import/1",
    },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`pobb.in returned HTTP ${response.status}.`);
  }
  const code = (await readBoundedUtf8(
    response,
    options.maxBytes ?? MAX_POBB_CODE_BYTES,
  )).trim();
  if (!code) throw new Error("pobb.in returned an empty build.");
  return { code, sourceUrl: location.sourceUrl };
}
