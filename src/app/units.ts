// Which temperature scale the reader uses.
//
// Fahrenheit by default, which is a choice about the audience rather than
// about the units: the app is in English, most of its readers are American,
// and the number they want is the one they can feel without converting. It is
// one tap to change and the choice is remembered.
//
// localStorage rather than the URL: it is a preference, not a property of the
// flight, and a shared link should show the recipient THEIR units. Every
// access is wrapped, because a browser with site data blocked throws on the
// accessor itself rather than returning null.

export type Units = "f" | "c";

const KEY = "flyby.units";

let cached: Units | null = null;

export function getUnits(): Units {
  if (cached) return cached;
  try {
    cached = localStorage.getItem(KEY) === "c" ? "c" : "f";
  } catch {
    cached = "f";
  }
  return cached;
}

export function setUnits(u: Units): void {
  cached = u;
  try {
    localStorage.setItem(KEY, u);
  } catch {
    // A preference that cannot be saved is still a preference for this session.
  }
}

/** "81°F" or "27°C". Whole degrees: nobody flies on a tenth of one. */
export function formatTemp(celsius: number): string {
  return getUnits() === "f"
    ? `${Math.round(celsius * 1.8 + 32)}°F`
    : `${Math.round(celsius)}°C`;
}

/** The bare number, for somewhere the unit is already in the label. */
export function tempValue(celsius: number): number {
  return getUnits() === "f" ? Math.round(celsius * 1.8 + 32) : Math.round(celsius);
}

export function unitSuffix(): string {
  return getUnits() === "f" ? "°F" : "°C";
}
