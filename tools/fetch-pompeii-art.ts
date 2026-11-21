// Fetches the Pompeian wall paintings and mosaics the town shows, once, from
// Wikimedia Commons into tools/.cache/pompeii-art/, with each file's author
// and licence. tools/bake-pompeii-art.ts restores and packs them.
//
//   bun tools/fetch-pompeii-art.ts                 (download every work in ART_SOURCES)
//   bun tools/fetch-pompeii-art.ts --search "cave canem"   (list candidates with licences)
//
// Only files whose Commons licence is public domain or CC BY / CC BY-SA are
// taken; the licence string is checked on every run, not trusted from the
// table, so a relicensed or deleted file fails here rather than shipping.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { ART_SOURCES } from "./pompeii-art-sources";

const API = "https://commons.wikimedia.org/w/api.php";
// A plain client name: no contact details go out with the requests.
const UA = "flyby-web-bake/0.1 (offline asset bake)";
const OUT = new URL("./.cache/pompeii-art/", import.meta.url).pathname;
/** Widest copy fetched (a Commons standard thumbnail step: other widths are refused with 429). */
const FETCH_W = 1920;

interface Info { title: string; url: string; thumb: string; width: number; height: number; licence: string; artist: string; page: string }

/** GET with backoff: Commons answers 429 to a burst and wants the client to wait. */
async function get(url: string): Promise<Response> {
  for (let k = 0; ; k++) {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (r.status !== 429 || k >= 6) {
      if (!r.ok) throw new Error(`commons ${r.status} for ${url}`);
      return r;
    }
    await Bun.sleep(2000 * 2 ** k);
  }
}

async function api(params: Record<string, string>): Promise<any> {
  return (await get(`${API}?${new URLSearchParams({ format: "json", ...params })}`)).json();
}

function strip(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function infoOf(p: any): Info | null {
  const i = p.imageinfo?.[0];
  if (!i) return null;
  const m = i.extmetadata ?? {};
  return {
    title: p.title, url: i.url, thumb: i.thumburl ?? i.url, width: i.width, height: i.height,
    licence: strip(m.LicenseShortName?.value ?? "?"), artist: strip(m.Artist?.value ?? "unknown").slice(0, 120),
    page: i.descriptionurl,
  };
}

const IIPROP = { prop: "imageinfo", iiprop: "url|size|extmetadata", iiextmetadatafilter: "LicenseShortName|Artist", iiurlwidth: String(FETCH_W) };

export function freeLicence(l: string): boolean {
  return /^(public domain|pd|cc0|cc by(-sa)? ?\d|cc-by(-sa)?-\d|attribution|gfdl)/i.test(l.trim()) && !/nc|nd/i.test(l);
}

async function search(terms: string): Promise<void> {
  const j = await api({ action: "query", generator: "search", gsrnamespace: "6", gsrlimit: "20", gsrsearch: terms, ...IIPROP });
  for (const p of Object.values<any>(j.query?.pages ?? {})) {
    const i = infoOf(p);
    if (i) console.log(`${i.width}x${i.height}\t${freeLicence(i.licence) ? "free" : "NOT "}\t${i.licence}\t${i.title}\t${i.artist.slice(0, 40)}`);
  }
}

async function main(): Promise<void> {
  const si = process.argv.indexOf("--search");
  if (si >= 0) return search(process.argv[si + 1]);
  mkdirSync(OUT, { recursive: true });
  const meta: Record<string, Info> = {};
  for (const s of ART_SOURCES) {
    const ask = async (w: number): Promise<Info | null> => {
      const j = await api({ action: "query", titles: s.file, ...IIPROP, iiurlwidth: String(w) });
      const p = Object.values<any>(j.query?.pages ?? {})[0];
      return p ? infoOf(p) : null;
    };
    let i = await ask(s.w ?? FETCH_W);
    // A width at or past the original's hands back the original file, which
    // the upload servers rate-limit far harder than a thumbnail: step down
    // to the largest standard width under it.
    if (i && i.width <= (s.w ?? FETCH_W)) {
      const step = [3840, 1920, 1280, 960, 500].find((w) => w < i!.width);
      if (step) i = await ask(step);
    }
    if (!i) throw new Error(`${s.id}: ${s.file} not on Commons`);
    if (!freeLicence(i.licence)) throw new Error(`${s.id}: ${s.file} is "${i.licence}", not a free licence`);
    meta[s.id] = i;
    const dest = `${OUT}${s.id}.jpg`;
    // A PNG's thumbnail comes back as PNG under the .jpg name; the baker
    // decodes through sips, which reads the bytes, not the extension.
    const fresh = !existsSync(dest);
    if (fresh) writeFileSync(dest, Buffer.from(await (await get(i.thumb)).arrayBuffer()));
    // Commons' upload servers answer 429 to anything faster than this.
    await Bun.sleep(fresh ? 6000 : 300);
    console.log(`${s.id.padEnd(22)} ${i.licence.padEnd(14)} ${i.width}x${i.height} ${i.title}`);
  }
  writeFileSync(`${OUT}meta.json`, JSON.stringify(meta, null, 1));
}

await main();
