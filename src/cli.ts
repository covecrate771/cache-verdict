#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { computeVerdict, type CacheInputs, type Verdict } from "./core.js";

function parseHeaderDump(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!name) continue;
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function inputsFromHeaders(headers: Record<string, string>, status?: number, auth?: boolean): CacheInputs {
  return {
    cacheControl: headers["cache-control"],
    expires: headers["expires"],
    date: headers["date"],
    age: headers["age"],
    lastModified: headers["last-modified"],
    vary: headers["vary"],
    status,
    requestHasAuthorization: auth,
  };
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function printVerdict(v: Verdict): void {
  console.log("shared caches (CDN, proxy):", v.sharedCacheable ? "may store" : "must not store");
  console.log("private caches (browser):  ", v.privateCacheable ? "may store" : "must not store");

  if (v.freshnessLifetimeSeconds === null) {
    console.log("freshness lifetime:         none declared");
  } else {
    console.log(
      `freshness lifetime:         ${formatSeconds(v.freshnessLifetimeSeconds)} (source: ${v.freshnessSource})`
    );
    console.log(`current age:                ${formatSeconds(v.currentAgeSeconds)}`);
    const remaining = v.remainingFreshSeconds ?? 0;
    console.log(
      `remaining fresh time:       ${remaining > 0 ? formatSeconds(remaining) : "0s (stale)"}`
    );
  }

  console.log("revalidate once stale:      ", v.mustRevalidateOnStale ? "required (must-revalidate)" : "optional");
  console.log("revalidate before every use:", v.noCache ? "yes (no-cache)" : "no");

  if (v.notes.length) {
    console.log("\nnotes:");
    for (const note of v.notes) console.log(`  - ${note}`);
  }
}

async function fetchHeaders(url: string): Promise<{ headers: Record<string, string>; status: number }> {
  const res = await fetch(url, { method: "GET", redirect: "manual" });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  // Node's fetch fully reads the stream on GC otherwise; drain and discard the body.
  await res.arrayBuffer().catch(() => undefined);
  return { headers, status: res.status };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "cache-verdict — will this HTTP response be cached, and for how long?",
        "",
        "usage:",
        "  cache-verdict <url>              fetch a URL and inspect its response headers",
        "  cache-verdict --file <path>      read a raw header dump (e.g. curl -sI output)",
        "  cache-verdict --stdin            read a raw header dump from stdin",
        "",
        "flags:",
        "  --auth   pretend the request carried an Authorization header",
      ].join("\n")
    );
    return;
  }

  let headers: Record<string, string>;
  let status: number | undefined;
  const auth = args.includes("--auth");

  if (args[0] === "--file") {
    const path = args[1];
    if (!path) throw new Error("--file requires a path");
    headers = parseHeaderDump(readFileSync(path, "utf8"));
  } else if (args[0] === "--stdin") {
    headers = parseHeaderDump(await readStdin());
  } else {
    const url = args[0];
    console.log(`fetching ${url} ...\n`);
    const result = await fetchHeaders(url);
    headers = result.headers;
    status = result.status;
  }

  const verdict = computeVerdict(inputsFromHeaders(headers, status, auth));
  printVerdict(verdict);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
