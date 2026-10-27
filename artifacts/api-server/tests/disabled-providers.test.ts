import assert from "node:assert/strict";
import { test } from "node:test";
import { findProfiles } from "../src/lib/musician-search";

test("explicit Tavily requests are rejected before any network requests", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Unexpected network request"); };
  try {
    await assert.rejects(findProfiles({ subject: "Example", methods: ["tavily"] }), /Tavily is disabled/);
    await assert.rejects(findProfiles({ subject: "Example", methods: ["serper", "tavily", "gemini"] }), /Tavily is disabled/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});
