// One IndexedDB store for every tile the app fetches, plus the in-flight
// dedupe that keeps a quadtree from asking for the same DEM tile eight times
// in one frame.
//
// The cache is keyed by full URL and stores the raw bytes, so a DEM tile, a
// JPEG and a city pack all share one code path. Entries carry a fetch time and
// a per-kind TTL: imagery and terrain are effectively immutable (30 days),
// weather is deliberately short (10 minutes) so a reload after lunch shows the
// afternoon's sky rather than the morning's.
//
// Every failure path here degrades to a plain network fetch. A browser in
// private mode with IndexedDB blocked must still fly.
//
// The store is BUDGETED and evicts least-recently-used. Without that, a moving
// detail ring at zoom 18 writes tiles forever, IndexedDB hits its quota, and
// every subsequent put throws QuotaExceeded, which this file deliberately
// swallows. The failure mode is invisible and permanent: the cache stops
// caching and every flight goes back to the network, with nothing in the log to
// say why. A budget with eviction is what keeps a full cache a WORKING cache.
//
// Sizes live in a separate `index` store rather than alongside the bodies,
// because totalling the cache must not mean reading every tile body back out.

const DB_NAME = "flyby";
const STORE = "tiles";
const INDEX_STORE = "index";
const DB_VERSION = 2;

export const TTL_STATIC = 30 * 24 * 3600 * 1000;
export const TTL_WEATHER = 10 * 60 * 1000;

/** Ceiling when the browser will not say how much room there is. */
const FALLBACK_BUDGET = 512 * 1024 * 1024;
/** Never take more than this share of the origin's reported quota. */
const QUOTA_SHARE = 0.4;
/** Evict down to this share of budget, so eviction is rare and batched. */
const EVICT_TO = 0.8;

/** An `at` refresh costs a write, so only do it once a tile's stamp is stale. */
const LRU_REFRESH_MS = 12 * 3600 * 1000;

interface Entry {
  url: string;
  at: number;
  body: ArrayBuffer;
}

interface IndexEntry {
  url: string;
  at: number;
  size: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "url" });
      // A v1 database has bodies but no size index, so its entries could never
      // be accounted for and therefore never evicted. Dropping them is cheaper
      // and far less error-prone than back-filling; they refetch on demand.
      if (req.transaction && db.objectStoreNames.contains(STORE)) {
        req.transaction.objectStore(STORE).clear();
      }
      if (!db.objectStoreNames.contains(INDEX_STORE)) {
        const idx = db.createObjectStore(INDEX_STORE, { keyPath: "url" });
        // Eviction walks oldest-first, which is only cheap with an index.
        idx.createIndex("at", "at");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // A blocked upgrade would hang forever; treat it as "no cache".
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/**
 * Total bytes held, and the ceiling. Both are resolved once, lazily, because
 * the budget needs an async quota estimate and the total needs a cursor walk.
 */
let budgetPromise: Promise<{ budget: number; total: number }> | null = null;

function accounting(db: IDBDatabase): Promise<{ budget: number; total: number }> {
  if (budgetPromise) return budgetPromise;
  budgetPromise = (async () => {
    // Ask the browser to keep this origin's storage rather than evicting it
    // under pressure. It may say no, which costs nothing.
    try {
      await navigator.storage?.persist?.();
    } catch {
      // Not available, or blocked by policy. The cache still works.
    }

    let budget = FALLBACK_BUDGET;
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota) budget = Math.max(64 * 1024 * 1024, est.quota * QUOTA_SHARE);
    } catch {
      // Keep the fallback.
    }

    const total = await new Promise<number>((resolve) => {
      try {
        const tx = db.transaction(INDEX_STORE, "readonly");
        const req = tx.objectStore(INDEX_STORE).getAll();
        req.onsuccess = () =>
          resolve((req.result as IndexEntry[]).reduce((n, e) => n + e.size, 0));
        req.onerror = () => resolve(0);
      } catch {
        resolve(0);
      }
    });

    return { budget, total };
  })();
  return budgetPromise;
}

/**
 * Drop least-recently-used entries until the store is back under `EVICT_TO` of
 * budget. Walks the `at` index oldest-first, deleting the body and its index
 * row together so the two stores cannot drift apart.
 */
async function evictTo(db: IDBDatabase, acc: { budget: number; total: number }): Promise<void> {
  const target = acc.budget * EVICT_TO;
  if (acc.total <= target) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction([STORE, INDEX_STORE], "readwrite");
      const idx = tx.objectStore(INDEX_STORE);
      const bodies = tx.objectStore(STORE);
      const cur = idx.index("at").openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || acc.total <= target) {
          resolve();
          return;
        }
        const e = c.value as IndexEntry;
        bodies.delete(e.url);
        idx.delete(e.url);
        acc.total -= e.size;
        c.continue();
      };
      cur.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function cacheGet(url: string, ttl: number): Promise<ArrayBuffer | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(url);
      req.onsuccess = () => {
        const e = req.result as Entry | undefined;
        if (!e || Date.now() - e.at > ttl) {
          resolve(null);
          return;
        }
        // Mark it recently used, but only once the stamp has gone stale. A
        // write on every hit would turn the read path into a write path and
        // cost more than the eviction accuracy is worth.
        if (Date.now() - e.at > LRU_REFRESH_MS) void touch(url);
        resolve(e.body);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Refresh an entry's LRU stamp in both stores. Best effort. */
async function touch(url: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([STORE, INDEX_STORE], "readwrite");
    const at = Date.now();
    const bodies = tx.objectStore(STORE);
    const get = bodies.get(url);
    get.onsuccess = () => {
      const e = get.result as Entry | undefined;
      if (e) bodies.put({ ...e, at } satisfies Entry);
    };
    const idx = tx.objectStore(INDEX_STORE);
    const gi = idx.get(url);
    gi.onsuccess = () => {
      const e = gi.result as IndexEntry | undefined;
      if (e) idx.put({ ...e, at } satisfies IndexEntry);
    };
  } catch {
    // A stale LRU stamp only makes eviction slightly less well informed.
  }
}

async function cachePut(url: string, body: ArrayBuffer): Promise<void> {
  const db = await openDb();
  if (!db) return;

  // A single body larger than the whole budget would evict everything else and
  // still not fit, so it is never worth storing.
  const acc = await accounting(db);
  if (body.byteLength > acc.budget) return;

  try {
    const at = Date.now();
    const tx = db.transaction([STORE, INDEX_STORE], "readwrite");
    tx.objectStore(STORE).put({ url, at, body } satisfies Entry);
    const idx = tx.objectStore(INDEX_STORE);
    // Replacing an existing entry must not double-count it.
    const prev = idx.get(url);
    prev.onsuccess = () => {
      const e = prev.result as IndexEntry | undefined;
      if (e) acc.total -= e.size;
    };
    idx.put({ url, at, size: body.byteLength } satisfies IndexEntry);
    acc.total += body.byteLength;
  } catch {
    // Quota exceeded or a closing DB. Losing a cache write is not an error the
    // caller can do anything about.
    return;
  }

  if (acc.total > acc.budget) await evictTo(db, acc);
}

const inflight = new Map<string, Promise<ArrayBuffer>>();

/**
 * Fetch `url` as bytes, through the cache, deduping concurrent callers.
 * Throws only if the network itself fails and there is nothing cached.
 */
export function fetchBytes(url: string, ttl = TTL_STATIC): Promise<ArrayBuffer> {
  const existing = inflight.get(url);
  if (existing) return existing;

  const p = (async () => {
    const hit = await cacheGet(url, ttl);
    if (hit) return hit;
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);

    // A 200 is not proof the response is the thing that was asked for.
    //
    // A dev server (and most static hosts) answer a missing path with the SPA
    // fallback: 200, and an HTML page. Caching that poisons the entry for the
    // full 30-day TTL, so the asset stays broken long after it exists -- which
    // is exactly what happened to the first city pack. Reject HTML for any
    // request that did not ask for a page, and reject it BEFORE the cache write.
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/html") && !/\.html?($|\?)/.test(url)) {
      throw new Error(`${url} returned an HTML page, not an asset (likely a 404 served as the app shell)`);
    }

    const body = await res.arrayBuffer();
    void cachePut(url, body);
    return body;
  })().finally(() => inflight.delete(url));

  inflight.set(url, p);
  return p;
}

export async function fetchJson<T>(url: string, ttl = TTL_STATIC): Promise<T> {
  const buf = await fetchBytes(url, ttl);
  return JSON.parse(new TextDecoder().decode(buf)) as T;
}

/** Decode bytes to an ImageBitmap, which uploads to a GPU texture directly. */
export async function fetchImage(url: string, ttl = TTL_STATIC): Promise<ImageBitmap> {
  const buf = await fetchBytes(url, ttl);
  return createImageBitmap(new Blob([buf]));
}

/**
 * Drop one entry. Called when a cached response turns out to be unusable, so a
 * single reload recovers instead of the bad copy persisting for its whole TTL.
 */
export async function evict(url: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([STORE, INDEX_STORE], "readwrite");
    tx.objectStore(STORE).delete(url);
    tx.objectStore(INDEX_STORE).delete(url);
    // The running total is now an overestimate, which only makes eviction
    // slightly eager. It is corrected on the next page load.
  } catch {
    // Nothing useful to do; the TTL will clear it eventually.
  }
}

export async function clearCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction([STORE, INDEX_STORE], "readwrite");
  tx.objectStore(STORE).clear();
  tx.objectStore(INDEX_STORE).clear();
  budgetPromise = null;
}
