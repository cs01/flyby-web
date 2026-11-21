// What is drawn over the picture, and a way to turn any of it off.
//
// Everything this app knows how to say is optional, because the reason to be
// here is the view and every panel is standing in front of some of it. The
// defaults are all on: someone arriving has to be told what the app can do
// before they can decide they do not want it.
//
// Remembered in localStorage rather than the URL, for the same reason the
// temperature unit is: it is a property of the reader, not of the flight, and
// a shared link should not impose the sender's idea of a clean screen.

export interface LayerState {
  landmarks: boolean;
  instruments: boolean;
  weather: boolean;
  traffic: boolean;
  trains: boolean;
  boats: boolean;
  /** The moving map. Only ever drawn in the air on a phone. */
  map: boolean;
}

const KEY = "flyby.layers";

const DEFAULTS: LayerState = {
  landmarks: true,
  instruments: true,
  weather: true,
  traffic: true,
  trains: true,
  boats: true,
  map: true,
};

const ROWS: [keyof LayerState, string][] = [
  ["landmarks", "Landmarks"],
  ["instruments", "Instruments"],
  ["map", "Map"],
  ["weather", "Weather"],
  ["traffic", "Live traffic"],
  ["trains", "Trains"],
  ["boats", "Boats"],
];

function load(key: string, defaults: LayerState): LayerState {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<LayerState>;
    // Merged over the defaults rather than trusted: a stored object from an
    // older build is missing whatever has been added since, and a missing key
    // must mean the default rather than "undefined".
    return { ...defaults, ...parsed };
  } catch {
    return { ...defaults };
  }
}

export class Layers {
  readonly state: LayerState;
  readonly root: HTMLDivElement;

  /**
   * `phone` stores under its own key with the flight instruments off: the
   * six-pack is most of a phone screen, and a state saved by an older build
   * (which hid it with a clean-view switch instead) must not turn it on.
   */
  constructor(parent: HTMLElement, phone = false) {
    const key = phone ? `${KEY}.phone` : KEY;
    this.state = load(key, phone ? { ...DEFAULTS, instruments: false } : DEFAULTS);
    this.root = document.createElement("div");
    this.root.className = "hud hud-layers";
    this.root.innerHTML =
      `<h2>Show</h2>` +
      ROWS.map(
        ([k, label]) =>
          `<label class="lyr" data-row="${k}"><input type="checkbox" data-k="${k}" /><span>${label}</span></label>`,
      ).join("");
    parent.append(this.root);

    for (const box of this.root.querySelectorAll<HTMLInputElement>("input[data-k]")) {
      const k = box.dataset.k as keyof LayerState;
      box.checked = this.state[k];
      box.addEventListener("change", () => {
        this.state[k] = box.checked;
        try {
          localStorage.setItem(key, JSON.stringify(this.state));
        } catch {
          // A preference that cannot be saved still holds for this session.
        }
      });
    }
    // The desktop has its map in a fixed corner and no switch for it.
    if (!phone) this.setApplicable({ map: false });
  }

  /**
   * Hide the switches for things this place does not have: Pompeii has no
   * aircraft, trains or boats, and a switch that does nothing is clutter.
   */
  setApplicable(on: Partial<Record<keyof LayerState, boolean>>): void {
    for (const row of this.root.querySelectorAll<HTMLElement>("[data-row]")) {
      const k = row.dataset.row as keyof LayerState;
      if (!(k in on)) continue;
      const want = on[k] ? "" : "none";
      if (row.style.display !== want) row.style.display = want;
    }
  }

  get landmarks(): boolean {
    return this.state.landmarks;
  }
  get instruments(): boolean {
    return this.state.instruments;
  }
  get weather(): boolean {
    return this.state.weather;
  }
  get traffic(): boolean {
    return this.state.traffic;
  }
  get trains(): boolean {
    return this.state.trains;
  }
  get boats(): boolean {
    return this.state.boats;
  }
  get map(): boolean {
    return this.state.map;
  }
}
