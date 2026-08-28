// The start screen: pick a city, see what the weather is doing there right now.
//
// The live weather on the cards is not decoration. It is the app telling you
// what it is going to show you before you commit two megabytes of terrain to
// finding out -- if you want to fly a thunderstorm, this is where you find one.
// It costs a single request: Open-Meteo takes comma-separated coordinate lists
// and answers with an array, so twenty-four cities are one round trip rather
// than twenty-four.

import { CITIES, CONTINENTS, type City } from "../cities";
import { fetchJson, TTL_WEATHER, TTL_STATIC } from "../data/cache";
import { searchPlaces, type SearchHit } from "../data/place";
import { getUnits, setUnits, formatTemp } from "./units";

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
    // Through the SAME IndexedDB cache every tile uses, on the weather TTL.
    // This was a bare fetch, so every visit to the picker -- including every
    // bounce back from a flight -- was a fresh round trip to Open-Meteo for
    // numbers that change hourly. Nothing else in the app was that impolite.
    const j = await fetchJson<OMEntry[] | OMEntry>(url, TTL_WEATHER);
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
    const ids = await fetchJson<string[]>(`${import.meta.env.BASE_URL}cities/index.json`, TTL_STATIC);
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

/**
 * Type a place, fly there. Open-Meteo's geocoder, which the app already leans
 * on for weather, answers with coordinates -- and coordinates are all this
 * needs, because terrain, imagery and weather are fetched by coordinate.
 *
 * Every keystroke ABORTS the request before it. Without that the results are
 * whichever response happens to land last, which on a slow connection is
 * routinely the answer to a prefix the reader has already finished typing.
 */
function buildSearch(row: HTMLElement, onHere: (lat: number, lon: number) => void): void {
  row.innerHTML = `
    <input class="find-input" type="search" autocomplete="off" spellcheck="false"
           placeholder="Search anywhere on Earth..." aria-label="Search for a place" />
    <div class="find-list" hidden></div>`;
  const input = row.querySelector(".find-input") as HTMLInputElement;
  const list = row.querySelector(".find-list") as HTMLElement;

  let controller: AbortController | null = null;
  let timer = 0;
  let hits: SearchHit[] = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    list.textContent = "";
    hits = [];
    active = -1;
  };

  const highlight = () => {
    for (const [i, el] of [...list.children].entries()) {
      el.classList.toggle("on", i === active);
    }
  };

  const render = () => {
    list.textContent = "";
    if (hits.length === 0) {
      close();
      return;
    }
    for (const [i, h] of hits.entries()) {
      const b = document.createElement("button");
      b.className = "find-hit";
      b.innerHTML = `<span>${h.name}</span><i>${[h.region, h.country].filter(Boolean).join(", ")}</i>`;
      b.addEventListener("click", () => onHere(h.lat, h.lon));
      b.addEventListener("mouseenter", () => { active = i; highlight(); });
      list.append(b);
    }
    list.hidden = false;
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    controller?.abort();
    const q = input.value;
    if (q.trim().length < 2) {
      close();
      return;
    }
    // A quarter of a second: long enough that a fast typist makes one request
    // for a word rather than one per letter, short enough to feel immediate.
    timer = window.setTimeout(async () => {
      controller = new AbortController();
      const found = await searchPlaces(q, controller.signal);
      // The field may have moved on while this was in flight.
      if (input.value !== q) return;
      hits = found;
      active = -1;
      render();
    }, 250);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); return; }
    if (hits.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
      highlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = hits[active >= 0 ? active : 0];
      if (h) onHere(h.lat, h.lon);
    }
  });

  input.addEventListener("blur", () => {
    // After the click on a result has had its chance to fire.
    setTimeout(close, 150);
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
        <div class="units">
          <button data-u="imperial">Imperial</button><button data-u="metric">Metric</button>
        </div>
      </header>
      <div class="find-row"></div>
      <div class="here-row"></div>
      <div class="sections"></div>
      <footer>
        Terrain: NASA SRTM via AWS Terrain Tiles · Imagery: Esri World Imagery ·
        Buildings: © OpenStreetMap contributors (ODbL) · Weather: Open-Meteo
      </footer>
    </div>`;
  document.body.append(root);

  buildSearch(root.querySelector(".find-row") as HTMLElement, onHere);
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

  // The unit toggle redraws the cards in place rather than reloading: the
  // weather is already fetched and asking for it again to change a suffix
  // would be a round trip for nothing.
  let latest: (CardWeather | null)[] | null = null;
  const paintUnits = () => {
    for (const b of root.querySelectorAll<HTMLButtonElement>(".units button")) {
      b.classList.toggle("on", b.dataset.u === getUnits());
    }
    if (!latest) return;
    CITIES.forEach((_, i) => {
      const w = latest![i];
      if (!w) return;
      (cards[i].querySelector(".wx") as HTMLElement).innerHTML =
        `${icon(w.code, w.isDay)} ${formatTemp(w.tempC)}`;
    });
  };
  for (const b of root.querySelectorAll<HTMLButtonElement>(".units button")) {
    b.addEventListener("click", () => {
      setUnits(b.dataset.u === "metric" ? "metric" : "imperial");
      paintUnits();
    });
  }
  paintUnits();

  void (async () => {
    const [wx, skylines] = await Promise.all([fetchAllWeather(CITIES), fetchSkylineIndex()]);
    latest = wx;
    CITIES.forEach((c, i) => {
      const w = wx[i];
      const el = cards[i];
      if (skylines.has(c.id)) el.classList.add("has-skyline");
      if (!w) return;
      el.classList.toggle("night", !w.isDay);
      (el.querySelector(".wx") as HTMLElement).innerHTML =
        `${icon(w.code, w.isDay)} ${formatTemp(w.tempC)}`;
      (el.querySelector(".time") as HTMLElement).textContent = localTime(w.offsetSec);
      el.title = `${WMO_SHORT[w.code] ?? "Unknown"} · ${w.cloud}% cloud`;
    });
  })();
}
