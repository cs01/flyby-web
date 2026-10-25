// Shop signs: an atlas of fascia lettering the ground-storey shader picks from.
//
// A parade of shops read as a row of identical dark panels because nothing
// on the fascia said what each shop was. Real signage is mostly ONE WORD for
// what is sold, in whatever typeface the sign maker had, so the atlas is the
// generic trade names of each city's high street drawn in a spread of faces:
// no brand names, nothing a reader could tie to a real business.
//
// The words are pure data (signWords) so a test can read them without a DOM;
// the canvas half runs only in the browser.

import * as THREE from "three";
import { Region } from "./archetype";

/** Atlas layout: SIGN_COLS x SIGN_ROWS cells of SIGN_W x SIGN_H pixels. */
export const SIGN_COLS = 2;
export const SIGN_ROWS = 32;
export const SIGN_W = 512;
export const SIGN_H = 64;
export const SIGN_COUNT = SIGN_COLS * SIGN_ROWS;

const COMMON = [
  "DELI", "PIZZA", "NAILS", "PHARMACY", "BAR", "CAFE", "LAUNDROMAT", "BAKERY", "GROCERY",
  "CLEANERS", "HARDWARE", "FLORIST", "BARBER", "OPTICAL", "SHOES", "BOOKS", "SUSHI", "THAI",
  "NOODLES", "DINER", "MARKET", "WINE", "LIQUORS", "CELL PHONES", "LOCKSMITH", "TACOS",
  "TAILOR", "JEWELRY", "PET SUPPLY", "DENTIST", "BANK", "HOTEL",
];
const BY_REGION: Record<number, string[]> = {
  [Region.NYC]: ["BAGELS", "BODEGA", "HALAL", "DELI & GROCERY", "PIZZERIA", "WINES & LIQUORS", "CHECK CASHING", "SHOE REPAIR"],
  [Region.SF]: ["TAQUERIA", "DIM SUM", "BURRITOS", "COFFEE", "BOBA TEA", "PHO", "CANNABIS", "BIKES"],
  [Region.Chicago]: ["HOT DOGS", "ITALIAN BEEF", "TAVERN", "GYROS", "PACKAGED GOODS", "TAQUERIA", "PIEROGI", "LOUNGE"],
};

/**
 * SIGN_COUNT words for a region: its own trades first, then the common list,
 * repeated in a second face so every word exists in two styles.
 */
export function signWords(region: Region): string[] {
  const pool = [...(BY_REGION[region] ?? []), ...COMMON];
  const out: string[] = [];
  for (let i = 0; out.length < SIGN_COUNT; i++) out.push(pool[i % pool.length]);
  return out;
}

/** The faces a sign painter or a vinyl cutter actually reaches for. */
const FACES = [
  "bold 46px Helvetica, Arial, sans-serif",
  "bold 46px Georgia, 'Times New Roman', serif",
  "44px Impact, 'Arial Black', sans-serif",
  "bold 42px 'Courier New', monospace",
  "italic bold 46px Georgia, serif",
  "bold 40px 'Arial Narrow', 'Helvetica Neue', sans-serif",
];

const atlases = new Map<Region, THREE.Texture>();

/**
 * The atlas as a texture: white lettering in the alpha channel, mipmapped so a
 * sign seen from down the street converges to its own mean ink instead of
 * sparkling. Null without a DOM.
 */
export function buildSignAtlas(region: Region): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  // One per region for the life of the page: a streamed city builds a
  // Buildings per tile, and a 1024 x 2048 canvas per tile would be the
  // single largest allocation on the live path.
  const have = atlases.get(region);
  if (have) return have;
  const canvas = document.createElement("canvas");
  canvas.width = SIGN_W * SIGN_COLS;
  canvas.height = SIGN_H * SIGN_ROWS;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const words = signWords(region);
  for (let i = 0; i < SIGN_COUNT; i++) {
    const cx = (i % SIGN_COLS) * SIGN_W + SIGN_W / 2;
    const cy = Math.floor(i / SIGN_COLS) * SIGN_H + SIGN_H / 2;
    g.font = FACES[(i * 7 + Math.floor(i / SIGN_COLS)) % FACES.length];
    const w = g.measureText(words[i]).width;
    // Fit the cell with a margin; a short word stays at its own size rather
    // than being stretched, which is how a real fascia is lettered.
    const k = Math.min(1, (SIGN_W * 0.9) / Math.max(w, 1));
    g.save();
    g.translate(cx, cy);
    g.scale(k, 1);
    g.fillText(words[i], 0, 2);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  atlases.set(region, tex);
  return tex;
}
