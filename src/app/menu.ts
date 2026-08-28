// The start screen: pick a city, see what the weather is doing there right now.
//
// The live weather on the cards is not decoration. It is the app telling you
// what it is going to show you before you commit two megabytes of terrain to
// finding out -- if you want to fly a thunderstorm, this is where you find one.
// It costs a single request: Open-Meteo takes comma-separated coordinate lists
// and answers with an array, so twenty-four cities are one round trip rather
// than twenty-four.

import { CITIES, CONTINENTS, type City } from "../cities";

const WMO_SHORT: Record<number, string> = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle",
  56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow",
  80: "Showers", 81: "Showers", 82: "Heavy showers",
  85: "Snow showers", 86: "Snow showers",
  95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm",
};

// U+FE0F on the older symbols forces EMOJI presentation. Without it a
// monospace stack renders U+2600 and U+2601 as a text star and outline cloud,
// which next to the colour emoji for rain and snow looks like a missing glyph.
function icon(code: number, isDay: boolean): string {
  if (code >= 95) return "\u26C8\uFE0F";
  if (code >= 85) return "\u{1F328}\uFE0F";
  if (code >= 71) return "\u2744\uFE0F";
  if (code >= 61) return "\u{1F327}\uFE0F";
  if (code >= 51) return "\u{1F326}\uFE0F";
  if (code >= 45) return "\u{1F32B}\uFE0F";
  if (code === 3) return "\u2601\uFE0F";
  if (code === 1 || code === 2) return isDay ? "\u{1F324}\uFE0F" : "\u2601\uFE0F";
  return isDay ? "\u2600\uFE0F" : "\u{1F319}";
}

interface CardWeather {
  tempC: number;
  code: number;
  isDay: boolean;
  cloud: number;
  offsetSec: number;
}

interface OMEntry {
  utc_offset_seconds: number;
  current: { temperature_2m: number; weather_code: number; is_day: number; cloud_cover: number };
}

async function fetchAllWeather(cities: City[]): Promise<(CardWeather | null)[]> {
  const lats = cities.map((c) => c.lat.toFixed(3)).join(",");
  const lons = cities.map((c) => c.lon.toFixed(3)).join(",");
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
    `&current=temperature_2m,weather_code,is_day,cloud_cover&timezone=auto`;
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as OMEntry[] | OMEntry;
    // A single-city request answers with an object rather than an array.
    const arr = Array.isArray(j) ? j : [j];
    return cities.map((_, i) => {
      const e = arr[i];
      if (!e?.current) return null;
      return {
        tempC: e.current.temperature_2m,
        code: e.current.weather_code,
        isDay: e.current.is_day === 1,
        cloud: e.current.cloud_cover,
        offsetSec: e.utc_offset_seconds,
      };
    });
  } catch {
    return cities.map(() => null);
  }
}

/** The city's wall clock as a 12-hour time: "1:54 PM". */
function localTime(offsetSec: number): string {
  const d = new Date(Date.now() + offsetSec * 1000);
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

/** Cities that have a baked building pack, so the card can say so. */
async function fetchSkylineIndex(): Promise<Set<string>> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}cities/index.json`);
    if (!res.ok) return new Set();
    const ids = (await res.json()) as string[];
    return new Set(ids);
  } catch {
    return new Set();
  }
}


/**
 * "Fly where I am", which the app can offer because nothing about a place is
 * baked in: terrain, imagery and weather are all fetched by coordinate.
 *
 * The permission prompt is only ever raised by this button being pressed --
 * asking on load would be a prompt nobody asked for on a page that has not
 * yet earned one. The fix is rounded to three decimals, ~110 m, before it goes
 * anywhere: the URL has to carry it so the flight can be reloaded and shared,
 * and 110 m is far more precision than flying needs and far less than a home
 * address.
 */
function buildHereCard(row: HTMLElement, onHere: (lat: number, lon: number) => void): void {
  const btn = document.createElement("button");
  btn.className = "card card-here";
  btn.innerHTML = `
    <div class="card-top">
      <span class="city">Where I am</span>
      <span class="wx">\u{1F4CD}</span>
    </div>
    <div class="card-bot">
      <span class="country">fly your own sky</span>
      <span class="time here-status"></span>
    </div>`;
  const status = btn.querySelector(".here-status") as HTMLElement;
  row.append(btn);

  btn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      status.textContent = "unavailable";
      return;
    }
    btn.disabled = true;
    status.textContent = "asking...";
    navigator.geolocation.getCurrentPosition(
      (pos) => onHere(pos.coords.latitude, pos.coords.longitude),
      (err) => {
        btn.disabled = false;
        status.textContent = err.code === err.PERMISSION_DENIED ? "declined" : "no fix";
      },
      // A cached fix from the last ten minutes is fine: the flight starts at a
      // whole city's scale, so high accuracy would only cost a GPS wait.
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 },
    );
  });
}

export function showMenu(onPick: (city: City) => void, onHere: (lat: number, lon: number) => void): void {
  const root = document.createElement("div");
  root.id = "menu";
  root.innerHTML = `
    <div class="menu-inner">
      <header>
        <h1>FLYBY</h1>
        <p>Fly real places under the weather that is happening there right now.</p>
      </header>
      <div class="here-row"></div>
      <div class="sections"></div>
      <footer>
        Terrain: NASA SRTM via AWS Terrain Tiles · Imagery: Esri World Imagery ·
        Buildings: © OpenStreetMap contributors (ODbL) · Weather: Open-Meteo
      </footer>
    </div>`;
  document.body.append(root);

  buildHereCard(root.querySelector(".here-row") as HTMLElement, onHere);

  // One grid per continent, alphabetical inside and out. Twenty-nine cards in
  // one undifferentiated block is a list you scan rather than a map you know
  // your way around, and "somewhere in Asia" is how people actually decide.
  //
  // The leftover pass is not defensive padding: a place whose continent is
  // missing must still be REACHABLE. Silently dropping it from the grid would
  // be the menu quietly losing a city, which is the one failure here that
  // nothing else in the app would report.
  const sections = root.querySelector(".sections") as HTMLElement;
  const grouped = new Map<string, City[]>();
  for (const c of CITIES) {
    const key = c.continent && (CONTINENTS as string[]).includes(c.continent) ? c.continent : "Elsewhere";
    (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(c);
  }
  const gridFor = new Map<string, HTMLElement>();
  for (const key of [...CONTINENTS, "Elsewhere"]) {
    const list = grouped.get(key);
    if (!list || list.length === 0) continue;
    const sec = document.createElement("section");
    sec.className = "menu-section";
    sec.innerHTML = `<h2>${key}</h2><div class="grid"></div>`;
    sections.append(sec);
    gridFor.set(key, sec.querySelector(".grid") as HTMLElement);
  }

  const cards = CITIES.map((c) => {
    // A real anchor, not a button. Cities are destinations with their own URL,
    // so ctrl/cmd-click, middle-click and "open in new tab" all have to work --
    // a button with a click handler silently swallows every one of them.
    const el = document.createElement("a");
    el.className = "card";
    const params = new URLSearchParams(location.search);
    params.set("city", c.id);
    el.href = `?${params.toString()}`;
    el.innerHTML = `
      <div class="card-top">
        <span class="city">${c.name}</span>
        <span class="wx">·</span>
      </div>
      <div class="card-bot">
        <span class="country">${c.country}</span>
        <span class="time">--:--</span>
      </div>`;
    el.addEventListener("click", (e) => {
      // Let the browser handle any click it has its own meaning for: a modifier
      // key, or anything that is not the primary button.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      root.classList.add("leaving");
      setTimeout(() => root.remove(), 400);
      onPick(c);
    });
    const key = c.continent && (CONTINENTS as string[]).includes(c.continent) ? c.continent : "Elsewhere";
    gridFor.get(key)!.append(el);
    return el;
  });

  void (async () => {
    const [wx, skylines] = await Promise.all([fetchAllWeather(CITIES), fetchSkylineIndex()]);
    CITIES.forEach((c, i) => {
      const w = wx[i];
      const el = cards[i];
      if (skylines.has(c.id)) el.classList.add("has-skyline");
      if (!w) return;
      el.classList.toggle("night", !w.isDay);
      (el.querySelector(".wx") as HTMLElement).innerHTML =
        `${icon(w.code, w.isDay)} ${Math.round(w.tempC)}°`;
      (el.querySelector(".time") as HTMLElement).textContent = localTime(w.offsetSec);
      el.title = `${WMO_SHORT[w.code] ?? "Unknown"} · ${w.cloud}% cloud`;
    });
  })();
}
