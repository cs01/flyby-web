// The curated places, with the landmarks that make each one worth a lap.
//
// A city earns a place here by having VERTICAL RELIEF the renderer can show:
// either a skyline (Manhattan, Hong Kong), terrain the city is built into
// (Rio, Cape Town, San Francisco), or water that reflects it (Sydney, Venice).
// A flat grid of mid-rises is a real city and a boring flight.
//
// `radius` is the half-width of the baked building pack. Bigger is not better:
// it is a linear cost in bake time and download, and past about 8 km the
// buildings are too far to resolve anyway.

export interface Landmark {
  name: string;
  lat: number;
  lon: number;
  /** Metres AGL to place the beacon top; a tall mark on a tall thing. */
  height?: number;
}

export interface City {
  id: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  /** Building pack radius, metres. */
  radius: number;
  /** Compass heading the opening survey flies, degrees true. */
  approach: number;
  /** Start altitude AGL, metres. Higher for cities that read as a skyline. */
  startAlt: number;
  landmarks: Landmark[];
}

export const CITIES: City[] = [
  {
    id: "sf", name: "San Francisco", country: "USA",
    lat: 37.8085, lon: -122.4098, radius: 7000, approach: 300, startAlt: 700,
    landmarks: [
      { name: "Golden Gate Bridge", lat: 37.8199, lon: -122.4783, height: 227 },
      { name: "Transamerica Pyramid", lat: 37.7952, lon: -122.4028, height: 260 },
      { name: "Coit Tower", lat: 37.8024, lon: -122.4058, height: 64 },
      { name: "Alcatraz", lat: 37.8270, lon: -122.4230, height: 41 },
      { name: "Salesforce Tower", lat: 37.7897, lon: -122.3972, height: 326 },
    ],
  },
  {
    id: "manhattan", name: "New York", country: "USA",
    lat: 40.7549, lon: -73.9840, radius: 8000, approach: 200, startAlt: 800,
    landmarks: [
      { name: "Empire State Building", lat: 40.7484, lon: -73.9857, height: 443 },
      { name: "One World Trade Center", lat: 40.7127, lon: -74.0134, height: 541 },
      { name: "Statue of Liberty", lat: 40.6892, lon: -74.0445, height: 93 },
      { name: "Chrysler Building", lat: 40.7516, lon: -73.9755, height: 319 },
      { name: "Central Park", lat: 40.7829, lon: -73.9654, height: 40 },
    ],
  },
  {
    id: "hongkong", name: "Hong Kong", country: "China",
    lat: 22.2860, lon: 114.1580, radius: 7000, approach: 180, startAlt: 750,
    landmarks: [
      { name: "ICC", lat: 22.3035, lon: 114.1601, height: 484 },
      { name: "IFC Two", lat: 22.2853, lon: 114.1591, height: 412 },
      { name: "Victoria Peak", lat: 22.2759, lon: 114.1455, height: 552 },
      { name: "Bank of China Tower", lat: 22.2790, lon: 114.1615, height: 367 },
      { name: "Tsing Ma Bridge", lat: 22.3510, lon: 114.0740, height: 206 },
    ],
  },
  {
    id: "dubai", name: "Dubai", country: "UAE",
    lat: 25.1972, lon: 55.2744, radius: 8000, approach: 240, startAlt: 900,
    landmarks: [
      { name: "Burj Khalifa", lat: 25.1972, lon: 55.2744, height: 828 },
      { name: "Burj Al Arab", lat: 25.1412, lon: 55.1853, height: 321 },
      { name: "Palm Jumeirah", lat: 25.1124, lon: 55.1390, height: 20 },
      { name: "Dubai Frame", lat: 25.2354, lon: 55.3003, height: 150 },
      { name: "Marina Torch", lat: 25.0885, lon: 55.1450, height: 352 },
    ],
  },
  {
    id: "rio", name: "Rio de Janeiro", country: "Brazil",
    lat: -22.9519, lon: -43.2105, radius: 8000, approach: 90, startAlt: 800,
    landmarks: [
      { name: "Christ the Redeemer", lat: -22.9519, lon: -43.2105, height: 710 },
      { name: "Sugarloaf Mountain", lat: -22.9492, lon: -43.1545, height: 396 },
      { name: "Maracana", lat: -22.9121, lon: -43.2302, height: 32 },
      { name: "Copacabana", lat: -22.9711, lon: -43.1822, height: 10 },
      { name: "Ipanema", lat: -22.9868, lon: -43.2065, height: 10 },
    ],
  },
  {
    id: "capetown", name: "Cape Town", country: "South Africa",
    lat: -33.9249, lon: 18.4241, radius: 8000, approach: 340, startAlt: 900,
    landmarks: [
      { name: "Table Mountain", lat: -33.9575, lon: 18.4090, height: 1085 },
      { name: "Lion's Head", lat: -33.9356, lon: 18.3893, height: 669 },
      { name: "V&A Waterfront", lat: -33.9036, lon: 18.4197, height: 30 },
      { name: "Signal Hill", lat: -33.9153, lon: 18.4030, height: 350 },
      { name: "Green Point Stadium", lat: -33.9036, lon: 18.4110, height: 55 },
    ],
  },
  {
    id: "sydney", name: "Sydney", country: "Australia",
    lat: -33.8568, lon: 151.2153, radius: 7000, approach: 20, startAlt: 650,
    landmarks: [
      { name: "Sydney Opera House", lat: -33.8568, lon: 151.2153, height: 65 },
      { name: "Harbour Bridge", lat: -33.8523, lon: 151.2108, height: 134 },
      { name: "Sydney Tower", lat: -33.8704, lon: 151.2085, height: 309 },
      { name: "Bondi Beach", lat: -33.8908, lon: 151.2743, height: 10 },
      { name: "Barangaroo", lat: -33.8633, lon: 151.2010, height: 275 },
    ],
  },
  {
    id: "tokyo", name: "Tokyo", country: "Japan",
    lat: 35.6586, lon: 139.7454, radius: 8000, approach: 300, startAlt: 800,
    landmarks: [
      { name: "Tokyo Tower", lat: 35.6586, lon: 139.7454, height: 333 },
      { name: "Tokyo Skytree", lat: 35.7101, lon: 139.8107, height: 634 },
      { name: "Imperial Palace", lat: 35.6852, lon: 139.7528, height: 30 },
      { name: "Shibuya Scramble", lat: 35.6595, lon: 139.7005, height: 230 },
      { name: "Rainbow Bridge", lat: 35.6365, lon: 139.7635, height: 127 },
    ],
  },
  {
    id: "paris", name: "Paris", country: "France",
    lat: 48.8584, lon: 2.2945, radius: 7000, approach: 70, startAlt: 550,
    landmarks: [
      { name: "Eiffel Tower", lat: 48.8584, lon: 2.2945, height: 330 },
      { name: "Arc de Triomphe", lat: 48.8738, lon: 2.2950, height: 50 },
      { name: "Notre-Dame", lat: 48.8530, lon: 2.3499, height: 96 },
      { name: "Sacre-Coeur", lat: 48.8867, lon: 2.3431, height: 213 },
      { name: "La Defense", lat: 48.8918, lon: 2.2361, height: 231 },
    ],
  },
  {
    id: "london", name: "London", country: "UK",
    lat: 51.5045, lon: -0.0865, radius: 7000, approach: 260, startAlt: 600,
    landmarks: [
      { name: "The Shard", lat: 51.5045, lon: -0.0865, height: 310 },
      { name: "Tower Bridge", lat: 51.5055, lon: -0.0754, height: 65 },
      { name: "Big Ben", lat: 51.5007, lon: -0.1246, height: 96 },
      { name: "London Eye", lat: 51.5033, lon: -0.1196, height: 135 },
      { name: "The Gherkin", lat: 51.5145, lon: -0.0803, height: 180 },
    ],
  },
  {
    id: "singapore", name: "Singapore", country: "Singapore",
    lat: 1.2838, lon: 103.8591, radius: 7000, approach: 20, startAlt: 600,
    landmarks: [
      { name: "Marina Bay Sands", lat: 1.2834, lon: 103.8607, height: 200 },
      { name: "Gardens by the Bay", lat: 1.2816, lon: 103.8636, height: 50 },
      { name: "Singapore Flyer", lat: 1.2893, lon: 103.8631, height: 165 },
      { name: "Merlion", lat: 1.2868, lon: 103.8545, height: 8 },
      { name: "Guoco Tower", lat: 1.2764, lon: 103.8459, height: 290 },
    ],
  },
  {
    id: "chicago", name: "Chicago", country: "USA",
    lat: 41.8789, lon: -87.6359, radius: 7000, approach: 180, startAlt: 700,
    landmarks: [
      { name: "Willis Tower", lat: 41.8789, lon: -87.6359, height: 442 },
      { name: "Trump Tower", lat: 41.8892, lon: -87.6267, height: 423 },
      { name: "John Hancock Center", lat: 41.8988, lon: -87.6229, height: 344 },
      { name: "Navy Pier", lat: 41.8917, lon: -87.6086, height: 30 },
      { name: "Cloud Gate", lat: 41.8827, lon: -87.6233, height: 10 },
    ],
  },
  {
    id: "vancouver", name: "Vancouver", country: "Canada",
    lat: 49.2827, lon: -123.1207, radius: 7000, approach: 340, startAlt: 700,
    landmarks: [
      { name: "Canada Place", lat: 49.2888, lon: -123.1111, height: 40 },
      { name: "Living Shangri-La", lat: 49.2841, lon: -123.1213, height: 201 },
      { name: "Stanley Park", lat: 49.3017, lon: -123.1417, height: 40 },
      { name: "Lions Gate Bridge", lat: 49.3145, lon: -123.1387, height: 111 },
      { name: "Grouse Mountain", lat: 49.3800, lon: -123.0800, height: 1231 },
    ],
  },
  {
    id: "istanbul", name: "Istanbul", country: "Turkey",
    lat: 41.0086, lon: 28.9802, radius: 7000, approach: 45, startAlt: 600,
    landmarks: [
      { name: "Hagia Sophia", lat: 41.0086, lon: 28.9802, height: 56 },
      { name: "Blue Mosque", lat: 41.0054, lon: 28.9768, height: 64 },
      { name: "Galata Tower", lat: 41.0256, lon: 28.9744, height: 67 },
      { name: "Bosphorus Bridge", lat: 41.0451, lon: 29.0340, height: 165 },
      { name: "Camlica Tower", lat: 41.0272, lon: 29.0680, height: 369 },
    ],
  },
  {
    id: "barcelona", name: "Barcelona", country: "Spain",
    lat: 41.4036, lon: 2.1744, radius: 7000, approach: 135, startAlt: 550,
    landmarks: [
      { name: "Sagrada Familia", lat: 41.4036, lon: 2.1744, height: 172 },
      { name: "Torre Glories", lat: 41.4033, lon: 2.1894, height: 144 },
      { name: "Montjuic", lat: 41.3638, lon: 2.1655, height: 173 },
      { name: "Camp Nou", lat: 41.3809, lon: 2.1228, height: 48 },
      { name: "W Barcelona", lat: 41.3684, lon: 2.1900, height: 99 },
    ],
  },
  {
    id: "seattle", name: "Seattle", country: "USA",
    lat: 47.6205, lon: -122.3493, radius: 7000, approach: 160, startAlt: 750,
    landmarks: [
      { name: "Space Needle", lat: 47.6205, lon: -122.3493, height: 184 },
      { name: "Columbia Center", lat: 47.6045, lon: -122.3301, height: 285 },
      { name: "Pike Place Market", lat: 47.6097, lon: -122.3421, height: 20 },
      { name: "T-Mobile Park", lat: 47.5914, lon: -122.3325, height: 60 },
      { name: "Mount Rainier", lat: 46.8523, lon: -121.7603, height: 4392 },
    ],
  },
  {
    id: "shanghai", name: "Shanghai", country: "China",
    lat: 31.2336, lon: 121.5055, radius: 8000, approach: 270, startAlt: 900,
    landmarks: [
      { name: "Shanghai Tower", lat: 31.2336, lon: 121.5055, height: 632 },
      { name: "Oriental Pearl", lat: 31.2397, lon: 121.4998, height: 468 },
      { name: "Jin Mao Tower", lat: 31.2374, lon: 121.5017, height: 421 },
      { name: "The Bund", lat: 31.2397, lon: 121.4903, height: 30 },
      { name: "World Financial Center", lat: 31.2352, lon: 121.5057, height: 492 },
    ],
  },
  {
    id: "toronto", name: "Toronto", country: "Canada",
    lat: 43.6426, lon: -79.3871, radius: 7000, approach: 20, startAlt: 700,
    landmarks: [
      { name: "CN Tower", lat: 43.6426, lon: -79.3871, height: 553 },
      { name: "First Canadian Place", lat: 43.6487, lon: -79.3817, height: 298 },
      { name: "Rogers Centre", lat: 43.6414, lon: -79.3894, height: 86 },
      { name: "Casa Loma", lat: 43.6780, lon: -79.4094, height: 60 },
      { name: "Toronto Islands", lat: 43.6205, lon: -79.3789, height: 10 },
    ],
  },
  {
    id: "kualalumpur", name: "Kuala Lumpur", country: "Malaysia",
    lat: 3.1578, lon: 101.7117, radius: 7000, approach: 200, startAlt: 800,
    landmarks: [
      { name: "Petronas Towers", lat: 3.1578, lon: 101.7117, height: 452 },
      { name: "Merdeka 118", lat: 3.1414, lon: 101.7005, height: 679 },
      { name: "KL Tower", lat: 3.1528, lon: 101.7038, height: 421 },
      { name: "Batu Caves", lat: 3.2379, lon: 101.6840, height: 100 },
      { name: "Bukit Bintang", lat: 3.1468, lon: 101.7113, height: 60 },
    ],
  },
  {
    id: "athens", name: "Athens", country: "Greece",
    lat: 37.9715, lon: 23.7267, radius: 7000, approach: 90, startAlt: 600,
    landmarks: [
      { name: "Acropolis", lat: 37.9715, lon: 23.7267, height: 156 },
      { name: "Lycabettus Hill", lat: 37.9838, lon: 23.7430, height: 277 },
      { name: "Panathenaic Stadium", lat: 37.9683, lon: 23.7413, height: 40 },
      { name: "Temple of Olympian Zeus", lat: 37.9693, lon: 23.7331, height: 30 },
      { name: "Piraeus", lat: 37.9420, lon: 23.6465, height: 20 },
    ],
  },
  {
    id: "venice", name: "Venice", country: "Italy",
    lat: 45.4341, lon: 12.3388, radius: 6000, approach: 250, startAlt: 400,
    landmarks: [
      { name: "St Mark's Campanile", lat: 45.4341, lon: 12.3388, height: 99 },
      { name: "Rialto Bridge", lat: 45.4380, lon: 12.3358, height: 20 },
      { name: "Santa Maria della Salute", lat: 45.4306, lon: 12.3346, height: 70 },
      { name: "Arsenale", lat: 45.4348, lon: 12.3512, height: 30 },
      { name: "Lido", lat: 45.4104, lon: 12.3665, height: 15 },
    ],
  },
  {
    id: "queenstown", name: "Queenstown", country: "New Zealand",
    lat: -45.0312, lon: 168.6626, radius: 8000, approach: 30, startAlt: 1200,
    landmarks: [
      { name: "The Remarkables", lat: -45.0500, lon: 168.8100, height: 2319 },
      { name: "Bob's Peak", lat: -45.0290, lon: 168.6480, height: 790 },
      { name: "Lake Wakatipu", lat: -45.0500, lon: 168.6300, height: 310 },
      { name: "Kelvin Heights", lat: -45.0450, lon: 168.6900, height: 400 },
      { name: "Shotover Canyon", lat: -44.9950, lon: 168.6800, height: 350 },
    ],
  },
  {
    id: "reykjavik", name: "Reykjavik", country: "Iceland",
    lat: 64.1466, lon: -21.9426, radius: 7000, approach: 100, startAlt: 700,
    landmarks: [
      { name: "Hallgrimskirkja", lat: 64.1417, lon: -21.9266, height: 74 },
      { name: "Harpa", lat: 64.1504, lon: -21.9328, height: 43 },
      { name: "Perlan", lat: 64.1290, lon: -21.9187, height: 61 },
      { name: "Mount Esja", lat: 64.2333, lon: -21.7500, height: 914 },
      { name: "Videy Island", lat: 64.1560, lon: -21.8420, height: 30 },
    ],
  },
  {
    id: "monaco", name: "Monaco", country: "Monaco",
    lat: 43.7384, lon: 7.4246, radius: 5000, approach: 250, startAlt: 500,
    landmarks: [
      { name: "Monte Carlo Casino", lat: 43.7396, lon: 7.4287, height: 40 },
      { name: "Port Hercule", lat: 43.7355, lon: 7.4258, height: 10 },
      { name: "Prince's Palace", lat: 43.7315, lon: 7.4206, height: 60 },
      { name: "Tete de Chien", lat: 43.7330, lon: 7.4050, height: 550 },
      { name: "Larvotto", lat: 43.7470, lon: 7.4340, height: 15 },
    ],
  },
];

export function cityById(id: string): City | undefined {
  return CITIES.find((c) => c.id === id);
}

export const DEFAULT_CITY = "sf";
