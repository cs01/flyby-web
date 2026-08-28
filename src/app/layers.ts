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
}

const KEY = "flyby.layers";

const DEFAULTS: LayerState = {
  landmarks: true,
  instruments: true,
  weather: true,
};

const ROWS: [keyof LayerState, string][] = [
  ["landmarks", "Landmarks"],
  ["instruments", "Instruments"],
  ["weather", "Weather"],
];

function load(): LayerState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<LayerState>;
    // Merged over the defaults rather than trusted: a stored object from an
    // older build is missing whatever has been added since, and a missing key
    // must mean "on" rather than "undefined".
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export class Layers {
  readonly state: LayerState;
  private root: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.state = load();
    this.root = document.createElement("div");
    this.root.className = "hud hud-layers";
    this.root.innerHTML =
      `<h2>Show</h2>` +
      ROWS.map(
        ([k, label]) =>
          `<label class="lyr"><input type="checkbox" data-k="${k}" /><span>${label}</span></label>`,
      ).join("");
    parent.append(this.root);

    for (const box of this.root.querySelectorAll<HTMLInputElement>("input[data-k]")) {
      const k = box.dataset.k as keyof LayerState;
      box.checked = this.state[k];
      box.addEventListener("change", () => {
        this.state[k] = box.checked;
        try {
          localStorage.setItem(KEY, JSON.stringify(this.state));
        } catch {
          // A preference that cannot be saved still holds for this session.
        }
      });
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
}
