// Plane, drone or car, one tap each.
//
// The machines already existed behind V and G, and behind CAR on the touch
// button column, but a phone in clean view hides that column, and a key
// nobody knows about is not a feature. The owner asked for an easy way to
// choose, especially on a phone, after finding that at speed there was no way
// down into the streets. This is that: three words at the bottom of the screen.

export type Machine = "plane" | "drone" | "car";

const LABELS: [Machine, string][] = [["plane", "plane"], ["drone", "drone"], ["car", "car"]];

export class ModeBar {
  private root: HTMLDivElement;
  private buttons = new Map<Machine, HTMLButtonElement>();
  private pending: Machine | null = null;

  constructor(ui: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "modebar";
    for (const [m, label] of LABELS) {
      const b = document.createElement("button");
      b.textContent = label;
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
