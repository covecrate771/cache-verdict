import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVerdict, parseCacheControl, splitTopLevel } from "./core.js";

const DATE = "Wed, 01 Jan 2025 00:00:00 GMT";

test("splitTopLevel ignores separators inside quotes", () => {
  assert.deepEqual(splitTopLevel('a="x,y", b', ","), ['a="x,y"', " b"]);
  assert.deepEqual(splitTopLevel("", ","), [""]);
});

test("parseCacheControl returns an empty map for missing or blank input", () => {
  assert.equal(parseCacheControl(undefined).size, 0);
  assert.equal(parseCacheControl("").size, 0);
  assert.equal(parseCacheControl(" , ,").size, 0);
});

test("parseCacheControl lowercases names and keeps flag directives as true", () => {
  const cc = parseCacheControl("No-Cache, MAX-AGE=60");
  assert.equal(cc.get("no-cache"), true);
  assert.equal(cc.get("max-age"), "60");
});

test("parseCacheControl strips quotes and keeps commas inside quoted values", () => {
  const cc = parseCacheControl('private="set-cookie, x-token", max-age=5');
  assert.equal(cc.get("private"), "set-cookie, x-token");
  assert.equal(cc.get("max-age"), "5");
});

test("parseCacheControl tolerates whitespace around equals signs", () => {
  assert.equal(parseCacheControl("max-age = 30").get("max-age"), "30");
});

test("no-store blocks every cache", () => {
  const v = computeVerdict({ cacheControl: "no-store, max-age=600" });
  assert.equal(v.sharedCacheable, false);
  assert.equal(v.privateCacheable, false);
});

test("private blocks shared caches only", () => {
  const v = computeVerdict({ cacheControl: "private, max-age=60" });
  assert.equal(v.sharedCacheable, false);
  assert.equal(v.privateCacheable, true);
});

test("max-age sets lifetime and Age is subtracted for remaining time", () => {
  const v = computeVerdict({ cacheControl: "max-age=60", age: "10" });
  assert.equal(v.freshnessLifetimeSeconds, 60);
  assert.equal(v.freshnessSource, "max-age");
  assert.equal(v.currentAgeSeconds, 10);
  assert.equal(v.remainingFreshSeconds, 50);
});

test("remaining time goes negative once the response is older than its lifetime", () => {
  const v = computeVerdict({ cacheControl: "max-age=60", age: "100" });
  assert.equal(v.remainingFreshSeconds, -40);
});

test("s-maxage takes precedence over max-age", () => {
  const v = computeVerdict({ cacheControl: "max-age=60, s-maxage=300" });
  assert.equal(v.freshnessLifetimeSeconds, 300);
  assert.equal(v.freshnessSource, "s-maxage");
});

test("max-age takes precedence over Expires", () => {
  const v = computeVerdict({
    cacheControl: "max-age=30",
    expires: "Wed, 01 Jan 2025 01:00:00 GMT",
    date: DATE,
  });
  assert.equal(v.freshnessLifetimeSeconds, 30);
  assert.equal(v.freshnessSource, "max-age");
});

test("Expires is measured against the Date header", () => {
  const v = computeVerdict({ expires: "Wed, 01 Jan 2025 00:01:00 GMT", date: DATE });
  assert.equal(v.freshnessLifetimeSeconds, 60);
  assert.equal(v.freshnessSource, "expires");
});

test("an Expires value in the past clamps lifetime to zero", () => {
  const v = computeVerdict({ expires: "Tue, 31 Dec 2024 00:00:00 GMT", date: DATE });
  assert.equal(v.freshnessLifetimeSeconds, 0);
  assert.equal(v.remainingFreshSeconds, 0);
});

test("an unparseable Expires is ignored with a note", () => {
  const v = computeVerdict({ expires: "not a date", date: DATE });
  assert.equal(v.freshnessLifetimeSeconds, null);
  assert.equal(v.freshnessSource, "none");
  assert.ok(v.notes.some((n) => n.includes("unparseable")));
});

test("heuristic freshness is 10% of the time since Last-Modified", () => {
  const v = computeVerdict({
    lastModified: DATE,
    date: "Wed, 01 Jan 2025 02:46:40 GMT",
  });
  assert.equal(v.freshnessLifetimeSeconds, 1000);
  assert.equal(v.freshnessSource, "heuristic");
});

test("heuristic freshness needs Date to be after Last-Modified", () => {
  const v = computeVerdict({ lastModified: "Thu, 02 Jan 2025 00:00:00 GMT", date: DATE });
  assert.equal(v.freshnessLifetimeSeconds, null);
  assert.equal(v.freshnessSource, "none");
});

test("invalid max-age values are ignored", () => {
  for (const cc of ["max-age=abc", "max-age=-5", "max-age=1.5", "max-age"]) {
    const v = computeVerdict({ cacheControl: cc });
    assert.equal(v.freshnessSource, "none", cc);
    assert.equal(v.freshnessLifetimeSeconds, null, cc);
  }
});

test("a malformed Age header counts as zero", () => {
  const v = computeVerdict({ cacheControl: "max-age=60", age: "soon" });
  assert.equal(v.currentAgeSeconds, 0);
  assert.equal(v.remainingFreshSeconds, 60);
});

test("a response with no freshness info is flagged as immediately stale", () => {
  const v = computeVerdict({});
  assert.equal(v.freshnessLifetimeSeconds, null);
  assert.equal(v.remainingFreshSeconds, null);
  assert.ok(v.notes.some((n) => n.includes("already stale")));
});

test("no-cache is reported and suppresses the no-freshness note", () => {
  const v = computeVerdict({ cacheControl: "no-cache" });
  assert.equal(v.noCache, true);
  assert.equal(v.sharedCacheable, true);
  assert.ok(!v.notes.some((n) => n.includes("already stale")));
});

test("must-revalidate and proxy-revalidate both set mustRevalidateOnStale", () => {
  assert.equal(computeVerdict({ cacheControl: "must-revalidate" }).mustRevalidateOnStale, true);
  assert.equal(computeVerdict({ cacheControl: "proxy-revalidate" }).mustRevalidateOnStale, true);
  assert.equal(computeVerdict({ cacheControl: "max-age=5" }).mustRevalidateOnStale, false);
});

test("Authorization blocks shared caches by default", () => {
  const v = computeVerdict({ cacheControl: "max-age=60", requestHasAuthorization: true });
  assert.equal(v.sharedCacheable, false);
  assert.equal(v.privateCacheable, true);
});

test("public, s-maxage, or must-revalidate lift the Authorization restriction", () => {
  for (const cc of ["public, max-age=60", "s-maxage=60", "must-revalidate, max-age=60"]) {
    const v = computeVerdict({ cacheControl: cc, requestHasAuthorization: true });
    assert.equal(v.sharedCacheable, true, cc);
  }
});

test("statuses outside the default-cacheable set are not cacheable", () => {
  const v = computeVerdict({ cacheControl: "max-age=60", status: 500 });
  assert.equal(v.sharedCacheable, false);
  assert.equal(v.privateCacheable, false);
  assert.ok(v.notes.some((n) => n.includes("status 500")));
});

test("default-cacheable statuses pass through", () => {
  for (const status of [200, 301, 404]) {
    const v = computeVerdict({ status });
    assert.equal(v.sharedCacheable, true, String(status));
    assert.equal(v.privateCacheable, true, String(status));
  }
});
