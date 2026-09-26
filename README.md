# cache-verdict

A question you end up asking a lot when debugging a slow site or a stale API
response: given these response headers, will this actually get cached, by
what, and for how long? The rules are scattered across `Cache-Control`,
`Expires`, `Age`, `Pragma`, and status code defaults, and they interact in
ways that aren't obvious from reading one header in isolation — `s-maxage`
silently overrides `max-age` but only for shared caches, `private` and
`no-cache` sound similar but mean almost opposite things, `no-store` beats
everything.

`cache-verdict` takes a set of response headers and prints the answer: will a
shared cache (CDN, corporate proxy) store this, will a private cache
(browser) store it, how long is it considered fresh, and what happens once it
goes stale. It implements the storage and freshness rules from RFC 9111
(the current HTTP caching spec, obsoleting RFC 7234).

## usage

Point it at a live URL:

```
$ cache-verdict https://example.com/
fetching https://example.com/ ...

shared caches (CDN, proxy):  may store
private caches (browser):    may store
freshness lifetime:          22h (source: max-age)
current age:                 3s
remaining fresh time:        22h
revalidate once stale:       optional
revalidate before every use:  no
```

Or feed it a raw header dump, e.g. from `curl -sI`:

```
$ curl -sI https://api.example.com/v1/widgets > headers.txt
$ cache-verdict --file headers.txt
```

Or pipe headers in directly:

```
$ curl -sI https://api.example.com/v1/widgets | cache-verdict --stdin
```

A response that looks cacheable at a glance but isn't, because of an
`Authorization` header on the request:

```
$ cache-verdict --file headers.txt --auth
shared caches (CDN, proxy):   must not store
private caches (browser):    may store
freshness lifetime:          5m (source: max-age)
...
notes:
  - Authorization on the request blocks shared caches unless public, s-maxage, or must-revalidate is set
```

## how the verdict is computed

- `no-store` on the response: nothing may store it, full stop.
- `private`: shared caches (CDN, proxy) must not store it; browsers still can.
- An `Authorization` header on the request blocks shared caches from storing
  the response, unless the response says `public`, sets `s-maxage`, or sets
  `must-revalidate`.
- Freshness lifetime is taken from the first of: `s-maxage` (shared caches
  only), `max-age`, `Expires` minus `Date`, or — if none of those are present
  — a heuristic of 10% of the time since `Last-Modified`, per the spec.
  Failing all of that, the response has no freshness information at all.
- `Age` (if present) is subtracted from the freshness lifetime to get
  remaining fresh time.
- `no-cache` doesn't block storage — it means the stored copy can never be
  used without revalidating with the origin first.
- `must-revalidate` / `proxy-revalidate` means once the response goes stale,
  it must not be served without successful revalidation (no serving stale
  under network trouble).

## install

No dependencies to install. Compile with your own `tsc`:

```
$ tsc
$ node dist/cli.js https://example.com/
```

Requires Node 18 or later (uses the built-in `fetch`).

## license

MIT, see [LICENSE](LICENSE).
