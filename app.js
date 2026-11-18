"use strict";

/* ---------- Weather code lookup (WMO codes used by Open-Meteo) ---------- */
const WMO = {
  0: ["Clear sky", "☀️"], 1: ["Mostly clear", "🌤️"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁️"],
  45: ["Fog", "🌫️"], 48: ["Freezing fog", "🌫️"],
  51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Heavy drizzle", "🌧️"],
  56: ["Light freezing drizzle", "🧊"], 57: ["Freezing drizzle", "🧊"],
  61: ["Light rain", "🌦️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"],
  66: ["Light freezing rain", "🧊"], 67: ["Freezing rain", "🧊"],
  71: ["Light snow", "🌨️"], 73: ["Snow", "🌨️"], 75: ["Heavy snow", "❄️"], 77: ["Snow grains", "🌨️"],
  80: ["Light showers", "🌦️"], 81: ["Showers", "🌧️"], 82: ["Violent showers", "⛈️"],
  85: ["Light snow showers", "🌨️"], 86: ["Heavy snow showers", "❄️"],
  95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm with hail", "⛈️"], 99: ["Severe thunderstorm with hail", "⛈️"],
};
const describe = (code) => WMO[code] || ["Unknown", "❔"];

/* ---------- Small helpers ---------- */
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const MS_HOUR = 3600e3;
const MAX_FORECAST_DAYS = 16;

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = isError ? "error" : "";
}

async function fetchJson(url, label) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Couldn't reach the ${label} service. Check your connection and try again.`);
  }
  if (!res.ok) throw new Error(`The ${label} service returned an error (${res.status}).`);
  return res.json();
}

/* ---------- Geocoding (Nominatim) ---------- */
async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const data = await fetchJson(url, "geocoding");
  if (!data.length) throw new Error(`Couldn't find a place called "${query}".`);
  return { lat: +data[0].lat, lon: +data[0].lon, name: data[0].display_name };
}

/* ---------- Routing (OSRM) ---------- */
async function getRoute(a, b) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}` +
    `?overview=full&geometries=geojson`;
  const data = await fetchJson(url, "routing");
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error("Couldn't find a driving route between those places.");
  }
  const r = data.routes[0];
  return {
    coords: r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
    meters: r.distance,
    seconds: r.duration,
  };
}

/* ---------- Geometry: sample points along the route ---------- */
function haversine(p, q) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (q.lat - p.lat) * rad, dLon = (q.lon - p.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p.lat * rad) * Math.cos(q.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function samplePoints(coords, totalMeters) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  const length = cum[cum.length - 1] || 1;

  // roughly one point per 50 km, between 3 and 12 points
  const n = Math.min(12, Math.max(3, Math.ceil(totalMeters / 50000) + 1));
  const points = [];
  let seg = 1;
  for (let k = 0; k < n; k++) {
    const frac = k / (n - 1);
    const target = frac * length;
    while (seg < cum.length - 1 && cum[seg] < target) seg++;
    const span = cum[seg] - cum[seg - 1] || 1;
    const t = Math.min(1, Math.max(0, (target - cum[seg - 1]) / span));
    const a = coords[seg - 1], b = coords[seg];
    points.push({
      lat: a.lat + (b.lat - a.lat) * t,
      lon: a.lon + (b.lon - a.lon) * t,
      frac,
      meters: frac * totalMeters,
    });
  }
  return points;
}

/* ---------- Weather (Open-Meteo) ---------- */
async function getWeather(points, forecastDays) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(3)).join(","),
    longitude: points.map((p) => p.lon.toFixed(3)).join(","),
    hourly: "temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,visibility",
    wind_speed_unit: "kmh",
    timezone: "GMT",
    forecast_days: String(forecastDays),
  });
  const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`, "weather");
  return Array.isArray(data) ? data : [data];
}

// Pick the hourly entry closest to the time we'll be at that point.
function readHour(loc, when) {
  const times = loc.hourly.time;
  let best = -1, bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(Date.parse(times[i] + ":00Z") - when);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  if (best < 0 || bestDiff > 1.5 * MS_HOUR) return null; // beyond the forecast range
  const h = loc.hourly;
  return {
    temp: h.temperature_2m[best],
    precip: h.precipitation[best],
    pop: h.precipitation_probability[best],
    code: h.weather_code[best],
    wind: h.wind_speed_10m[best],
    gust: h.wind_gusts_10m[best],
    vis: h.visibility[best],
  };
}

/* ---------- Hazard assessment ---------- */
// Returns a list of {level: "caution"|"warn", text}. Inputs are metric.
function assess(w) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const c = w.code;

  if ([95, 96, 99].includes(c)) add("warn", "Thunderstorms — lightning and sudden heavy rain");
  if ([56, 57, 66, 67].includes(c)) add("warn", "Freezing rain — very slippery roads");
  if ([75, 86].includes(c)) add("warn", "Heavy snow — slow going, poor traction");
  else if ([71, 73, 77, 85].includes(c)) add("caution", "Snow — reduced traction");
  if ([65, 82].includes(c) || w.precip >= 7.6) add("warn", "Heavy rain — reduced visibility, hydroplaning risk");
  else if ([63, 81].includes(c) || w.precip >= 2.5) add("caution", "Steady rain — wet roads");
  if ([45, 48].includes(c)) add("caution", "Fog");
  if (w.vis != null && w.vis < 1000) add("warn", "Very low visibility");
  else if (w.vis != null && w.vis < 5000 && ![45, 48].includes(c)) add("caution", "Reduced visibility");
  if (w.gust != null && w.gust >= 80) add("warn", "Damaging wind gusts");
  else if (w.gust != null && w.gust >= 55) add("caution", "Strong gusts — watch crosswinds");
  if (w.temp <= 0 && w.precip > 0 && ![56, 57, 66, 67].includes(c)) add("warn", "Freezing temps with precipitation — black ice possible");
  else if (w.temp <= 2 && w.precip > 0) add("caution", "Near-freezing with precipitation — icy patches possible");
  if (w.temp >= 38) add("caution", "Extreme heat");
  if (w.temp <= -20) add("caution", "Extreme cold");
  return out;
}

const levelOf = (alerts) =>
  alerts.some((a) => a.level === "warn") ? "warn" : alerts.length ? "caution" : "ok";

/* ---------- Units ---------- */
const fmt = {
  temp: (c, u) => (u === "imperial" ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`),
  speed: (k, u) => (u === "imperial" ? `${Math.round(k * 0.621371)} mph` : `${Math.round(k)} km/h`),
  dist: (m, u) => (u === "imperial" ? `${Math.round(m / 1609.344)} mi` : `${Math.round(m / 1000)} km`),
  precip: (mm, u) => (u === "imperial" ? `${(mm / 25.4).toFixed(2)} in/h` : `${mm.toFixed(1)} mm/h`),
  time: (ms) =>
    new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }),
  duration: (s) => {
    const m = Math.round(s / 60), h = Math.floor(m / 60);
    return h ? `${h} h ${m % 60} min` : `${m} min`;
  },
};

/* ---------- Rendering ---------- */
let map, layer, markers = [], lastTrip = null;

// Time shown on a stop: just the clock time on the departure day, otherwise include the date.
function whenLabel(ms, departMs) {
  const d = new Date(ms), dep = new Date(departMs);
  const sameDay = d.toDateString() === dep.toDateString();
  return d.toLocaleString([], sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function labelFor(s, u) {
  const dist = fmt.dist(s.meters, u);
  if (s.idx === 0) return s.place ? `Start: ${s.place}` : "Start";
  if (s.idx === s.last) return s.place ? `Destination: ${s.place}` : "Destination";
  return s.place ? `${s.place} (${dist} in)` : `${dist} in`;
}

function popupHtml(s, trip, u) {
  const [desc, emoji] = s.w ? describe(s.w.code) : ["No forecast", "❔"];
  const detail = s.w ? `${emoji} ${desc}, ${fmt.temp(s.w.temp, u)}` : "No forecast available";
  return `<strong>${escapeHtml(labelFor(s, u))}</strong><br>${escapeHtml(whenLabel(s.eta, trip.depart))}<br>${escapeHtml(detail)}`;
}

function renderSummary(trip, u) {
  const { route, depart, stops } = trip;
  const worst = levelOf(stops.flatMap((s) => s.alerts));
  const flagged = stops.filter((s) => s.alerts.length);
  const summary = $("summary");
  summary.className = worst === "ok" ? "" : worst;
  const headline = {
    ok: "Looks like a smooth drive",
    caution: "Some weather to watch for",
    warn: "Hazardous conditions on your route",
  }[worst];
  const known = stops.filter((s) => s.w);
  const temps = known.map((s) => s.w.temp);
  const fullDate = new Date(depart).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  let html = `<h2>${headline}</h2>
    <p class="meta">${escapeHtml(fmt.dist(route.meters, u))} · ${escapeHtml(fmt.duration(route.seconds))} drive ·
    leaving ${escapeHtml(fullDate)}</p>`;
  if (known.length) {
    html += `<p>Temperatures from ${escapeHtml(fmt.temp(Math.min(...temps), u))} to
      ${escapeHtml(fmt.temp(Math.max(...temps), u))}.</p>`;
  }
  if (flagged.length) {
    html += "<ul>" + flagged.map((s) =>
      `<li><strong>${escapeHtml(labelFor(s, u))}</strong> (${escapeHtml(whenLabel(s.eta, depart))}): ` +
      escapeHtml(s.alerts.map((a) => a.text).join("; ")) + "</li>").join("") + "</ul>";
  } else if (known.length) {
    html += "<p>No notable hazards in the forecast along the way.</p>";
  }
  if (known.length < stops.length) {
    html += "<p class='note'>Some points on your trip are beyond the available forecast range and are marked as unknown.</p>";
  }
  summary.innerHTML = html;
}

function renderTimeline(trip, u) {
  $("timeline").innerHTML = trip.stops.map((s, i) => {
    const label = `${i + 1}. ${labelFor(s, u)}`;
    const when = whenLabel(s.eta, trip.depart);
    if (!s.w) {
      return `<li class="stop"><div class="icon">❔</div><div>
        <h3>${escapeHtml(label)}</h3>
        <div class="when">${escapeHtml(when)}</div>
        <div class="desc">No forecast available for this time</div></div></li>`;
    }
    const [desc, emoji] = describe(s.w.code);
    const lvl = levelOf(s.alerts);
    const stats = [
      `🌡️ ${fmt.temp(s.w.temp, u)}`,
      `💨 ${fmt.speed(s.w.wind, u)}` + (s.w.gust != null ? ` (gusts ${fmt.speed(s.w.gust, u)})` : ""),
      s.w.pop != null ? `☔ ${s.w.pop}% chance` : null,
      s.w.precip > 0 ? `💧 ${fmt.precip(s.w.precip, u)}` : null,
    ].filter(Boolean);
    return `<li class="stop ${lvl === "ok" ? "" : lvl}"><div class="icon">${emoji}</div><div>
      <h3>${escapeHtml(label)}</h3>
      <div class="when">${escapeHtml(when)}</div>
      <div class="desc">${escapeHtml(desc)}</div>
      <div class="stats">${stats.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>
      ${s.alerts.length ? `<ul class="alerts">${s.alerts.map((a) => `<li class="${a.level}">${a.level === "warn" ? "⚠️" : "⚡"} ${escapeHtml(a.text)}</li>`).join("")}</ul>` : ""}
    </div></li>`;
  }).join("");
}

function renderMap(trip, u) {
  // Optional: the timeline still works if the map library fails to load.
  try {
    if (typeof L === "undefined") throw new Error("no map");
    $("map").hidden = false;
    if (!map) {
      map = L.map("map");
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: "© OpenStreetMap contributors",
      }).addTo(map);
    }
    if (layer) layer.remove();
    layer = L.layerGroup().addTo(map);
    const line = L.polyline(trip.route.coords.map((p) => [p.lat, p.lon]), { color: "#2563eb", weight: 5, opacity: 0.8 }).addTo(layer);
    markers = trip.stops.map((s, i) => {
      const icon = L.divIcon({
        className: "",
        html: `<div class="pin ${s.w ? levelOf(s.alerts) : "ok"}">${i + 1}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      return L.marker([s.lat, s.lon], { icon }).addTo(layer).bindPopup(popupHtml(s, trip, u));
    });
    map.invalidateSize();
    map.fitBounds(line.getBounds(), { padding: [24, 24] });
    setTimeout(() => { map.invalidateSize(); map.fitBounds(line.getBounds(), { padding: [24, 24] }); }, 100);
  } catch (e) {
    $("map").hidden = true;
  }
}

function render(trip) {
  const u = $("units").value;
  $("results").hidden = false;
  renderSummary(trip, u);
  renderMap(trip, u);
  renderTimeline(trip, u);
}

// Called as place names arrive: refresh text only, leave the map view alone.
function refreshLabels(trip) {
  const u = $("units").value;
  renderSummary(trip, u);
  renderTimeline(trip, u);
  markers.forEach((m, i) => m.setPopupContent(popupHtml(trip.stops[i], trip, u)));
}

/* ---------- Place names (Nominatim reverse geocoding) ---------- */
async function reversePlace(p) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}`;
  const data = await fetchJson(url, "place-name");
  const a = data.address || {};
  const name = a.city || a.town || a.village || a.hamlet || a.municipality || a.county;
  if (!name) return null;
  return a.state && a.state !== name ? `${name}, ${a.state}` : name;
}

// Nominatim allows ~1 request/second, so fill names in one at a time.
async function fillPlaces(trip) {
  for (const s of trip.stops) {
    if (lastTrip !== trip) return; // a newer search replaced this one
    try {
      const place = await reversePlace(s);
      if (place && lastTrip === trip) {
        s.place = place;
        refreshLabels(trip);
      }
    } catch (e) { /* names are a nicety; ignore failures */ }
    await new Promise((r) => setTimeout(r, 1100));
  }
}

/* ---------- Accuracy notice ---------- */
function updateAccuracyNote() {
  const note = $("accuracy-note");
  const t = $("depart").value ? new Date($("depart").value).getTime() : Date.now();
  const hours = (t - Date.now()) / MS_HOUR;
  if (hours > 24 * 7) {
    note.textContent = "⚠️ More than a week out: forecasts this far ahead are rough guesses and may change a lot.";
  } else if (hours > 48) {
    note.textContent = "⚠️ Forecasts get less accurate the further ahead you look. Re-check closer to your departure.";
  } else if (hours > 6) {
    note.textContent = "Heads up: forecasts are most accurate for the next few hours and get less reliable later.";
  } else {
    note.hidden = true;
    return;
  }
  note.hidden = false;
}

/* ---------- Main flow ---------- */
let myLocation = null; // {lat, lon} when "use my location" is active

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Your browser doesn't support location."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error("Couldn't get your location. Allow location access or type a starting point.")),
      { timeout: 10000 }
    );
  });
}

async function useMyLocation() {
  setStatus("Finding your location…");
  try {
    myLocation = await getPosition();
    $("origin").value = "My current location";
    setStatus("");
  } catch (e) {
    myLocation = null;
    setStatus(e.message, true);
  }
}

async function run(ev) {
  ev.preventDefault();
  const btn = $("go");
  btn.disabled = true;
  $("results").hidden = true;
  try {
    const destText = $("destination").value.trim();
    if (!destText) throw new Error("Enter a destination.");
    const originText = $("origin").value.trim();

    // Origin: explicit coordinates, typed address, or fall back to geolocation.
    let origin;
    if (myLocation && (!originText || originText === "My current location")) {
      origin = { ...myLocation, name: "Your location" };
    } else if (originText) {
      setStatus("Finding your starting point…");
      origin = await geocode(originText);
    } else {
      setStatus("Finding your location…");
      myLocation = await getPosition();
      $("origin").value = "My current location";
      origin = { ...myLocation, name: "Your location" };
    }

    setStatus("Finding your destination…");
    const dest = await geocode(destText);

    setStatus("Planning the route…");
    const route = await getRoute(origin, dest);

    const departInput = $("depart").value;
    let depart = departInput ? new Date(departInput).getTime() : Date.now();
    if (depart < Date.now()) depart = Date.now();

    const points = samplePoints(route.coords, route.meters);
    const arrival = depart + route.seconds * 1000;
    const days = Math.min(MAX_FORECAST_DAYS, Math.max(2, Math.ceil((arrival - Date.now()) / (24 * MS_HOUR)) + 1));

    setStatus("Checking the weather along the way…");
    const locs = await getWeather(points, days);

    const stops = points.map((p, i) => {
      const eta = depart + p.frac * route.seconds * 1000;
      const w = locs[i] ? readHour(locs[i], eta) : null;
      return { ...p, eta, w, idx: i, last: points.length - 1, alerts: w ? assess(w) : [] };
    });

    lastTrip = { stops, route, depart, originName: origin.name, destName: dest.name };
    render(lastTrip);
    setStatus("");
    fillPlaces(lastTrip);
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    setStatus(e.message || "Something went wrong.", true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Init ---------- */
function toLocalInputValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function init() {
  const now = new Date();
  $("depart").value = toLocalInputValue(now);
  $("depart").min = toLocalInputValue(now);
  $("depart").max = toLocalInputValue(new Date(now.getTime() + 15 * 24 * MS_HOUR));

  // Default units from locale: US/Liberia/Myanmar use imperial.
  const region = (navigator.language || "en-US").split("-")[1];
  $("units").value = ["US", "LR", "MM"].includes(region) ? "imperial" : "metric";

  $("origin").addEventListener("input", () => { if ($("origin").value !== "My current location") myLocation = null; });
  $("locate").addEventListener("click", useMyLocation);
  $("depart").addEventListener("input", updateAccuracyNote);
  $("units").addEventListener("change", () => { if (lastTrip) refreshLabels(lastTrip); });
  $("trip-form").addEventListener("submit", run);
  updateAccuracyNote();
}

init();
