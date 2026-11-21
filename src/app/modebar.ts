// Walk, car, drone or plane, one tap each.
//
// The machines already existed behind V and G, and behind CAR on the touch
// button column, but a phone in clean view hides that column, and a key
// nobody knows about is not a feature. The owner asked for an easy way to
// choose, especially on a phone, after finding that at speed there was no way
// down into the streets. This is that: a segmented switch at the bottom of the
// screen, walking first because every city now starts on foot.

export type Machine = "plane" | "drone" | "car" | "walk";

const LABELS: [Machine, string][] = [["walk", "walk"], ["car", "car"], ["drone", "drone"], ["plane", "plane"]];

// 24-unit line icons, drawn with currentColor so the on state recolours them.
const ICONS: Record<Machine | "cart", string> = {
  walk: `<circle cx="12" cy="4.5" r="2"/><path d="M12 7.5v6l-3.5 7M12 13.5l3.5 7M7.5 11l4.5-2.5 4.5 2.5"/>`,
  car: `<path d="M3.5 15.5h17v-3.5l-2.5-5h-12l-2.5 5z"/><circle cx="7.5" cy="17" r="1.6"/><circle cx="16.5" cy="17" r="1.6"/>`,
  cart: `<circle cx="9" cy="15" r="5"/><path d="M9 10v10M4 15h10M14 11h7"/>`,
  drone: `<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 8l8 8M16 8l-8 8"/>`,
  plane: `<path d="M12 2.5v19M3.5 12l8.5-2.5 8.5 2.5M8.5 20l3.5-1.2 3.5 1.2"/>`,
};

export class ModeBar {
  readonly root: HTMLDivElement;
  private buttons = new Map<Machine, HTMLButtonElement>();
  private pending: Machine | null = null;

  /** `rename` relabels a machine: Pompeii's car is a cart. */
  constructor(ui: HTMLElement, rename?: Partial<Record<Machine, string>>) {
    this.root = document.createElement("div");
    this.root.className = "modebar";
    for (const [m, label] of LABELS) {
      const b = document.createElement("button");
      const text = rename?.[m] ?? label;
      const icon = ICONS[text === "cart" ? "cart" : m];
      b.innerHTML =
        `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>` +
        `<span>${text}</span>`;
      b.setAttribute("aria-label", text);
      b.addEventListener("click", () => (this.pending = m));
      this.buttons.set(m, b);
      this.root.append(b);
    }
    ui.append(this.root);
  }

  /** The machine the user tapped since the last call, or null. */
  take(): Machine | null {
    const m = this.pending;
    this.pending = null;
    return m;
  }

  update(active: Machine, visible: boolean): void {
    this.root.style.display = visible ? "" : "none";
    for (const [m, b] of this.buttons) b.classList.toggle("on", m === active);
  }
}
