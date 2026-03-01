import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TimedSessionCache } from "./toolCatalogCache.js";

describe("TimedSessionCache", () => {
  it("reuses cached value within TTL", async () => {
    const cache = new TimedSessionCache<number>(60_000);
    let calls = 0;

    const first = await cache.get("s1", async () => {
      calls += 1;
      return 42;
    }, 1_000);

    const second = await cache.get("s1", async () => {
      calls += 1;
      return 99;
    }, 1_500);

    assert.equal(first, 42);
    assert.equal(second, 42);
    assert.equal(calls, 1);
  });

  it("refreshes value after TTL", async () => {
    const cache = new TimedSessionCache<number>(100);
    let calls = 0;

    const first = await cache.get("s1", async () => {
      calls += 1;
      return 1;
    }, 1_000);

    const second = await cache.get("s1", async () => {
      calls += 1;
      return 2;
    }, 1_150);

    assert.equal(first, 1);
    assert.equal(second, 2);
    assert.equal(calls, 2);
  });

  it("clears per session", async () => {
    const cache = new TimedSessionCache<string>(60_000);
    let calls = 0;

    await cache.get("s1", async () => {
      calls += 1;
      return "a";
    }, 1_000);

    cache.clear("s1");

    const value = await cache.get("s1", async () => {
      calls += 1;
      return "b";
    }, 1_100);

    assert.equal(value, "b");
    assert.equal(calls, 2);
  });
});
