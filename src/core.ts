// Core cache-freshness logic, following RFC 9111 (HTTP Caching).
// No network or filesystem access here — pure functions over header strings,
// so the CLI, a future web form, or tests can all drive it the same way.

export interface CacheInputs {
  cacheControl?: string;
  expires?: string;
  date?: string;
  age?: string;
  lastModified?: string;
  vary?: string;
  status?: number;
  requestHasAuthorization?: boolean;
}

export type FreshnessSource = "s-maxage" | "max-age" | "expires" | "heuristic" | "none";

export interface Verdict {
  sharedCacheable: boolean;
  privateCacheable: boolean;
  freshnessLifetimeSeconds: number | null;
  freshnessSource: FreshnessSource;
  currentAgeSeconds: number;
  remainingFreshSeconds: number | null;
  mustRevalidateOnStale: boolean;
  noCache: boolean;
  notes: string[];
}

// Statuses the spec allows caches to store by default, absent explicit
// freshness info. Anything else needs an explicit Cache-Control/Expires
// to be cached at all (RFC 9111 §3).
const DEFAULT_CACHEABLE_STATUSES = new Set([200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501]);

export function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of input) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === separator && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

export function parseCacheControl(header: string | undefined): Map<string, string | true> {
  const directives = new Map<string, string | true>();
  if (!header) return directives;
  for (const rawPart of splitTopLevel(header, ",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) {
      directives.set(part.toLowerCase(), true);
      continue;
    }
    const name = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    directives.set(name, value);
  }
  return directives;
}

function parsePositiveInt(value: string | true | undefined): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return parseInt(value, 10);
}

export function computeVerdict(input: CacheInputs): Verdict {
  const cc = parseCacheControl(input.cacheControl);
  const notes: string[] = [];

  const noStore = cc.has("no-store");
  const isPrivate = cc.has("private");
  const isPublic = cc.has("public");
  const noCache = cc.has("no-cache");
  const mustRevalidate = cc.has("must-revalidate") || cc.has("proxy-revalidate");

  let sharedCacheable = true;
  let privateCacheable = true;

  if (noStore) {
    sharedCacheable = false;
    privateCacheable = false;
    notes.push("no-store forbids storage by any cache");
  }

  if (isPrivate) {
    sharedCacheable = false;
    notes.push("private forbids storage by shared caches; browser/private caches may still store it");
  }

  const sMaxAge = parsePositiveInt(cc.get("s-maxage"));
  if (
    input.requestHasAuthorization &&
    !isPublic &&
    sMaxAge === null &&
    !mustRevalidate
  ) {
    sharedCacheable = false;
    notes.push("Authorization on the request blocks shared caches unless public, s-maxage, or must-revalidate is set");
  }

  if (input.status !== undefined && !DEFAULT_CACHEABLE_STATUSES.has(input.status)) {
    sharedCacheable = false;
    privateCacheable = false;
    notes.push(`status ${input.status} is not cacheable by default; would need explicit freshness directives`);
  }

  let freshnessLifetimeSeconds: number | null = null;
  let freshnessSource: FreshnessSource = "none";

  const maxAge = parsePositiveInt(cc.get("max-age"));

  if (sMaxAge !== null) {
    freshnessLifetimeSeconds = sMaxAge;
    freshnessSource = "s-maxage";
    notes.push("s-maxage governs shared caches and overrides max-age/Expires for them");
  } else if (maxAge !== null) {
    freshnessLifetimeSeconds = maxAge;
    freshnessSource = "max-age";
  } else if (input.expires) {
    const expiresMs = Date.parse(input.expires);
    const dateMs = input.date ? Date.parse(input.date) : Date.now();
    if (!Number.isNaN(expiresMs) && !Number.isNaN(dateMs)) {
      freshnessLifetimeSeconds = Math.round((expiresMs - dateMs) / 1000);
      freshnessSource = "expires";
    } else {
      notes.push("Expires header present but unparseable; ignoring it");
    }
  } else if (input.lastModified && input.date) {
    const lastModMs = Date.parse(input.lastModified);
    const dateMs = Date.parse(input.date);
    if (!Number.isNaN(lastModMs) && !Number.isNaN(dateMs) && dateMs > lastModMs) {
      freshnessLifetimeSeconds = Math.round((dateMs - lastModMs) / 10 / 1000);
      freshnessSource = "heuristic";
      notes.push("no explicit freshness directive; using the RFC 9111 heuristic of 10% of time since Last-Modified");
    }
  }

  if (freshnessLifetimeSeconds !== null && freshnessLifetimeSeconds < 0) {
    freshnessLifetimeSeconds = 0;
  }

  const currentAgeSeconds = parsePositiveInt(input.age) ?? 0;
  const remainingFreshSeconds =
    freshnessLifetimeSeconds === null ? null : freshnessLifetimeSeconds - currentAgeSeconds;

  if (noCache) {
    notes.push("no-cache allows storage but forbids using the stored copy without revalidating with the origin");
  }

  if (freshnessLifetimeSeconds === null && !noCache && (sharedCacheable || privateCacheable)) {
    notes.push("no freshness information at all; a cache may still store this but must treat it as already stale");
  }

  return {
    sharedCacheable,
    privateCacheable,
    freshnessLifetimeSeconds,
    freshnessSource,
    currentAgeSeconds,
    remainingFreshSeconds,
    mustRevalidateOnStale: mustRevalidate,
    noCache,
    notes,
  };
}
