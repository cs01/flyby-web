// Asking Overpass for OSM data from inside the page, politely.
//
// OVERPASS IS DONATED INFRASTRUCTURE AND THIS FILE IS THE ONLY THING BETWEEN IT
// AND EVERY READER OF THIS APP. The offline baker already got this project
// rate-limited off the public instances once, by running six city bakes back to
// back from one machine. A runtime path multiplies that by every open tab, so
// every restraint here is a requirement rather than a nicety:
//
//   * one request in flight, ever, and a minimum gap between them;
//   * a hard ceiling on how many an entire session may make;
//   * answers cached in IndexedDB with NO expiry, because an answer for a fixed
//     bbox is effectively immutable and re-asking is pure waste;
//   * concurrent askers for the same box share one request;
//   * 429 and 504 back off, and `Retry-After` is obeyed to the second;
//   * repeated failure trips a breaker and the session stops asking at all.
//
// It also NEVER THROWS. A failed or slow answer means "no buildings there yet",
// which is what the sky over most of the planet already looks like in this app.
// A flight that failed to load because a volunteer server was busy would be a
// far worse bug than a missing skyline.
//
// GET, not POST, and that is deliberate: the query then lives in the URL, which
// is exactly the key src/data/cache.ts stores under, so the cache and the
// dedupe both come out of the existing machinery instead of a second copy of it.

import { cacheGet, cachePut, TTL_FOREVER } from "./cache";

/**
 * The endpoints a BROWSER can use. Far shorter than the baker's list, and the
 * reason is CORS: overpass.kumi.systems and overpass.private.coffee answer the
 * baker fine but send no `Access-Control-Allow-Origin`, so a page cannot read
 * their responses at all. Measured, not assumed. overpass.osm.ch does send the
 * header and is NOT here: it carries Switzerland only, and answers everywhere
 * else with an empty element list, which is worse than an error because it
 * looks like a place with no buildings.
 *
 * `?overpass=<url>` overrides this, which is how the screenshot harness points
 * at a local replay of real responses instead of asking a volunteer server the
 * same question on every run.
 */
export const DEFAULT_ENDPOINTS: readonly string[] = [
  "https://overpass-api.de/api/interpreter",
];

/**
 * The waiting, in one object.
 *
 * Grouped and injectable because the gate has to test two different things
 * about it: that the SPACING is what it claims (which has to use the real
 * numbers, and costs the check a couple of seconds), and that the retry and
 * breaker CONTROL FLOW is right (which does not, and would otherwise cost the
 * check two and a half minutes of sleeping). A gate slow enough that people
 * stop running it is a gate that has stopped working.
 */
export interface OverpassTiming {
  /** Minimum wall time between two network requests, milliseconds. */
  minGapMs: number;
  /** First retry wait; doubles with each attempt. */
  backoffBaseMs: number;
  /** Give up on one request after this long. Overpass queues, so it is generous. */
  timeoutMs: number;
}

export const DEFAULT_TIMING: OverpassTiming = {
  minGapMs: 2000,
  backoffBaseMs: 4000,
  timeoutMs: 60_000,
};

/** Attempts per query before it is abandoned for the session. */
const MAX_ATTEMPTS = 3;
/** Consecutive failures that trip the breaker for the rest of the session. */
const BREAKER_AT = 4;
/**
 * Requests one page load may make, ever.
 *
 * A ceiling and not a rate: at a hundred knots a flight crosses a lot of tiles,
 * and "slow but unbounded" is still unbounded. Sixty tiles is ~200 km2 of city
 * around one flight, which is more than anyone looks at, and every one of them
 * is cached forever afterwards so the second visit spends none of this.
 */
const SESSION_BUDGET = 60;

export interface OverpassStats {
  /** Answers served from IndexedDB. */
  cacheHits: number;
  /** Answers that cost a request. */
  networkHits: number;
  /** Requests that failed after every attempt. */
  failures: number;
  /** Callers who joined a request already in flight. */
  deduped: number;
  /** Requests refused because the session budget or the breaker said no. */
  refused: number;
  /** Milliseconds each successful network request took. */
  latencyMs: number[];
  /** True once the breaker has tripped. */
  broken: boolean;
}

export class Overpass {
  readonly stats: OverpassStats = {
    cacheHits: 0,
    networkHits: 0,
    failures: 0,
    deduped: 0,
    refused: 0,
    latencyMs: [],
    broken: false,
  };

  private readonly endpoints: readonly string[];
  private readonly timing: OverpassTiming;
  private readonly inflight = new Map<string, Promise<unknown | null>>();
  /** Resolves when the previous request has finished AND the gap has elapsed. */
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  private consecutiveFailures = 0;
  private spent = 0;
  /** Wall-clock time before which nothing may be sent; set by `Retry-After`. */
  private holdUntil = 0;

  constructor(
    endpoints: readonly string[] = DEFAULT_ENDPOINTS,
    timing: Partial<OverpassTiming> = {},
  ) {
    this.endpoints = endpoints.length > 0 ? endpoints : DEFAULT_ENDPOINTS;
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  /** The URL a query is cached under. Stable for a stable query string. */
  url(query: string, endpoint = this.endpoints[0]): string {
    return `${endpoint}?data=${encodeURIComponent(query)}`;
  }

  /** True when this query is already answered locally, with no request needed. */
  async cached(query: string): Promise<boolean> {
    return (await cacheGet(this.url(query), TTL_FOREVER)) !== null;
  }

  /**
   * Run one Overpass query and parse it, or return null.
   *
   * Null means every one of "not cached and the budget is spent", "the breaker
   * is open", "the server said no" and "the answer was not JSON". The caller
   * treats all four the same way, because there is nothing useful it could do
   * differently: the ground stays as it was.
   */
  async json<T>(query: string): Promise<T | null> {
    const url = this.url(query);

    const existing = this.inflight.get(url);
    if (existing) {
      this.stats.deduped++;
      return (await existing) as T | null;
    }

    const p = this.run<T>(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, p as Promise<unknown | null>);
    return p;
  }

  private async run<T>(url: string): Promise<T | null> {
    const hit = await cacheGet(url, TTL_FOREVER);
    if (hit) {
      this.stats.cacheHits++;
      return decode<T>(hit);
    }

    if (this.stats.broken) {
      this.stats.refused++;
      return null;
    }
    if (this.spent >= SESSION_BUDGET) {
      this.stats.refused++;
      if (this.spent === SESSION_BUDGET) {
        this.spent++;
        console.warn(
          `[flyby] live OSM: session budget of ${SESSION_BUDGET} Overpass requests spent; ` +
            `no more will be made. Everything already fetched stays cached.`,
        );
      }
      return null;
    }
    this.spent++;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const endpoint = this.endpoints[attempt % this.endpoints.length];
      // The query travels in the cache URL, so a failover endpoint has to be
      // spliced back in rather than the whole URL being rebuilt from scratch.
      const target = endpoint + url.slice(url.indexOf("?data="));
      const outcome = await this.send(target);
      if (outcome.body) {
        const parsed = decode<T>(outcome.body);
        // Parse BEFORE caching, never after. An overloaded instance answers
        // with an HTML error page under a 200, and storing that under a
        // no-expiry key would blank that patch of ground permanently -- the
        // same trap fetchBytes already guards against for the app's own assets.
        if (parsed !== null) {
          this.consecutiveFailures = 0;
          void cachePut(url, outcome.body);
          return parsed;
        }
        console.warn("[flyby] live OSM: answer was not JSON (instance busy?)");
        this.holdUntil = Math.max(this.holdUntil, Date.now() + this.timing.backoffBaseMs * 2 ** attempt);
        continue;
      }
      if (outcome.fatal) break;
      // Exponential, from a base long enough that a busy instance has actually
      // had time to drain. Retry-After, when present, outranks it.
      const backoff = Math.max(outcome.retryAfterMs, this.timing.backoffBaseMs * 2 ** attempt);
      this.holdUntil = Math.max(this.holdUntil, Date.now() + backoff);
    }

    this.stats.failures++;
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= BREAKER_AT) {
      this.stats.broken = true;
      console.warn(
        `[flyby] live OSM: ${this.consecutiveFailures} Overpass requests failed in a row; ` +
          `not asking again this session.`,
      );
    }
    return null;
  }

  /**
   * One attempt, behind the rate limiter.
   *
   * The limiter is a promise chain rather than a timer: every send appends
   * itself to `queue`, so exactly one request is ever in flight and the gap is
   * measured from when the previous one FINISHED, not from when it started. A
   * gap measured from the start would let a queue of slow requests pile up.
   */
  private send(target: string): Promise<{
    body: ArrayBuffer | null;
    retryAfterMs: number;
    fatal: boolean;
  }> {
    const run = this.queue.then(async () => {
      const waitFor = Math.max(
        this.lastRequestAt + this.timing.minGapMs - Date.now(),
        this.holdUntil - Date.now(),
      );
      if (waitFor > 0) await sleep(waitFor);

      const t0 = performance.now();
      try {
        const res = await fetch(target, {
          mode: "cors",
          credentials: "omit",
          // No Accept header on purpose: it would make this a preflighted
          // request, and a preflight is a second round trip to a server this
          // file exists to be gentle with. Overpass answers a bare GET with
          // JSON whenever the query says `[out:json]`, which every query here
          // does.
          signal: AbortSignal.timeout(this.timing.timeoutMs),
        });
        this.lastRequestAt = Date.now();

        if (res.ok) {
          const body = await res.arrayBuffer();
          this.stats.networkHits++;
          this.stats.latencyMs.push(performance.now() - t0);
          return { body, retryAfterMs: 0, fatal: false };
        }

        const retry = Number(res.headers.get("Retry-After"));
        const retryAfterMs = Number.isFinite(retry) && retry > 0 ? retry * 1000 : 0;
        // 400 is a malformed query and will read identically on every retry.
        const fatal = res.status === 400;
        console.warn(`[flyby] live OSM: ${res.status} ${res.statusText}`);
        return { body: null, retryAfterMs, fatal };
      } catch (err) {
        this.lastRequestAt = Date.now();
        console.warn(`[flyby] live OSM: request failed:`, err);
        return { body: null, retryAfterMs: 0, fatal: false };
      }
    });
    // The chain must survive a rejection, or one failure stops every later
    // request forever. `run` already returns rather than throws, but the guard
    // costs nothing and the failure it prevents is silent and total.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function decode<T>(body: ArrayBuffer): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
