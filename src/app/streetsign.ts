// The street sign: what you are driving on, and what you are coming to.
//
// Driving was the one mode with no way to know where you were. The aeroplane
// has a compass, an altimeter and a list of landmarks; the car had a road under
// it and no name for it, which is the one piece of information a driver
// actually navigates by.
//
// Bottom centre, over the instrument strip, because that is where a driver
// already looks for speed. Not a label in the world: a street name floating on
// a junction is a map, and this is a windscreen.
//
// Nothing is rebuilt per frame. The text is compared before it is written,
// because this is fed at 60 Hz and setting textContent invalidates layout even
// when the string has not changed.

import type { StreetSign } from "../data/streetsign";
import { formatDistance } from "./units";

export class StreetSignHud {
  private root: HTMLDivElement;
  private street: HTMLElement;
  private ahead: HTMLElement;
  private shownStreet = " ";
  private shownAhead = " ";

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "street-sign";
    this.root.style.display = "none";
    this.root.innerHTML = "<b></b><span></span>";
    this.street = this.root.firstElementChild as HTMLElement;
    this.ahead = this.root.lastElementChild as HTMLElement;
    parent.append(this.root);
  }

  /**
   * `null` hides it, which is every mode that is not the car.
   *
   * An unnamed road shows nothing rather than a placeholder. Most of what OSM
   * has is service roads and alleys with no name, and a sign reading "unnamed
   * road" every time you turn into a car park is worse than a sign that knows
   * when to be quiet.
   */
  update(sign: StreetSign | null): void {
    const on = sign !== null && sign.street !== "";
    if (this.root.style.display !== (on ? "" : "none")) {
      this.root.style.display = on ? "" : "none";
    }
    if (!on || sign === null) return;

    if (this.shownStreet !== sign.street) {
      this.shownStreet = sign.street;
      this.street.textContent = sign.street;
    }
    const ahead =
      sign.cross === "" ? "" : `${formatDistance(sign.crossM)} to ${sign.cross}`;
    if (this.shownAhead !== ahead) {
      this.shownAhead = ahead;
      this.ahead.textContent = ahead;
      this.ahead.style.display = ahead === "" ? "none" : "";
    }
  }
}
