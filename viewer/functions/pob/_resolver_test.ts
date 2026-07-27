/// <reference lib="deno.ns" />

import {
  parsePobbUrl, resolvePobbCode,
} from "./_resolver.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("pobb resolver accepts only one canonical allowlisted path", () => {
  const parsed = parsePobbUrl("https://pobb.in/ZH1xEb_zXbxl/");
  assert(parsed.slug === "ZH1xEb_zXbxl", "share slug was not retained");
  assert(
    parsed.rawUrl === "https://pobb.in/ZH1xEb_zXbxl/raw",
    "raw endpoint was not constructed internally",
  );
  for (
    const invalid of [
      "http://pobb.in/abc",
      "https://evil.example/abc",
      "https://pobb.in.evil.example/abc",
      "https://user@pobb.in/abc",
      "https://pobb.in:444/abc",
      "https://pobb.in/abc/raw",
      "https://pobb.in/abc?next=https://evil.example",
      "https://pobb.in/abc#fragment",
    ]
  ) {
    let rejected = false;
    try {
      parsePobbUrl(invalid);
    } catch {
      rejected = true;
    }
    assert(rejected, `unsafe URL was accepted: ${invalid}`);
  }
});

Deno.test("pobb resolver applies redirect and byte boundaries", async () => {
  let requested = "";
  let redirect: RequestRedirect | undefined;
  const success = await resolvePobbCode("https://pobb.in/fixture", {
    fetcher: (_input, init) => {
      requested = String(_input);
      redirect = init?.redirect;
      return Promise.resolve(new Response("fixture-code"));
    },
    maxBytes: 32,
  });
  assert(requested === "https://pobb.in/fixture/raw", "wrong upstream URL");
  assert(redirect === "error", "upstream redirects were not disabled");
  assert(success.code === "fixture-code", "raw code was altered");

  let oversized = false;
  try {
    await resolvePobbCode("https://pobb.in/fixture", {
      fetcher: () => Promise.resolve(new Response("0123456789")),
      maxBytes: 5,
    });
  } catch {
    oversized = true;
  }
  assert(oversized, "oversized upstream body was accepted");
});
