// A small heading-up moving map, with a compass ring round it.
//
// It answers two questions the forward view cannot: which way is north, and
// what is BEHIND me. From a cockpit at 1000 ft over Midtown every direction
// looks like more Midtown, and the landmark list can tell you the Chrysler
// Building is 3 miles away without telling you it is over your shoulder.
//
// Heading-up rather than north-up, and the compass ring rotates instead of the
// map. A north-up map has to be mentally rotated before it can be used to
// steer, which is exactly the work the instrument is supposed to save; every
// aircraft moving map and every car navigation display is track-up for the same
// reason. North is still readable at a glance, because the N on the ring is
// where north actually is out of the window.
//
// Drawn on a 2D canvas rather than as DOM. It is a few thousand footprints
// redrawn ten times a second, which is one fillRect loop and nothing for the
// layout engine to do.

import type { CityPack } from "../data/citypack";
import type { PlaceRow } from "./places";

/** Metres from the aircraft to the edge of the map. */
const RANGE_M = 1400;

/** Redraws per second. The map is for orientation, not for aiming. */
const HZ = 10;

/** Device pixels across the map. CSS size is half this; see the DPR note below. */
const SIZE = 320;

export class Minimap {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  /** Footprint centroids, [x, z, halfSpan] triples, in world metres. */
  private buildings = new Float32Array(0);
  private places: PlaceRow[] = [];

  private lastDraw = 0;
  private visible = true;

  constructor(root: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "minimap";

    this.canvas = document.createElement("canvas");
    // Backed at 2x so the ring and the type stay sharp on a Retina panel. This
    // is fixed rather than devicePixelRatio-derived: the map is 160 CSS px and
    // 320 device px is enough for any panel, while a 3x phone would be paying
    // for 921 600 pixels of redraw ten times a second to no visible end.
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    this.root.append(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    root.append(this.root);
  }

  /**
   * Take the footprints once.
   *
   * Only buildings with some height: at this scale a two-storey terrace is a
   * dot the same size as a tower, and drawing every one of 187 000 Manhattan
   * footprints turns the map into a solid block of grey. Filtering to things
   * over 18 m leaves the street pattern legible, because in a dense city it is
   * the TALL buildings that line the avenues.
   */
  setCity(pack: CityPack): void {
    const keep: number[] = [];
    for (const b of pack.buildings) {
      const h = b.topM - b.baseM;
      if (h < 18) continue;
      // Half-span from the ring's own extent, so a tower block reads bigger
      // than a chimney rather than every footprint being one pixel.
      let maxR = 0;
      for (let i = 0; i < b.ring.length; i += 2) {
        const dx = b.ring[i] - b.cx;
        const dz = b.ring[i + 1] - b.cz;
        const r = Math.hypot(dx, dz);
        if (r > maxR) maxR = r;
      }
      keep.push(b.cx, b.cz, Math.min(maxR, 90));
    }
    this.buildings = new Float32Array(keep);
  }

  setPlaces(rows: PlaceRow[]): void {
    this.places = rows;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.style.display = v ? "block" : "none";
  }

  /** `headingDeg` is the aircraft's heading; 0 is north, 90 is east. */
  update(x: number, z: number, headingDeg: number, elapsed: number): void {
    if (!this.visible) return;
    if (elapsed - this.lastDraw < 1 / HZ) return;
    this.lastDraw = elapsed;
    this.draw(x, z, headingDeg);
  }

  private draw(acX: number, acZ: number, headingDeg: number): void {
    const g = this.ctx;
    const c = SIZE / 2;
    const scale = c / RANGE_M;
    // Heading-up: rotate the world by -heading. World -z is north, and the map
    // puts north up before this rotation, so a heading of 0 is the identity.
    const rot = (-headingDeg * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);

    g.clearRect(0, 0, SIZE, SIZE);

    // Dish.
    g.save();
    g.beginPath();
    g.arc(c, c, c - 10, 0, Math.PI * 2);
    g.fillStyle = "rgba(10, 16, 24, 0.72)";
    g.fill();
    g.clip();

    // Footprints. Screen +y is south once rotated, so world z maps to +y.
    g.fillStyle = "rgba(150, 170, 195, 0.5)";
    const b = this.buildings;
    for (let i = 0; i < b.length; i += 3) {
      const dx = b[i] - acX;
      const dz = b[i + 1] - acZ;
      if (Math.abs(dx) > RANGE_M || Math.abs(dz) > RANGE_M) continue;
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      const px = c + rx * scale;
      const py = c + rz * scale;
      const r = Math.max(1.2, b[i + 2] * scale);
      g.fillRect(px - r, py - r, r * 2, r * 2);
    }

    // Landmarks, nearest few only -- the list on screen already has the rest,
    // and a map with thirty labels on it is not a map.
    g.font = "500 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.textAlign = "center";
    for (const p of this.places.slice(0, 6)) {
      const dx = p.x - acX;
      const dz = p.z - acZ;
      if (Math.hypot(dx, dz) > RANGE_M) continue;
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      const px = c + rx * scale;
      const py = c + rz * scale;
      g.fillStyle = "rgba(102, 212, 255, 0.95)";
      g.beginPath();
      g.arc(px, py, 3.2, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // Range rings, at a third and two thirds.
    g.strokeStyle = "rgba(150, 170, 195, 0.16)";
    g.lineWidth = 1;
    for (const f of [0.34, 0.67]) {
      g.beginPath();
      g.arc(c, c, (c - 10) * f, 0, Math.PI * 2);
      g.stroke();
    }

    // Compass ring. It rotates; the map does not.
    g.strokeStyle = "rgba(150, 170, 195, 0.35)";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(c, c, c - 10, 0, Math.PI * 2);
    g.stroke();

    const marks: [string, number][] = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
    g.textBaseline = "middle";
    for (const [label, deg] of marks) {
      // Where that cardinal sits once the world is rotated heading-up.
      const a = ((deg - headingDeg) * Math.PI) / 180;
      const rx = c + Math.sin(a) * (c - 26);
      const ry = c - Math.cos(a) * (c - 26);
      g.fillStyle = label === "N" ? "rgba(255, 122, 102, 0.95)" : "rgba(190, 205, 225, 0.75)";
      g.font = label === "N" ? "700 15px ui-monospace, monospace" : "500 13px ui-monospace, monospace";
      g.fillText(label, rx, ry);
      // Tick.
      const t0 = c - 12;
      const t1 = c - 19;
      g.strokeStyle = label === "N" ? "rgba(255, 122, 102, 0.8)" : "rgba(150, 170, 195, 0.45)";
      g.lineWidth = label === "N" ? 2.5 : 1.5;
      g.beginPath();
      g.moveTo(c + Math.sin(a) * t0, c - Math.cos(a) * t0);
      g.lineTo(c + Math.sin(a) * t1, c - Math.cos(a) * t1);
      g.stroke();
    }

    // The aircraft, always at the centre, always pointing up. That IS the
    // instrument: everything else moves around it.
    g.fillStyle = "rgba(255, 255, 255, 0.95)";
    g.beginPath();
    g.moveTo(c, c - 9);
    g.lineTo(c + 6.5, c + 7);
    g.lineTo(c, c + 3.5);
    g.lineTo(c - 6.5, c + 7);
    g.closePath();
    g.fill();
  }
}
