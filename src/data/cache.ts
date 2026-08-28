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

const DB_NAME = "flyby";
const STORE = "tiles";
const DB_VERSION = 1;

export const TTL_STATIC = 30 * 24 * 3600 * 1000;
export const TTL_WEATHER = 10 * 60 * 1000;

interface Entry {
  url: string;
  at: number;
  body: ArrayBuffer;
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // A blocked upgrade would hang forever; treat it as "no cache".
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
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
        if (!e || Date.now() - e.at > ttl) resolve(null);
        else resolve(e.body);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cachePut(url: string, body: ArrayBuffer): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ url, at: Date.now(), body } satisfies Entry);
  } catch {
    // Quota exceeded or a closing DB. Losing a cache write is not an error the
    // caller can do anything about.
  }
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
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(url);
  } catch {
    // Nothing useful to do; the TTL will clear it eventually.
  }
}

export async function clearCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
}
