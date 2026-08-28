// The places you can fly to, nearest first, and clicking one points the
// aeroplane at it.
//
// The route panel answers "where am I being sent"; this answers "where could I
// go", which is the question somebody actually has when they arrive over a
// city they have never seen from the air. Sorted by distance rather than by
// fame, because at a hundred knots what is close is what is interesting.
//
// The rows are built ONCE and then only their text and classes change. This is
// refreshed several times a second with the aircraft moving, and rebuilding
// sixty rows of markup at that rate is a frame-time bill for nothing.

import { formatDistance } from "./units";

export interface PlaceRow {
  name: string;
  x: number;
  z: number;
  /** World height to hang the label at, above whatever is at x,z. */
  topY: number;
}

/** More than this and it stops being a list and becomes a directory. */
const MAX_ROWS = 14;

export class Places {
  private root: HTMLDivElement;
  private list: HTMLElement;
  private rows: { el: HTMLButtonElement; name: HTMLElement; dist: HTMLElement }[] = [];
  private places: PlaceRow[] = [];
  private active: string | null = null;

  constructor(parent: HTMLElement, private onPick: (p: PlaceRow) => void) {
    this.root = document.createElement("div");
    this.root.className = "hud hud-places collapsible";
    this.root.innerHTML = `<h2>Fly to</h2><div class="places-list"></div>`;
    this.list = this.root.querySelector(".places-list") as HTMLElement;
    parent.append(this.root);
    this.root.style.display = "none";
    // The heading collapses the panel on a phone, the same as the others.
    (this.root.querySelector("h2") as HTMLElement).addEventListener("click", () =>
      this.root.classList.toggle("open"),
    );
  }

  setVisible(on: boolean): void {
    this.root.style.display = on && this.places.length > 0 ? "" : "none";
  }

  setPlaces(places: PlaceRow[]): void {
    this.places = places.slice(0, MAX_ROWS);
    this.list.textContent = "";
    this.rows = [];
    for (const p of this.places) {
      const el = document.createElement("button");
      el.className = "place-row";
      const name = document.createElement("span");
      name.textContent = p.name;
      const dist = document.createElement("i");
      el.append(name, dist);
      el.addEventListener("click", () => this.onPick(p));
      this.list.append(el);
      this.rows.push({ el, name, dist });
    }
  }

  setActive(name: string | null): void {
    this.active = name;
  }

  /** Distances and the engaged marker. Called at the HUD's own cadence. */
  update(x: number, z: number): void {
    for (const [i, p] of this.places.entries()) {
      const r = this.rows[i];
      if (!r) continue;
      const label = formatDistance(Math.hypot(p.x - x, p.z - z));
      if (r.dist.textContent !== label) r.dist.textContent = label;
      r.el.classList.toggle("on", this.active === p.name);
    }
  }
}
