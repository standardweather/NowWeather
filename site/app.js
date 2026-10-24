/* NowWeather — live hazards console for standardweather.github.io.
 *
 * Everything loads live in the browser from government services that allow cross-origin requests:
 *   NWS API (api.weather.gov)        active alerts (text, storm-based polygons, zone shapes)
 *   nowCOAST (NOAA)                  watches/warnings/advisories map layer in NWS colors; radar mosaic loop
 *   SPC (spc.noaa.gov)               convective outlooks (GeoJSON + text), today's/yesterday's storm reports
 *   NOAA map services                SPC mesoscale discussions
 *   NOAA MRMS (noaa-mrms-pds)        hail-size and rotation swaths, decoded in the browser by /js/mrms.js
 *   NWS API points/forecast          forecast and area forecast discussion for any clicked spot; alerts at "My place"
 *                                    and arrival times from the storm motion in each warning
 *   NOAA map services (AWC METARs)   surface observations layer
 * Collected every ~5 minutes by GitHub Actions into data/glm.json (collect_glm.py):
 *   NOAA GOES Geostationary Lightning Mapper flashes
 */
(() => {
  "use strict";

  const NWS = "https://api.weather.gov";
  const NOWCOAST = "https://nowcoast.noaa.gov/geoserver";
  const SPC = "https://www.spc.noaa.gov";
  const AWC_METAR = "https://mapservices.weather.noaa.gov/vector/rest/services/aviation/awc_aviation_weather/MapServer/42";
  const MD_LAYER = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/spc_mesoscale_discussion/MapServer/0";
  const CONUS = [[24, -125], [50, -66]];
  const RADAR_FRAMES = 12;           // about 2 hours at ~10-minute spacing
  const RADAR_STEP = 10 * 60000;

  // NWS hazard map colors (weather.gov), brightened slightly where the official color disappears on a dark map.
  const COLORS = {
    "Tornado Warning": "#ff2b2b", "Extreme Wind Warning": "#ff8c00", "Severe Thunderstorm Warning": "#ffa500",
    "Flash Flood Warning": "#c0182a", "Flash Flood Statement": "#c0182a", "Special Marine Warning": "#ffa500",
    "Tornado Watch": "#ffff00", "Severe Thunderstorm Watch": "#db7093", "Flash Flood Watch": "#2e8b57",
    "Flood Warning": "#00ff00", "Flood Watch": "#2e8b57", "Flood Advisory": "#00ff7f", "Flood Statement": "#00ff00",
    "Coastal Flood Warning": "#228b22", "Coastal Flood Watch": "#66cdaa", "Coastal Flood Advisory": "#7cfc00", "Coastal Flood Statement": "#6b8e23",
    "Hurricane Warning": "#dc143c", "Hurricane Watch": "#ff00ff", "Tropical Storm Warning": "#e03a3a", "Tropical Storm Watch": "#f08080",
    "Storm Surge Warning": "#b524f7", "Storm Surge Watch": "#db7ff7",
    "Blizzard Warning": "#ff4500", "Winter Storm Warning": "#ff69b4", "Winter Storm Watch": "#4682b4", "Ice Storm Warning": "#b03cb0",
    "Winter Weather Advisory": "#7b68ee", "Lake Effect Snow Warning": "#008b8b", "Cold Weather Advisory": "#afeeee", "Extreme Cold Warning": "#0000ff",
    "High Wind Warning": "#daa520", "High Wind Watch": "#b8860b", "Wind Advisory": "#d2b48c", "Red Flag Warning": "#ff1493", "Fire Weather Watch": "#ffdead",
    "Freeze Warning": "#6a5acd", "Freeze Watch": "#00ffff", "Frost Advisory": "#6495ed",
    "Extreme Heat Warning": "#c71585", "Extreme Heat Watch": "#800000", "Heat Advisory": "#ff7f50",
    "Dense Fog Advisory": "#a0aab8", "Dense Smoke Advisory": "#f0e68c", "Air Quality Alert": "#a0a0a0", "Blowing Dust Advisory": "#bdb76b", "Dust Storm Warning": "#ffe4c4",
    "Gale Warning": "#dda0dd", "Gale Watch": "#ffc0cb", "Storm Warning": "#9400d3", "Hurricane Force Wind Warning": "#cd5c5c",
    "Small Craft Advisory": "#d8bfd8", "Hazardous Seas Warning": "#d8bfd8", "Marine Weather Statement": "#ffdab9",
    "Rip Current Statement": "#40e0d0", "Beach Hazards Statement": "#40e0d0", "High Surf Advisory": "#ba55d3", "High Surf Warning": "#228b22",
    "Special Weather Statement": "#ffe4b5", "Hydrologic Outlook": "#90ee90", "Hazardous Weather Outlook": "#eee8aa",
  };
  const colorOf = (event) => COLORS[event] || "#9aa3c0";

  // Most urgent first. Anything not listed sorts after, alphabetically.
  const PRIORITY = [
    "Tornado Warning", "Extreme Wind Warning", "Severe Thunderstorm Warning", "Flash Flood Warning", "Hurricane Warning", "Storm Surge Warning",
    "Tropical Storm Warning", "Tornado Watch", "Severe Thunderstorm Watch", "Hurricane Watch", "Storm Surge Watch", "Tropical Storm Watch",
    "Flash Flood Watch", "Flood Warning", "Blizzard Warning", "Ice Storm Warning", "Winter Storm Warning", "Extreme Heat Warning", "Red Flag Warning",
    "High Wind Warning", "Dust Storm Warning", "Special Marine Warning", "Coastal Flood Warning", "Extreme Cold Warning", "Freeze Warning",
    "Winter Storm Watch", "Flood Watch", "High Wind Watch", "Fire Weather Watch", "Freeze Watch", "Special Weather Statement",
    "Winter Weather Advisory", "Heat Advisory", "Wind Advisory", "Flood Advisory", "Coastal Flood Advisory", "Frost Advisory", "Dense Fog Advisory",
  ];
  const rank = (e) => { const i = PRIORITY.indexOf(e); return i < 0 ? 999 : i; };

  const GROUPS = {
    land: { name: "All land", test: (e) => !MARINE.test(e) },
    severe: { name: "Severe", test: (e) => /Tornado|Severe Thunderstorm|Extreme Wind|Special Weather Statement/.test(e) },
    flood: { name: "Flood", test: (e) => /Flood|Hydrologic/.test(e) },
    winter: { name: "Winter", test: (e) => /Winter|Blizzard|Ice Storm|Snow|Freeze|Frost|Cold|Wind Chill/.test(e) },
    fire: { name: "Fire & wind", test: (e) => /Red Flag|Fire Weather|High Wind|Wind Advisory|Dust/.test(e) },
    tropical: { name: "Tropical", test: (e) => /Hurricane|Tropical Storm|Storm Surge|Typhoon/.test(e) && !/Force Wind/.test(e) },
    marine: { name: "Marine", test: (e) => MARINE.test(e) },
  };
  const MARINE = /Small Craft|Gale|Marine|Hazardous Seas|Storm Warning$|Storm Watch$|Hurricane Force Wind|Rip Current|Beach Hazards|Surf|Low Water|Brisk Wind|Freezing Spray/;

  const OUTLOOK = {
    "1": { name: "Day 1", files: { cat: "day1otlk_cat", torn: "day1otlk_torn", wind: "day1otlk_wind", hail: "day1otlk_hail" }, text: "day1otlk.txt" },
    "2": { name: "Day 2", files: { cat: "day2otlk_cat", torn: "day2otlk_torn", wind: "day2otlk_wind", hail: "day2otlk_hail" }, text: "day2otlk.txt" },
    "3": { name: "Day 3", files: { cat: "day3otlk_cat", prob: "day3otlk_prob" }, text: "day3otlk.txt" },
  };
  const OUTLOOK_TYPES = { cat: "Categorical", torn: "Tornado", wind: "Wind", hail: "Hail", prob: "Severe" };
  const REPORT_COLORS = { torn: "#ff453a", wind: "#0a84ff", hail: "#30d158" };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const hhmmZ = (iso) => { const d = new Date(iso); return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };
  const dayZ = (iso) => { const d = new Date(iso); return `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${hhmmZ(iso)}`; };
  const isoMin = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

  const state = {
    view: "alerts", group: "land", openEvent: null, selectedAlert: null,
    alerts: [], alertsTime: null,
    outlookDay: "1", outlookType: "cat", outlookGeo: null, outlookText: "",
    mds: null, reportsDay: "today", reports: null,
    on: { radar: true, alerts: true, outlook: false, mds: true, reports: true, lightning: true, obs: false },
    swath: { hail: "off", rot: "off" },
    point: null, glm: null, afd: null, obs: null,
    place: null,      // "My place": { label, lat, lon, alerts, radar, notify, seen }
    radar: { times: [], layers: [], idx: 0, timer: null, opacity: 0.75 },
  };

  // —— Map ————————————————————————————————————————————————————————
  const map = L.map("map", { zoomControl: false, minZoom: 3, maxZoom: 12 }).fitBounds(CONUS);
  L.control.zoom({ position: "topright" }).addTo(map);
  map.attributionControl.setPrefix("");
  [["radar", 300], ["swath", 330], ["outlook", 350], ["alerts", 400], ["highlight", 450], ["mds", 460], ["lightning", 600], ["points", 620], ["labels", 640]]
    .forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
  map.getPane("labels").style.pointerEvents = "none";
  map.getPane("alerts").style.pointerEvents = "none";
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Esri" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "labels", opacity: 0.85 }).addTo(map);
  map.attributionControl.addAttribution("NWS · SPC · NOAA nowCOAST");

  const lightningCanvas = L.canvas({ pane: "lightning", padding: 0.3 });
  const layers = {
    lightning: L.layerGroup(),
    hail: L.layerGroup().addTo(map),
    rot: L.layerGroup().addTo(map),
    alerts: L.tileLayer.wms(`${NOWCOAST}/alerts/wms`, { layers: "watches_warnings_advisories", format: "image/png", transparent: true, version: "1.3.0", pane: "alerts", opacity: 0.6, tileSize: 512, attribution: "" }),
    outlook: L.layerGroup(),
    mds: L.layerGroup(),
    reports: L.layerGroup(),
    highlight: L.layerGroup().addTo(map),
    obs: L.layerGroup(),
    place: L.layerGroup().addTo(map),
    tracks: L.layerGroup().addTo(map),
  };
  Object.entries(state.on).forEach(([k, v]) => { if (v && layers[k]) layers[k].addTo(map); });

  function setStatus(msg) { $("status").textContent = msg || ""; $("status").hidden = !msg; }

  // —— Radar loop (nowCOAST base reflectivity mosaic) ———————————————————
  async function radarTimes() {
    const res = await fetch(`${NOWCOAST}/observations/weather_radar/wms?service=WMS&version=1.3.0&request=GetCapabilities&_=${Date.now()}`);
    const xml = new DOMParser().parseFromString(await res.text(), "text/xml");
    const layer = [...xml.getElementsByTagName("Layer")].find((l) => l.getElementsByTagName("Name")[0]?.textContent === "base_reflectivity_mosaic");
    const dim = [...(layer?.getElementsByTagName("Dimension") || [])].find((d) => d.getAttribute("name") === "time");
    if (!dim) throw new Error("no radar times");
    const all = dim.textContent.trim().split(",").map((s) => s.trim()).filter(Boolean).sort();
    const picked = [];
    let next = Infinity;
    for (let i = all.length - 1; i >= 0 && picked.length < RADAR_FRAMES; i--) {
      const t = Date.parse(all[i]);
      if (t <= next) { picked.unshift(all[i]); next = t - RADAR_STEP + 60000; }
    }
    return picked;
  }

  function clearRadar() {
    radarLoop(false);
    state.radar.layers.forEach((l) => l.remove());
    state.radar.layers = [];
    state.radar.times = [];
  }

  async function loadRadar(force) {
    const r = state.radar;
    if (!state.on.radar) { clearRadar(); $("t1").textContent = "Radar off"; $("t0").textContent = ""; return; }
    try {
      const times = await radarTimes();
      if (!force && times[times.length - 1] === r.times[r.times.length - 1]) return;
      clearRadar();
      r.times = times;
      r.layers = times.map((t, i) => L.tileLayer.wms(`${NOWCOAST}/observations/weather_radar/wms`, {
        layers: "base_reflectivity_mosaic", format: "image/png", transparent: true, version: "1.3.0", time: t,
        pane: "radar", opacity: i === times.length - 1 ? r.opacity : 0, tileSize: 512, attribution: "",
      }));
      r.idx = times.length - 1;
      r.layers[r.idx].addTo(map);
      $("frame").max = times.length - 1;
      $("frame").value = r.idx;
      $("t0").textContent = hhmmZ(times[0]);
      radarLabel();
    } catch {
      $("t1").textContent = "Radar unavailable";
    }
  }

  function radarLabel() {
    const t = state.radar.times[state.radar.idx];
    if (t) $("t1").textContent = `Radar ${hhmmZ(t)}`;
  }

  function radarShow(i) {
    const r = state.radar;
    const n = r.layers.length;
    if (!n) return;
    const next = (i + n) % n;
    if (!map.hasLayer(r.layers[next])) r.layers[next].addTo(map);
    r.layers[next].setOpacity(r.opacity);
    r.layers.forEach((l, j) => { if (j !== next) l.setOpacity(0); });
    r.idx = next;
    $("frame").value = next;
    radarLabel();
  }

  function radarLoop(force) {
    const r = state.radar;
    const playing = force ?? !r.timer;
    clearInterval(r.timer);
    r.timer = null;
    $("play").textContent = playing ? "❚❚" : "▶";
    $("play").setAttribute("aria-label", playing ? "Pause radar loop" : "Play radar loop");
    if (!playing || !r.layers.length) return;
    r.layers.forEach((l) => { if (!map.hasLayer(l)) l.addTo(map); });
    let hold = 0;
    r.timer = setInterval(() => {
      if (r.idx === r.layers.length - 1 && hold++ < 2) return;
      hold = 0;
      radarShow(r.idx + 1);
    }, 500);
  }
  $("play").onclick = () => radarLoop();
  $("frame").oninput = (e) => { radarLoop(false); radarShow(+e.target.value); };

  // —— Alerts ——————————————————————————————————————————————————————
  async function loadAlerts() {
    const res = await fetch(`${NWS}/alerts/active?status=actual`, { headers: { Accept: "application/geo+json" } });
    if (!res.ok) throw new Error(`alerts ${res.status}`);
    const d = await res.json();
    state.alerts = d.features.map((f) => ({ ...f.properties, geometry: f.geometry }))
      .filter((a) => a.messageType !== "Cancel");
    state.alertsTime = d.updated || new Date().toISOString();
    $("updated").textContent = `As of ${hhmmZ(state.alertsTime)}`;
    layers.alerts.setParams({ _: Date.now() });   // redraw the polygon layer with the latest alerts
  }

  function alertsView() {
    const g = GROUPS[state.group];
    const counts = Object.fromEntries(Object.entries(GROUPS).map(([k, v]) => [k, state.alerts.filter((a) => v.test(a.event)).length]));
    const list = state.alerts.filter((a) => g.test(a.event));
    const byEvent = {};
    list.forEach((a) => { (byEvent[a.event] ||= []).push(a); });
    const events = Object.keys(byEvent).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const chips = `<div class="chips" role="group" aria-label="Alert type">${Object.entries(GROUPS).map(([k, v]) =>
      `<button data-group="${k}" aria-pressed="${k === state.group}">${v.name}<b>${counts[k]}</b></button>`).join("")}</div>`;
    if (!events.length) return chips + `<p class="empty">No active ${g.name.toLowerCase()} alerts.</p>`;
    return chips + events.map((e) => {
      const items = byEvent[e].sort((a, b) => new Date(a.expires) - new Date(b.expires));
      const open = state.openEvent === e;
      return `<div class="group${open ? " open" : ""}">
        <button class="row" data-event="${esc(e)}" aria-expanded="${open}"><i class="sw" style="background:${colorOf(e)}"></i>
          <span class="name">${esc(e)}<small>${esc(summaryOffices(items))}</small></span><span class="num">${items.length}</span></button>
        ${open ? items.map(alertRow).join("") : ""}</div>`;
    }).join("");
  }

  function summaryOffices(items) {
    const states = [...new Set(items.flatMap((a) => (a.geocode?.UGC || []).map((u) => u.slice(0, 2))))].sort();
    return states.length ? states.slice(0, 10).join(", ") + (states.length > 10 ? ` +${states.length - 10}` : "") : "";
  }

  function alertRow(a) {
    const sel = state.selectedAlert === a.id;
    const area = a.areaDesc.length > 90 ? `${a.areaDesc.slice(0, 90)}…` : a.areaDesc;
    return `<div class="alert${sel ? " sel" : ""}">
      <button class="row" data-alert="${esc(a.id)}" aria-expanded="${sel}"><span class="name">${esc(area)}<small>${esc(a.senderName.replace("NWS ", ""))}</small></span>
        <span class="num">until ${esc(dayZ(a.ends || a.expires))}</span></button>
      ${sel ? `<div class="alert__body">
        ${a.headline ? `<p><b>${esc(a.headline)}</b></p>` : ""}
        <pre>${esc(a.description || "")}${a.instruction ? `\n\n${esc(a.instruction)}` : ""}</pre>
      </div>` : ""}</div>`;
  }

  // Storm-based warnings carry their own polygon; others are drawn from their forecast zones.
  async function alertShape(a) {
    if (a.geometry) return a.geometry;
    const zones = (a.affectedZones || []).slice(0, 20);
    const shapes = await Promise.all(zones.map((z) => fetch(z, { headers: { Accept: "application/geo+json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    const feats = shapes.filter((s) => s?.geometry).map((s) => ({ type: "Feature", geometry: s.geometry, properties: {} }));
    return feats.length ? { type: "FeatureCollection", features: feats } : null;
  }

  async function selectAlert(id) {
    state.selectedAlert = state.selectedAlert === id ? null : id;
    layers.highlight.clearLayers();
    render();
    const a = state.alerts.find((x) => x.id === state.selectedAlert);
    if (!a) return;
    document.querySelector(".alert.sel")?.scrollIntoView({ block: "nearest" });
    const shape = await alertShape(a);
    if (!shape || state.selectedAlert !== a.id) return;
    const g = L.geoJSON(shape, { pane: "highlight", interactive: false, style: { color: "#fff", weight: 2, fillColor: colorOf(a.event), fillOpacity: 0.25 } }).addTo(layers.highlight);
    map.flyToBounds(g.getBounds().pad(0.4), { maxZoom: 8, duration: 0.6 });
  }

  // Click the map: identify alerts at that point from the nowCOAST layer.
  // Click the map: alerts at that spot (nowCOAST identify) and the NWS forecast there.
  map.on("click", async (e) => {
    const popup = L.popup({ maxWidth: 340 }).setLatLng(e.latlng).setContent(`<p>Loading…</p>`).openOn(map);
    const [alertsHtml, fc] = await Promise.all([identifyAlerts(e.latlng).catch(() => ""), loadPointForecast(e.latlng).catch(() => null)]);
    const fcHtml = (fc && fc.periods.length
      ? `<h4>Forecast · ${esc(fc.place)}</h4>${fc.periods.slice(0, 2).map((p) => `<p><b>${esc(p.name)}</b> ${p.temperature}°${esc(p.temperatureUnit)} · ${esc(p.shortForecast)} · wind ${esc(p.windSpeed)}</p>`).join("")}
        <p><a href="#" data-forecast="1">7-day and hourly forecast</a></p>`
      : `<p>No NWS forecast for this spot (outside the US forecast area).</p>`) +
      `<p><a href="#" data-watch="${e.latlng.lat.toFixed(4)},${e.latlng.lng.toFixed(4)}" data-label="${esc(fc?.place || "")}">Watch this spot</a> · <a href="/ForensicWeather/?loc=${e.latlng.lat.toFixed(4)},${e.latlng.lng.toFixed(4)}&amp;view=history">Hail history</a></p>`;
    popup.setContent([alertsHtml, fcHtml].filter(Boolean).join("<hr>"));
    if (state.view === "forecast") render();
  });

  async function identifyAlerts(latlng) {
    if (!state.on.alerts) return "";
    const size = map.getSize();
    const b = map.getBounds();
    const p = map.latLngToContainerPoint(latlng);
    const url = `${NOWCOAST}/alerts/wms?service=WMS&version=1.3.0&request=GetFeatureInfo&layers=watches_warnings_advisories&query_layers=watches_warnings_advisories` +
      `&info_format=application/json&feature_count=20&crs=EPSG:4326&bbox=${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}` +
      `&width=${size.x}&height=${size.y}&i=${Math.round(p.x)}&j=${Math.round(p.y)}` + (lastFilter ? `&CQL_FILTER=${encodeURIComponent(lastFilter)}` : "");
    const d = await (await fetch(url)).json();
    const seen = new Set();
    const feats = d.features.map((f) => f.properties).filter((p2) => !seen.has(p2.cap_id) && seen.add(p2.cap_id))
      .sort((x, y) => rank(x.prod_type) - rank(y.prod_type));
    return feats.map((p2) => {
      const a = state.alerts.find((x) => x.id === p2.cap_id);
      return `<h4><span class="dot" style="background:${colorOf(p2.prod_type)}"></span>${esc(p2.prod_type)}</h4>
        <p>${esc(a ? a.senderName.replace("NWS ", "") : p2.wfo)} · until ${esc(dayZ(p2.ends || p2.expiration))}${a ? ` · <a href="#" data-open="${esc(a.id)}">details</a>` : ""}</p>`;
    }).join("");
  }

  // —— Point forecast (NWS API) ———————————————————————————————————————
  async function loadPointForecast(latlng) {
    const pt = await (await fetch(`${NWS}/points/${latlng.lat.toFixed(4)},${latlng.lng.toFixed(4)}`)).json();
    const pr = pt.properties;
    if (!pr?.forecast) return null;
    const [daily, hourly] = await Promise.all([pr.forecast, pr.forecastHourly].map((u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    const rel = pr.relativeLocation?.properties;
    const fc = {
      lat: latlng.lat, lon: latlng.lng,
      place: rel ? `${rel.city}, ${rel.state}` : `${latlng.lat.toFixed(2)}, ${latlng.lng.toFixed(2)}`,
      office: pr.gridId, link: `https://forecast.weather.gov/MapClick.php?lat=${latlng.lat.toFixed(4)}&lon=${latlng.lng.toFixed(4)}`,
      updated: daily?.properties?.updateTime, periods: daily?.properties?.periods || [], hourly: (hourly?.properties?.periods || []).slice(0, 48),
    };
    state.point = fc;
    layers.highlight.clearLayers();
    L.circleMarker([fc.lat, fc.lon], { pane: "points", radius: 6, color: "#fff", weight: 2, fillColor: "#4ad1ff", fillOpacity: 1, interactive: false }).addTo(layers.highlight);
    return fc;
  }

  function hourlyChart(h) {
    if (h.length < 2) return "";
    const W = 336, H = 130, L0 = 26, R0 = 24, T0 = 8, B0 = 18;
    const temps = h.map((p) => p.temperature);
    const lo = Math.floor((Math.min(...temps) - 3) / 5) * 5, hi = Math.ceil((Math.max(...temps) + 3) / 5) * 5;
    const x = (i) => L0 + (i / (h.length - 1)) * (W - L0 - R0);
    const y = (v) => T0 + (1 - (v - lo) / (hi - lo)) * (H - T0 - B0);
    const yp = (v) => T0 + (1 - v / 100) * (H - T0 - B0);
    const mono = 'font-family="IBM Plex Mono, monospace" font-size="9.5" fill="rgba(255,255,255,.42)"';
    let svg = "";
    for (let v = lo; v <= hi; v += (hi - lo) > 30 ? 10 : 5) svg += `<line x1="${L0}" x2="${W - R0}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,.07)"/><text x="${L0 - 5}" y="${y(v) + 3}" text-anchor="end" ${mono}>${v}°</text>`;
    [0, 50, 100].forEach((v) => { svg += `<text x="${W - R0 + 4}" y="${yp(v) + 3}" ${mono} fill="#4ad1ff">${v}%</text>`; });
    h.forEach((p, i) => {
      const pop = p.probabilityOfPrecipitation?.value || 0;
      if (pop) svg += `<rect x="${(x(i) - 2.4).toFixed(1)}" y="${yp(pop).toFixed(1)}" width="4.8" height="${(H - B0 - yp(pop)).toFixed(1)}" fill="rgba(74,209,255,.35)"/>`;
      const d = new Date(p.startTime);
      if (d.getHours() % 12 === 0) svg += `<text x="${x(i).toFixed(1)}" y="${H - 4}" text-anchor="middle" ${mono}>${d.toLocaleTimeString("en-US", { hour: "numeric" }).replace(":00", "")}</text>`;
    });
    svg += `<polyline fill="none" stroke="#ffbf47" stroke-width="2" points="${h.map((p, i) => `${x(i).toFixed(1)},${y(p.temperature).toFixed(1)}`).join(" ")}"/>`;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly temperature and precipitation chance">${svg}</svg>
      <p class="chart-key"><span style="color:#ffbf47">━</span> temperature &nbsp;<span style="color:#4ad1ff">▮</span> chance of precipitation · next 48 hours, local time</p>`;
  }

  function forecastView() {
    const f = state.point;
    if (!f) return `<p class="empty">Click anywhere on the map for the National Weather Service forecast at that spot.</p>`;
    return `<div class="pad"><h5 class="sub">${esc(f.place)} · NWS ${esc(f.office)}${f.updated ? ` · updated ${esc(dayZ(f.updated))}` : ""}</h5>
      ${hourlyChart(f.hourly)}
      <table class="t" style="margin-top:.6rem"><tbody>${f.periods.map((p, i) => `<tr data-period="${i}"><td style="width:6.5rem"><b style="color:#fff">${esc(p.name)}</b><small>${p.probabilityOfPrecipitation?.value ? `${p.probabilityOfPrecipitation.value}% precip` : ""}</small></td>
        <td style="width:3rem;color:${p.isDaytime ? "#ffbf47" : "#7cb8ff"}">${p.temperature}°</td><td>${esc(p.shortForecast)}<small>${esc(p.windDirection)} ${esc(p.windSpeed)}</small>
        ${state.openPeriod === i ? `<small style="color:var(--text2);margin-top:.3rem">${esc(p.detailedForecast)}</small>` : ""}</td></tr>`).join("")}</tbody></table>
      <p class="note"><a href="${esc(f.link)}" target="_blank" rel="noopener">Full forecast at weather.gov ↗</a></p>
      ${afdHtml(f.office)}</div>`;
  }

  // —— Area forecast discussion (NWS API products) ———————————————————————————
  function afdHtml(office) {
    const a = state.afd;
    if (!office) return "";
    if (!a || a.office !== office || a.status === "closed") return `<p class="note"><button class="linkish" data-afd="${esc(office)}">Read the forecast discussion from NWS ${esc(office)}</button></p>`;
    if (a.status === "loading") return `<p class="note">Loading the forecast discussion…</p>`;
    if (a.status === "error") return `<p class="note">The forecast discussion couldn't be loaded.</p>`;
    return `<h5 class="sub" style="margin-top:.9rem">Area forecast discussion · NWS ${esc(office)} · ${esc(dayZ(a.issued))} <button class="linkish" data-afd-close="1">hide</button></h5>
      <pre class="afd">${esc(a.text)}</pre>`;
  }
  async function loadAfd(office) {
    state.afd = { office, status: "loading" };
    render();
    try {
      const list = await (await fetch(`${NWS}/products/types/AFD/locations/${office}`)).json();
      const latest = list["@graph"]?.[0];
      if (!latest) throw new Error("none");
      const prod = await (await fetch(latest["@id"])).json();
      // Drop the WMO header lines and keep the discussion itself.
      const text = (prod.productText || "").replace(/^[\s\S]*?(\.(?:KEY MESSAGES|SYNOPSIS|UPDATE|DISCUSSION|NEAR TERM|SHORT TERM)[^\n]*\n)/, "$1").replace(/\n{3,}/g, "\n\n").trim()
        // Unwrap the fixed-width lines so the text reflows in the sidebar; keep bullets, section heads and && breaks.
        .replace(/([^\n])\n(?!\n|\s*-\s|\.|&&)\s*/g, "$1 ").replace(/ {2,}/g, " ");
      state.afd = { office, status: "ready", issued: prod.issuanceTime, text };
    } catch {
      state.afd = { office, status: "error" };
    }
    if (state.view === "forecast") render();
  }

  // —— My place: alerts, lightning, radar and reports at one spot, with optional browser notifications ——————
  const PLACE_KEY = "sw-place";
  function savedPlace() { try { return JSON.parse(localStorage.getItem(PLACE_KEY) || "null"); } catch { return null; } }
  function setPlace(p, save = true) {
    state.place = { label: p.label || `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`, lat: p.lat, lon: p.lon, alerts: null, radar: null, notify: state.place?.notify || false, seen: new Set() };
    if (save) { try { localStorage.setItem(PLACE_KEY, JSON.stringify({ label: state.place.label, lat: p.lat, lon: p.lon })); } catch { /* private mode */ } }
    drawPlace();
    refreshPlace(true);
  }
  function drawPlace() {
    layers.place.clearLayers();
    const p = state.place;
    if (!p) return;
    L.circleMarker([p.lat, p.lon], { pane: "points", radius: 7, color: "#fff", weight: 2.5, fillColor: "#4ad1ff", fillOpacity: 1 })
      .bindTooltip(`My place · ${esc(p.label)}`, { className: "tw-tip", direction: "top", offset: [0, -8] }).addTo(layers.place);
    [16.09, 48.28].forEach((km) => L.circle([p.lat, p.lon], { pane: "points", radius: km * 1000, color: "#4ad1ff", weight: 1, opacity: 0.5, fill: false, dashArray: "4 4", interactive: false }).addTo(layers.place));
  }
  const kmBetween = (lat1, lon1, lat2, lon2) => {
    const r = Math.PI / 180, a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  };
  const mi = (km) => (km * 0.621371 < 10 ? (km * 0.621371).toFixed(1) : Math.round(km * 0.621371));
  async function refreshPlace(first) {
    const p = state.place;
    if (!p) return;
    const [alerts, radar] = await Promise.all([
      fetch(`${NWS}/alerts/active?point=${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, { headers: { Accept: "application/geo+json" } }).then((r) => r.json()).then((d) => d.features.map((f) => f.properties)).catch(() => null),
      p.lat > 20 && p.lat < 55 && p.lon > -130 && p.lon < -60 ? MRMS.fetchProduct("reflectivity", new Date().toISOString(), p.lat, p.lon, { halfLat: 0.3, maxMinutes: 15 }).catch(() => null) : null,
    ]);
    if (state.place !== p) return;
    p.alerts = alerts;
    p.radar = radar;
    p.checked = new Date().toISOString();
    drawStormTracks();
    if (state.view === "place") render();
    notifyPlace(first);
  }
  /** Flashes, by age, within 10 and 30 miles of the place, and the nearest one. */
  function placeLightning(p) {
    const g = state.glm;
    if (!g || g.missing || !g.cells) return null;
    let near = null, n10 = 0, n30 = 0;
    for (const [lat, lon, n, age] of g.cells) {
      if (age + g.lag > g.windowMinutes + 10) continue;
      const km = kmBetween(p.lat, p.lon, lat, lon);
      if (km <= 16.09) n10 += n;
      if (km <= 48.28) n30 += n;
      if (!near || km < near.km) near = { km, age: age + g.lag };
    }
    return { near, n10, n30 };
  }
  // —— Storm arrival: NWS warnings carry the storm's position, heading and speed (eventMotionDescription) ———————
  // e.g. "2021-12-11T03:26:00-00:00...storm...236DEG...48KT...36.75,-88.65". The heading is where the storm is
  // moving from, as in the warning's TIME...MOT...LOC line. Several positions mean a line of storms.
  function stormMotion(a) {
    const m = (a.parameters?.eventMotionDescription || [])[0]?.match(/^(\S+?)\.\.\.(\w+)\.\.\.(\d+)DEG\.\.\.(\d+)KT\.\.\.(.+)$/);
    if (!m) return null;
    const pts = m[5].trim().split(/\s+/).map((ll) => ll.split(",").map(Number)).filter(([la, lo]) => isFinite(la) && isFinite(lo));
    const t = Date.parse(m[1]);
    if (!pts.length || !isFinite(t)) return null;
    return { t, kind: m[2], from: +m[3], kt: +m[4], pts };
  }
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

  /**
   * When a warned storm reaches the place, if it keeps its heading and speed. Works in km on a flat projection
   * around the place: "along" is distance along the storm's track (negative = storm still upstream), "cross" is
   * the sideways miss distance. For a line of storms, the line reaches the place where it crosses the track
   * through the place; otherwise the nearest end of the line is used.
   */
  function stormArrival(mo, p, now = Date.now()) {
    const kx = 111.32 * Math.cos((p.lat * Math.PI) / 180), ky = 110.57;
    const toward = ((mo.from + 180) * Math.PI) / 180;
    const u = [Math.sin(toward), Math.cos(toward)];
    const kmh = mo.kt * 1.852;
    const ac = mo.pts.map(([la, lo]) => {
      const dx = (lo - p.lon) * kx, dy = (la - p.lat) * ky;
      return { along: dx * u[0] + dy * u[1], cross: dx * u[1] - dy * u[0] };
    });
    let hit = null;
    for (let i = 0; i < ac.length - 1 && !hit; i++) {
      const [a, b] = [ac[i], ac[i + 1]];
      if ((a.cross <= 0 && b.cross >= 0) || (a.cross >= 0 && b.cross <= 0)) {
        const f = a.cross === b.cross ? 0 : a.cross / (a.cross - b.cross);
        hit = { along: a.along + f * (b.along - a.along), cross: 0 };
      }
    }
    if (!hit) hit = ac.reduce((best, c) => (Math.abs(c.cross) < Math.abs(best.cross) ? c : best));
    if (!kmh) return null;
    const eta = mo.t + (-hit.along / kmh) * 3600000;
    const side = hit.cross === 0 ? "" : compass((toward * 180) / Math.PI + (hit.cross > 0 ? 90 : -90));
    return { eta, missKm: Math.abs(hit.cross), side, minutes: (eta - now) / 60000, mph: Math.round(mo.kt * 1.15078), toward: compass((toward * 180) / Math.PI), line: mo.pts.length > 1 };
  }
  const STORM_EVENTS = /Tornado Warning|Severe Thunderstorm Warning|Extreme Wind Warning|Special Weather Statement|Special Marine Warning|Severe Weather Statement/;
  /** Warned storms on course to pass within 15 miles in the next 3 hours (or that passed in the last 15 minutes). */
  function approachingStorms(p) {
    const out = [];
    for (const a of state.alerts) {
      if (!STORM_EVENTS.test(a.event)) continue;
      const mo = stormMotion(a);
      if (!mo) continue;
      if (kmBetween(p.lat, p.lon, mo.pts[0][0], mo.pts[0][1]) > 500) continue;
      const r = stormArrival(mo, p);
      if (!r || r.missKm > 24.1 || r.minutes < -15 || r.minutes > 180) continue;
      out.push({ a, mo, ...r });
    }
    return out.sort((x, y) => x.eta - y.eta);
  }
  function drawStormTracks() {
    layers.tracks.clearLayers();
    const p = state.place;
    if (!p) return;
    approachingStorms(p).forEach((s) => {
      const toward = ((s.mo.from + 180) * Math.PI) / 180;
      const kx = 111.32 * Math.cos((p.lat * Math.PI) / 180);
      const km = (s.mo.kt * 1.852 * Math.max(0, s.eta - s.mo.t + 30 * 60000)) / 3600000;
      const color = colorOf(s.a.event);
      s.mo.pts.forEach(([la, lo]) => {
        const end = [la + (km * Math.cos(toward)) / 110.57, lo + (km * Math.sin(toward)) / kx];
        L.polyline([[la, lo], end], { pane: "points", color, weight: 2, dashArray: "6 6", opacity: 0.9, interactive: false }).addTo(layers.tracks);
      });
      L.polyline(s.mo.pts, { pane: "points", color, weight: 4, opacity: 0.95 })
        .bindTooltip(`${esc(s.a.event)} · ${esc(etaText(s))}`, { className: "tw-tip", sticky: true }).addTo(layers.tracks);
      if (s.mo.pts.length === 1) L.circleMarker(s.mo.pts[0], { pane: "points", radius: 6, color, weight: 2, fillColor: "#060818", fillOpacity: 1 })
        .bindTooltip(`${esc(s.a.event)} · ${esc(etaText(s))}`, { className: "tw-tip" }).addTo(layers.tracks);
    });
  }
  const localTime = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  function etaText(s) {
    if (s.minutes < 0) return `passed about ${Math.round(-s.minutes)} min ago`;
    const plus = Math.max(5, Math.round((s.minutes * 0.2) / 5) * 5);
    return `about ${localTime(s.eta)} (${hhmmZ(s.eta)}), in ${Math.round(s.minutes)} min ±${plus}`;
  }

  function notifyPlace(first) {
    const p = state.place;
    if (!p?.notify || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const fresh = (p.alerts || []).filter((a) => !p.seen.has(a.id));
    fresh.forEach((a) => p.seen.add(a.id));
    const lt = placeLightning(p);
    const msgs = first ? [] : fresh.map((a) => `${a.event} until ${dayZ(a.expires)}`);
    if (!first && lt?.n10 && !p.lightningWarned) { msgs.push(`Lightning within 10 miles (${lt.n10} flashes in 15 min)`); p.lightningWarned = true; }
    if (lt && !lt.n10) p.lightningWarned = false;
    approachingStorms(p).filter((s) => s.minutes > 0 && s.minutes <= 60 && !p.seen.has(`eta:${s.a.id}`)).forEach((s) => {
      p.seen.add(`eta:${s.a.id}`);
      if (!first) msgs.push(`${s.a.event} storm reaches you ${etaText(s)}`);
    });
    msgs.forEach((m) => { try { new Notification(`NowWeather · ${p.label}`, { body: m, icon: "/assets/icon-192.png" }); } catch { /* not allowed here */ } });
  }

  // —— Storm log: a timestamped record of conditions at the place every 5 minutes while the page is open ——————
  // Kept in this browser (localStorage) so a reload doesn't lose it. Each row: alerts in effect, radar and MRMS
  // hail at the spot, nearby lightning, and the latest reading at the nearest NWS observing station.
  const LOG_KEY = "sw-stormlog";
  const LOG_EVERY = 5 * 60000;
  let logTimer = null;
  function loadLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY) || "null"); } catch { return null; } }
  function saveLog() { try { localStorage.setItem(LOG_KEY, JSON.stringify(state.log)); } catch { /* full or private mode */ } }
  state.log = loadLog();

  async function nearestStation(p) {
    if (p.station !== undefined) return p.station;
    p.station = null;
    try {
      const pt = await (await fetch(`${NWS}/points/${p.lat.toFixed(4)},${p.lon.toFixed(4)}`)).json();
      const list = await (await fetch(pt.properties.observationStations)).json();
      const f = list.features?.[0];
      if (f) p.station = { id: f.properties.stationIdentifier, name: f.properties.name, km: kmBetween(p.lat, p.lon, f.geometry.coordinates[1], f.geometry.coordinates[0]) };
    } catch { /* outside the NWS area */ }
    return p.station;
  }
  const num = (q) => (q && q.value != null ? q.value : null);
  async function logSample() {
    const p = state.place, log = state.log;
    if (!p || !log?.on) return;
    const st = await nearestStation(p);
    const inMrms = p.lat > 20 && p.lat < 55 && p.lon > -130 && p.lon < -60;
    const [obs, hail] = await Promise.all([
      st ? fetch(`${NWS}/stations/${st.id}/observations/latest`).then((r) => r.json()).then((d) => d.properties).catch(() => null) : null,
      inMrms ? MRMS.fetchProduct("hail60", new Date().toISOString(), p.lat, p.lon, { halfLat: 0.2, mode: "atOrBefore", maxMinutes: 30 }).catch(() => null) : null,
    ]);
    if (state.log !== log || !log.on) return;
    const lt = placeLightning(p);
    const c2f = (c) => (c == null ? null : Math.round((c * 9) / 5 + 32));
    const kmh2mph = (k) => (k == null ? null : Math.round(k * 0.621371));
    log.rows.push({
      t: new Date().toISOString(),
      alerts: (p.alerts || []).map((a) => a.event).sort((x, y) => rank(x) - rank(y)),
      eta: approachingStorms(p).filter((x) => x.minutes >= 0).map((x) => `${x.a.event} ${hhmmZ(x.eta)}`),
      dbz: p.radar?.at > 0 ? Math.round(p.radar.at) : 0, dbzNear: p.radar?.peak > 0 ? Math.round(p.radar.peak) : 0,
      hail: hail?.at > 0 ? +(hail.at / 25.4).toFixed(2) : 0, hailNear: hail?.peak > 0 ? +(hail.peak / 25.4).toFixed(2) : 0,
      ltMi: lt?.near ? +mi(lt.near.km) : null, lt10: lt ? lt.n10 : null,
      stn: st?.id || null, obsT: obs?.timestamp || null, tempF: c2f(num(obs?.temperature)), windMph: kmh2mph(num(obs?.windSpeed)),
      gustMph: kmh2mph(num(obs?.windGust)), windDir: num(obs?.windDirection), rainIn: num(obs?.precipitationLastHour) != null ? +(num(obs.precipitationLastHour) / 25.4).toFixed(2) : null,
      wx: obs?.textDescription || "",
    });
    if (log.rows.length > 2000) log.rows.shift();
    saveLog();
    if (state.view === "place") render();
  }
  function startLog() {
    const p = state.place;
    if (!p) return;
    const same = state.log && Math.abs(state.log.lat - p.lat) < 1e-4 && Math.abs(state.log.lon - p.lon) < 1e-4;
    if (!same) state.log = { label: p.label, lat: p.lat, lon: p.lon, started: new Date().toISOString(), rows: [] };
    state.log.on = true;
    saveLog();
    clearInterval(logTimer);
    logTimer = setInterval(logSample, LOG_EVERY);
    logSample();
  }
  function stopLog() { if (state.log) { state.log.on = false; saveLog(); } clearInterval(logTimer); logTimer = null; }

  const LOG_COLS = [
    ["Time (UTC)", (r) => r.t.replace("T", " ").slice(0, 16)], ["Alerts in effect", (r) => r.alerts.join("; ")], ["Storms on the way (arrival UTC)", (r) => (r.eta || []).join("; ")],
    ["Radar here (dBZ)", (r) => r.dbz], ["Radar within 6 mi (dBZ)", (r) => r.dbzNear], ['MRMS hail here, last hour (in)', (r) => r.hail], ['MRMS hail within 6 mi (in)', (r) => r.hailNear],
    ["Nearest lightning (mi)", (r) => r.ltMi ?? ""], ["Flashes within 10 mi, 15 min", (r) => r.lt10 ?? ""], ["Station", (r) => r.stn || ""], ["Station obs time (UTC)", (r) => (r.obsT ? r.obsT.replace("T", " ").slice(0, 16) : "")],
    ["Temp (°F)", (r) => r.tempF ?? ""], ["Wind (mph)", (r) => r.windMph ?? ""], ["Gust (mph)", (r) => r.gustMph ?? ""], ["Wind from (°)", (r) => r.windDir ?? ""], ["Rain last hour (in)", (r) => r.rainIn ?? ""], ["Weather", (r) => r.wx],
  ];
  function logCsv() {
    const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const head = `# Standard Weather NowWeather storm log · ${state.log.label} (${state.log.lat.toFixed(4)}, ${state.log.lon.toFixed(4)}) · started ${state.log.started}\n`;
    const blob = new Blob([head + [LOG_COLS.map((c) => q(c[0])).join(","), ...state.log.rows.map((r) => LOG_COLS.map((c) => q(c[1](r))).join(","))].join("\n")], { type: "text/csv" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `storm-log-${state.log.started.slice(0, 10)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function logPrint() {
    const l = state.log;
    const w = window.open("", "_blank");
    if (!w) { setStatus("Allow pop-ups to print the storm log"); return; }
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Storm log · ${esc(l.label)}</title>
      <style>body{font:12px/1.4 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0 0 4px}p{margin:0 0 12px;color:#444}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:3px 5px;text-align:left;vertical-align:top}th{background:#eee;font-weight:600}</style>
      <h1>Storm log · ${esc(l.label)}</h1>
      <p>${l.lat.toFixed(4)}, ${l.lon.toFixed(4)} · started ${esc(l.started.replace("T", " ").slice(0, 16))} UTC · ${l.rows.length} readings, every 5 minutes while NowWeather was open.<br>
      Sources: NWS alerts and station observations (api.weather.gov), NOAA MRMS radar and hail (noaa-mrms-pds), NOAA GOES lightning. Recorded by Standard Weather NowWeather; not an official record.</p>
      <table><thead><tr>${LOG_COLS.map((c) => `<th>${esc(c[0])}</th>`).join("")}</tr></thead><tbody>
      ${l.rows.map((r) => `<tr>${LOG_COLS.map((c) => `<td>${esc(c[1](r))}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    w.document.close();
    w.focus();
    w.print();
  }
  function logHtml(p) {
    const l = state.log;
    const here = l && Math.abs(l.lat - p.lat) < 1e-4 && Math.abs(l.lon - p.lon) < 1e-4;
    const last = here && l.rows[l.rows.length - 1];
    let html = `<h5 class="sub" style="margin-top:1.1rem">Storm log</h5>`;
    if (!here || !l.rows.length && !l.on) {
      html += `<p class="note">Record conditions here every 5 minutes while this page is open: alerts, radar, MRMS hail, lightning and the nearest station's wind, gust and rain. Download it as a spreadsheet or print it for a claim.</p>
        <div class="actions"><button class="btn" data-log="start">Start storm log</button>${l?.rows?.length && !here ? `<span class="note" style="margin:0">Starting replaces the log for ${esc(l.label)}.</span>` : ""}</div>`;
      return html;
    }
    html += `<p class="note">${l.on ? "<b>Recording</b>" : "Stopped"} · ${l.rows.length} reading${l.rows.length === 1 ? "" : "s"} since ${esc(dayZ(l.started))}${last ? ` · last ${hhmmZ(last.t)}` : ""}. Keep this tab open; it records only while the page is open.</p>`;
    if (last) {
      const peak = (k) => Math.max(0, ...l.rows.map((r) => r[k] ?? 0));
      html += `<table class="t"><tbody>
        <tr><td>Peak gust at ${esc(last.stn || "station")}</td><td>${peak("gustMph") ? `${peak("gustMph")} mph` : "—"}</td></tr>
        <tr><td>Largest MRMS hail here</td><td>${peak("hail") ? `${peak("hail")}"` : "None"}</td></tr>
        <tr><td>Strongest radar here</td><td>${peak("dbz") ? `${peak("dbz")} dBZ` : "No echo"}</td></tr>
        <tr><td>Closest lightning</td><td>${l.rows.some((r) => r.ltMi != null) ? `${Math.min(...l.rows.filter((r) => r.ltMi != null).map((r) => r.ltMi))} mi` : "None"}</td></tr>
      </tbody></table>`;
    }
    html += `<div class="actions">${l.on ? `<button class="linkish" data-log="stop">Stop</button>` : `<button class="linkish" data-log="start">Resume</button>`}
      <button class="linkish" data-log="csv"${l.rows.length ? "" : " disabled"}>Download CSV</button><button class="linkish" data-log="print"${l.rows.length ? "" : " disabled"}>Print</button>
      ${l.on ? "" : `<button class="linkish" data-log="clear">Clear</button>`}</div>`;
    return html;
  }

  function placeView() {
    const p = state.place;
    const saved = savedPlace();
    const intro = `<div class="pad"><p class="note" style="margin-top:0">Pick a spot to watch: your location, a spot you click on the map (then “Watch this spot”), or the last place you used on Standard Weather.</p>
      <div class="actions"><button class="btn" data-locate="1">Use my location</button>${saved && (!p || saved.lat !== p.lat || saved.lon !== p.lon) ? `<button class="linkish" data-saved="1">Use ${esc(saved.label)}</button>` : ""}</div></div>`;
    if (!p) return intro;
    const stat = (label, value, small) => `<div class="stat"><span>${label}${small ? `<small>${small}</small>` : ""}</span><b>${value}</b></div>`;
    const lt = placeLightning(p);
    const reports = (state.reports || []).map((r) => ({ ...r, km: kmBetween(p.lat, p.lon, r.lat, r.lon) })).filter((r) => r.km <= 40.2).sort((a, b) => a.km - b.km);
    let html = `<div class="pad"><h5 class="sub">My place · ${esc(p.label)}${p.checked ? ` · checked ${hhmmZ(p.checked)}` : ""}</h5>`;
    if (p.alerts == null) html += `<p class="note">Checking alerts…</p>`;
    else if (!p.alerts.length) html += stat("Alerts", "None", "No NWS watches, warnings or advisories in effect here");
    else html += p.alerts.sort((a, b) => rank(a.event) - rank(b.event)).map((a) => `<div class="stat"><span><i class="dot" style="background:${colorOf(a.event)}"></i>${esc(a.event)}<small>${esc(a.senderName?.replace("NWS ", "") || "")} · until ${esc(dayZ(a.ends || a.expires))}</small></span>${state.alerts.some((x) => x.id === a.id) ? `<button class="linkish" data-goalert="${esc(a.id)}">details</button>` : ""}</div>`).join("");
    const storms = approachingStorms(p);
    html += storms.length ? storms.map((st) => `<div class="stat eta"><span><i class="dot" style="background:${colorOf(st.a.event)}"></i>${st.minutes < 0 ? "Storm passed" : st.line ? "Line of storms arrives" : "Storm arrives"}<small>${esc(st.a.event)} · moving ${st.toward} at ${st.mph} mph${st.missKm >= 1.6 ? ` · passes ${mi(st.missKm)} mi to the ${st.side}` : " · on a direct path"} · position as of ${hhmmZ(st.mo.t)}</small></span><b>${st.minutes < 0 ? `${Math.round(-st.minutes)} min ago` : localTime(st.eta)}</b></div>${st.minutes >= 0 ? `<p class="note eta-note">In ${Math.round(st.minutes)} min, give or take ${Math.max(5, Math.round((st.minutes * 0.2) / 5) * 5)}, if it keeps its heading and speed.</p>` : ""}`).join("")
      : stat("Storms heading here", "None", "No warned storm is on course to pass within 15 mi in the next 3 hours");
    html += lt ? stat("Lightning, 15 min", lt.near ? `${mi(lt.near.km)} mi` : "None", lt.near ? `Nearest flash, ${Math.round(lt.near.age)} min ago · ${lt.n10} within 10 mi · ${lt.n30} within 30 mi` : "No flashes within the GOES lightning window") : stat("Lightning", "—", "Lightning data unavailable");
    if (p.radar) html += stat("Radar now", p.radar.at > 0 ? `${Math.round(p.radar.at)} dBZ` : "No echo", `${p.radar.peak > 0 ? `Strongest within 6 mi: ${Math.round(p.radar.peak)} dBZ` : "Nothing within 6 mi"} · MRMS ${hhmmZ(p.radar.timeIso)}`);
    html += stat("Storm reports today", reports.length, reports[0] ? `Nearest: ${reportLabel(reports[0])}, ${mi(reports[0].km)} mi, ${esc(reports[0].time)}Z` : "None within 25 mi since 1200Z");
    const canNotify = typeof Notification !== "undefined";
    html += `<label class="notify"><input type="checkbox" data-notify="1"${p.notify ? " checked" : ""}${canNotify ? "" : " disabled"} /> Notify me of new alerts and lightning within 10 mi while this page is open</label>
      <div class="actions"><button class="linkish" data-locate="1">Use my location</button><button class="linkish" data-forecast-here="1">Forecast here</button>
        <a class="linkish" href="/ForensicWeather/?loc=${p.lat.toFixed(4)},${p.lon.toFixed(4)}&amp;view=history">Hail history</a><button class="linkish" data-clear="1">Stop watching</button></div>
      <p class="note">Rings at 10 and 30 miles. Checked every 2 minutes. Storm arrival times come from the storm motion in each NWS warning.</p>${logHtml(p)}</div>`;
    return html;
  }

  // —— Hail and rotation swaths (NOAA MRMS, decoded for the current view) ———————————
  const SWATH = { hail60: "Hail size, last hour", hail: "Hail size, last 24 h", rotation60: "Rotation, last hour", rotation: "Rotation, last 24 h" };
  let swathTimer = null;
  async function drawSwath(kind) {
    const name = state.swath[kind];
    const group = layers[kind];
    if (name === "off") { group.clearLayers(); drawLegend(); return; }
    const b = map.getBounds().pad(0.15);
    const bounds = { south: Math.max(20, b.getSouth()), north: Math.min(55, b.getNorth()), west: Math.max(-130, b.getWest()), east: Math.min(-60, b.getEast()) };
    if (bounds.north <= bounds.south || bounds.east <= bounds.west) { group.clearLayers(); return; }
    setStatus(`Loading ${SWATH[name].toLowerCase()}…`);
    try {
      const f = await MRMS.fetchProduct(name, new Date().toISOString(), null, null, { bounds, maxPixels: 1400, mode: "atOrBefore", maxMinutes: name.endsWith("60") ? 30 : 90 });
      if (state.swath[kind] !== name) return;
      group.clearLayers();
      if (f) L.imageOverlay(f.url, f.bounds, { pane: "swath", opacity: f.opacity, interactive: false }).addTo(group);
      state.swath[`${kind}Time`] = f?.timeIso || null;
    } catch { /* leave the previous image */ }
    setStatus("");
    drawLegend();
  }
  const redrawSwaths = () => { clearTimeout(swathTimer); swathTimer = setTimeout(() => { drawSwath("hail"); drawSwath("rot"); }, 400); };
  map.on("moveend", () => { if (state.swath.hail !== "off" || state.swath.rot !== "off") redrawSwaths(); });

  ["hail", "rot"].forEach((kind) => {
    $(`${kind}pick`).addEventListener("click", (e) => {
      const v = e.target.closest("[data-v]")?.dataset.v;
      if (!v) return;
      state.swath[kind] = v;
      document.querySelectorAll(`#${kind}pick [data-v]`).forEach((b2) => b2.setAttribute("aria-pressed", b2.dataset.v === v));
      drawSwath(kind);
    });
  });

  // —— Lightning (NOAA GOES GLM, collected by collect_glm.py) ————————————————
  const AGE_COLOR = (m) => (m < 5 ? "#ffffff" : m < 10 ? "#ffe27a" : "#ff9548");
  async function loadLightning() {
    const res = await fetch(`data/glm.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) { state.glm = { missing: true }; drawLegend(); return; }
    const d = await res.json();
    const lag = (Date.now() - Date.parse(d.generated)) / 60000;
    state.glm = { ...d, lag };
    layers.lightning.clearLayers();
    for (const [lat, lon, n, age] of d.cells) {
      const total = age + lag;
      if (total > d.windowMinutes + 10) continue;
      L.circleMarker([lat, lon], { renderer: lightningCanvas, radius: Math.min(6, 1.6 + Math.log2(n)), weight: 0, fillColor: AGE_COLOR(total), fillOpacity: 0.9, interactive: false }).addTo(layers.lightning);
    }
    drawLegend();
  }

  // —— Surface observations (AWC METAR layer: temperature, wind and gusts) ———————————————
  const tempColor = (f) => (f == null ? "#9aa3c0" : f < 10 ? "#b38bff" : f < 32 ? "#7cb8ff" : f < 50 ? "#6fe3e8" : f < 65 ? "#9be15d" : f < 80 ? "#ffe27a" : f < 95 ? "#ff9548" : "#ff5a5a");
  async function loadObs() {
    setStatus("Loading surface observations…");
    const fetchPage = (offset) => fetch(`${AWC_METAR}/query?${new URLSearchParams({ where: "1=1", geometry: "-170,15,-50,72", geometryType: "esriGeometryEnvelope", inSR: 4326, outFields: "station_id,observation_time,temp_c,dewpoint_c,winddir,wind_speed_kt,wind_gust_kt,wx_string", f: "geojson", resultOffset: offset, resultRecordCount: 2000 })}`).then((r) => r.json());
    const pages = await Promise.all([0, 2000, 4000].map(fetchPage));
    const idx = {};
    for (const f of pages.flatMap((p) => p.features || [])) {
      const p = f.properties, c = f.geometry?.type === "MultiPoint" ? f.geometry.coordinates[0] : f.geometry?.coordinates;
      if (!p.station_id || !c) continue;
      if (!idx[p.station_id] || p.observation_time > idx[p.station_id].observation_time) idx[p.station_id] = { ...p, lat: c[1], lon: c[0] };
    }
    state.obs = Object.values(idx);
    state.obsTime = Date.now();
    setStatus("");
    drawObs();
  }
  const kt2mph = (kt) => Math.round(kt * 1.15078);
  function drawObs() {
    layers.obs.clearLayers();
    if (!state.on.obs || !state.obs) return;
    const z = map.getZoom(), b = map.getBounds().pad(0.1);
    for (const o of state.obs) {
      if (!b.contains([o.lat, o.lon])) continue;
      const tf = o.temp_c == null ? null : Math.round(o.temp_c * 9 / 5 + 32);
      const wind = o.wind_speed_kt == null ? "" : o.wind_speed_kt === 0 ? "calm" : `${o.winddir != null && o.winddir !== "VRB" ? `${o.winddir}° ` : ""}${kt2mph(o.wind_speed_kt)}${o.wind_gust_kt ? `G${kt2mph(o.wind_gust_kt)}` : ""} mph`;
      const tip = `${esc(o.station_id)} · ${tf != null ? `${tf}°F` : "—"}${o.dewpoint_c != null ? ` / dew ${Math.round(o.dewpoint_c * 9 / 5 + 32)}°` : ""} · ${esc(wind)}${o.wx_string ? ` · ${esc(o.wx_string)}` : ""} · ${hhmmZ(o.observation_time)}`;
      if (z >= 7) {
        L.marker([o.lat, o.lon], { pane: "points", icon: L.divIcon({ className: "obs", iconSize: [40, 26], iconAnchor: [20, 13],
          html: `<b style="color:${tempColor(tf)}">${tf ?? "—"}</b>${o.wind_gust_kt ? `<small>G${kt2mph(o.wind_gust_kt)}</small>` : ""}` }) })
          .bindTooltip(tip, { className: "tw-tip", direction: "top" }).addTo(layers.obs);
      } else {
        L.circleMarker([o.lat, o.lon], { renderer: lightningCanvas, radius: z <= 4 ? 2 : 3, weight: 0, fillColor: tempColor(tf), fillOpacity: 0.85 })
          .bindTooltip(tip, { className: "tw-tip" }).addTo(layers.obs);
      }
    }
  }
  map.on("moveend", () => { if (state.on.obs) { drawObs(); drawLegend(); } });

  const ago = (min) => (min < 90 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${Math.floor(min % 60)} min`);

  // —— Map legend ———————————————————————————————————————————————————
  const Legend = L.Control.extend({ options: { position: "bottomright" }, onAdd() { const d = L.DomUtil.create("div", "maplegend"); d.id = "legend"; return d; } });
  new Legend().addTo(map);
  function drawLegend() {
    const parts = [];
    const sw = (name, kind) => {
      if (name === "off") return;
      const stops = name.startsWith("hail") ? MRMS.legends.hail.map(([v, c]) => [`${v.toFixed(2).replace(/0$/, "")}"`, c]) : MRMS.legends.rotation.map(([v, c]) => [`${v}`, c]);
      const t = state.swath[`${kind}Time`];
      parts.push(`<h5 class="sub">${esc(SWATH[name])}${name.startsWith("rot") ? " (×10⁻³ s⁻¹)" : ""}${t ? ` · to ${hhmmZ(t)}` : ""}</h5><div class="key">${stops.map(([l, c]) => `<span><i style="background:rgb(${c})"></i>${l}+</span>`).join("")}</div>`);
    };
    sw(state.swath.hail, "hail");
    sw(state.swath.rot, "rot");
    if (state.on.obs) parts.push(`<h5 class="sub">Surface temperature (°F)${map.getZoom() >= 7 ? " · G = gust, mph" : " · zoom in for values"}</h5><div class="key">${[["<10", "#b38bff"], ["10", "#7cb8ff"], ["32", "#6fe3e8"], ["50", "#9be15d"], ["65", "#ffe27a"], ["80", "#ff9548"], ["95+", "#ff5a5a"]].map(([l, c]) => `<span><i style="background:${c};border-radius:50%"></i>${l}</span>`).join("")}</div>`);
    if (state.on.lightning && state.glm && (state.glm.missing || state.glm.lag > state.glm.windowMinutes + 10)) {
      // Every flash is older than the page draws, so say why the map shows none.
      const g = state.glm;
      parts.push(`<h5 class="sub">Lightning (GOES GLM) · ${g.missing ? "unavailable" : `no recent data · last update ${ago(g.lag)} ago`}</h5>`);
    } else if (state.on.lightning && state.glm) {
      const g = state.glm;
      parts.push(`<h5 class="sub">Lightning (GOES GLM) · ${g.flashes} flashes${g.lag > 20 ? ` · ${Math.round(g.lag)} min old` : ""}</h5><div class="key"><span><i style="background:#fff;border-radius:50%"></i>&lt; 5 min</span><span><i style="background:#ffe27a;border-radius:50%"></i>5–10</span><span><i style="background:#ff9548;border-radius:50%"></i>10–15+</span></div>`);
    }
    $("legend").innerHTML = parts.join("");
  }

  // Popup content arrives after the popup opens, so links inside it are handled by delegation.
  map.getContainer().addEventListener("click", (ev) => {
    const w = ev.target.closest(".leaflet-popup [data-watch]");
    if (w) {
      ev.preventDefault();
      const [lat, lon] = w.dataset.watch.split(",").map(Number);
      setPlace({ label: w.dataset.label || null, lat, lon });
      map.closePopup();
      setView("place");
      return;
    }
    if (!ev.target.closest(".leaflet-popup [data-forecast]")) return;
    ev.preventDefault();
    setView("forecast");
    map.closePopup();
  });
  map.on("popupopen", (e) => {
    e.popup.getElement().querySelectorAll("[data-open]").forEach((el) => {
      el.onclick = (ev) => {
        ev.preventDefault();
        const a = state.alerts.find((x) => x.id === el.dataset.open);
        if (!a) return;
        state.view = "alerts";
        if (!GROUPS[state.group].test(a.event)) state.group = MARINE.test(a.event) ? "marine" : "land";
        state.openEvent = a.event;
        setView("alerts");
        selectAlert(a.id);
        map.closePopup();
      };
    });
  });

  // —— SPC outlooks and mesoscale discussions ———————————————————————————
  async function loadOutlook() {
    const o = OUTLOOK[state.outlookDay];
    if (!o.files[state.outlookType]) state.outlookType = "cat";
    const [geo, text] = await Promise.all([
      fetch(`${SPC}/products/outlook/${o.files[state.outlookType]}.lyr.geojson?_=${Math.floor(Date.now() / 300000)}`).then((r) => r.json()),
      fetch(`${SPC}/products/outlook/${o.text}?_=${Math.floor(Date.now() / 300000)}`).then((r) => r.text()).catch(() => ""),
    ]);
    state.outlookGeo = geo;
    const m = text.match(/\.\.\.SUMMARY\.\.\.\s*([\s\S]*?)\n\s*\n/);
    state.outlookText = m ? m[1].replace(/\s+/g, " ").trim() : "";
    drawOutlook();
  }

  function drawOutlook() {
    layers.outlook.clearLayers();
    if (!state.outlookGeo) return;
    L.geoJSON(state.outlookGeo, {
      pane: "outlook",
      style: (f) => ({ color: f.properties.stroke, weight: 1.4, fillColor: f.properties.fill, fillOpacity: f.properties.LABEL === "SIGN" ? 0 : 0.28, dashArray: f.properties.LABEL === "SIGN" ? "6 4" : null }),
      onEachFeature: (f, l) => l.bindTooltip(esc(f.properties.LABEL2), { className: "tw-tip", sticky: true }),
    }).addTo(layers.outlook);
  }

  function outlookView() {
    const o = OUTLOOK[state.outlookDay];
    const feats = state.outlookGeo?.features || [];
    const top = feats.filter((f) => f.properties.LABEL !== "SIGN" && f.properties.LABEL !== "TSTM").pop();
    const p = feats[0]?.properties || {};
    const days = Object.entries(OUTLOOK).map(([k, v]) => `<button data-day="${k}" aria-pressed="${k === state.outlookDay}">${v.name}</button>`).join("");
    const types = Object.keys(o.files).map((k) => `<button data-otype="${k}" aria-pressed="${k === state.outlookType}">${OUTLOOK_TYPES[k]}</button>`).join("");
    const mds = (state.mds?.features || []);
    return `<div class="chips">${days}</div><div class="chips" style="padding-top:.35rem">${types}</div>
      <div class="pad">
        ${p.VALID_ISO ? `<h5 class="sub">${esc(o.name)} · valid ${esc(dayZ(p.VALID_ISO))} to ${esc(dayZ(p.EXPIRE_ISO))}${p.FORECASTER ? ` · ${esc(p.FORECASTER)}` : ""}</h5>` : ""}
        <p class="note">${top ? `Highest risk: <b>${esc(top.properties.LABEL2)}</b>.` : feats.length ? "No severe risk areas; general thunderstorms only." : "No outlook areas."}</p>
        ${state.outlookText ? `<p class="note">${esc(state.outlookText)}</p>` : ""}
        <div class="key">${feats.map((f) => `<span><i style="background:${f.properties.fill};border:1px solid ${f.properties.stroke}"></i>${esc(f.properties.LABEL2.replace(" Risk", ""))}</span>`).join("")}</div>
        <p class="note"><a href="${SPC}/products/outlook/" target="_blank" rel="noopener">Full SPC outlook ↗</a></p>
        <h5 class="sub">Mesoscale discussions</h5>
        ${mds.length ? `<table class="t"><tbody>${mds.map((f, i) => `<tr data-md="${i}"><td>${esc(f.properties.name)}<small>${esc(f.properties.folderpath.replace(f.properties.name, "").trim())}</small></td><td style="text-align:right"><a href="${esc(f.properties.popupinfo.replace("http:", "https:"))}" target="_blank" rel="noopener">Read ↗</a></td></tr>`).join("")}</tbody></table>`
          : `<p class="note">None active.</p>`}
      </div>`;
  }

  async function loadMds() {
    const res = await fetch(`${MD_LAYER}/query?where=1%3D1&outFields=*&f=geojson&_=${Math.floor(Date.now() / 120000)}`);
    state.mds = await res.json();
    layers.mds.clearLayers();
    L.geoJSON(state.mds, {
      pane: "mds", style: { color: "#4ad1ff", weight: 2, dashArray: "4 3", fillOpacity: 0.05 },
      onEachFeature: (f, l) => l.bindTooltip(esc(f.properties.folderpath), { className: "tw-tip", sticky: true }),
    }).addTo(layers.mds);
  }

  // —— Storm reports (SPC, 12Z to 12Z) ————————————————————————————————
  function parseReports(csv) {
    const out = [];
    let kind = null;
    for (const line of csv.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (line.startsWith("Time,")) { kind = /F_Scale/.test(line) ? "torn" : /Speed/.test(line) ? "wind" : "hail"; continue; }
      const m = line.match(/^(\d{4}),([^,]*),([^,]*),([^,]*),([^,]*),([-\d.]+),([-\d.]+),(.*)$/);
      if (!m || !kind) continue;
      out.push({ kind, time: m[1], mag: m[2], loc: m[3], county: m[4], st: m[5], lat: +m[6], lon: +m[7], text: m[8] });
    }
    return out;
  }

  async function loadReports() {
    const res = await fetch(`${SPC}/climo/reports/${state.reportsDay}_filtered.csv?_=${Math.floor(Date.now() / 300000)}`);
    state.reports = parseReports(await res.text());
    layers.reports.clearLayers();
    state.reports.forEach((r) => {
      L.circleMarker([r.lat, r.lon], { pane: "points", radius: r.kind === "torn" ? 5 : 3.5, weight: 1, color: "#060818", fillColor: REPORT_COLORS[r.kind], fillOpacity: 0.95 })
        .bindPopup(`<h4><span class="dot" style="background:${REPORT_COLORS[r.kind]}"></span>${reportLabel(r)}</h4><p>${esc(r.time)}Z · ${esc(r.loc)}, ${esc(r.county)} Co., ${esc(r.st)}</p><p>${esc(r.text)}</p>`)
        .addTo(layers.reports);
    });
  }

  function reportLabel(r) {
    if (r.kind === "torn") return `Tornado${r.mag && r.mag !== "UNK" ? ` ${esc(r.mag)}` : ""}`;
    if (r.kind === "wind") return `Wind${r.mag && r.mag !== "UNK" ? ` ${esc(r.mag)} mph` : " damage"}`;
    return `Hail ${(+r.mag / 100).toFixed(2)} in`;
  }

  function reportsView() {
    const rs = state.reports || [];
    const n = (k) => rs.filter((r) => r.kind === k).length;
    const sorted = rs.slice().sort((a, b) => ((+b.time + 1200) % 2400) - ((+a.time + 1200) % 2400));
    return `<div class="chips"><button data-rday="today" aria-pressed="${state.reportsDay === "today"}">Today</button><button data-rday="yesterday" aria-pressed="${state.reportsDay === "yesterday"}">Yesterday</button></div>
      <div class="pad">
        <h5 class="sub">Preliminary reports since 1200Z${state.reportsDay === "yesterday" ? " yesterday" : ""}</h5>
        <div class="counts"><div style="color:${REPORT_COLORS.torn}">${n("torn")}<small>Tornado</small></div><div style="color:${REPORT_COLORS.wind}">${n("wind")}<small>Wind</small></div><div style="color:${REPORT_COLORS.hail}">${n("hail")}<small>Hail</small></div></div>
        ${sorted.length ? `<table class="t"><tbody>${sorted.slice(0, 200).map((r, i) => `<tr data-ll="${r.lat},${r.lon}"><td>${esc(r.time)}Z</td><td><span class="dot" style="background:${REPORT_COLORS[r.kind]}"></span>${reportLabel(r)}<small>${esc(r.loc)}, ${esc(r.st)}</small></td></tr>`).join("")}</tbody></table>`
          : `<p class="note">No reports yet.</p>`}
        <p class="note"><a href="${SPC}/climo/reports/${state.reportsDay}.html" target="_blank" rel="noopener">SPC storm reports ↗</a></p>
      </div>`;
  }

  // —— Sidebar ——————————————————————————————————————————————————————
  function render() {
    const html = state.view === "alerts" ? alertsView() : state.view === "outlook" ? outlookView() : state.view === "forecast" ? forecastView() : state.view === "place" ? placeView() : reportsView();
    $("panel").innerHTML = html;
    filterAlertLayer();
  }

  // Draw only the alert types in the selected filter (GeoServer CQL filter on the nowCOAST layer).
  let lastFilter = null;
  function filterAlertLayer() {
    const test = GROUPS[state.group].test;
    const events = [...new Set(state.alerts.map((a) => a.event).filter(test))].sort();
    const cql = events.length ? `prod_type IN (${events.map((e) => `'${e.replace(/'/g, "''")}'`).join(",")})` : "prod_type = ''";
    if (cql === lastFilter) return;
    lastFilter = cql;
    layers.alerts.setParams({ CQL_FILTER: cql });
  }

  function setView(v) {
    state.view = v;
    document.querySelectorAll("#views button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === v));
    // The outlook view turns its map layer on; the others leave it as the user set it.
    if (v === "outlook" && !state.on.outlook) { state.on.outlook = true; document.querySelector('[data-layer="outlook"]').checked = true; layers.outlook.addTo(map); }
    if (v === "reports" && !state.on.reports) { state.on.reports = true; document.querySelector('[data-layer="reports"]').checked = true; layers.reports.addTo(map); }
    render();
  }

  $("views").addEventListener("click", (e) => { const v = e.target.closest("[data-view]")?.dataset.view; if (v) setView(v); });

  $("panel").addEventListener("click", async (e) => {
    const t = e.target.closest("button, tr");
    if (!t) return;
    if (t.dataset.afd) { loadAfd(t.dataset.afd); return; }
    if (t.dataset.afdClose) { state.afd.status = "closed"; render(); return; }
    if (t.dataset.locate) {
      if (!navigator.geolocation) { setStatus("Location isn't available in this browser"); return; }
      setStatus("Finding your location…");
      navigator.geolocation.getCurrentPosition((pos) => {
        setStatus("");
        setPlace({ label: "My location", lat: pos.coords.latitude, lon: pos.coords.longitude });
        map.flyTo([pos.coords.latitude, pos.coords.longitude], 8, { duration: 0.6 });
        render();
      }, () => setStatus("Couldn't get your location"), { timeout: 15000 });
      return;
    }
    if (t.dataset.saved) { const sp = savedPlace(); if (sp) { setPlace(sp); map.flyTo([sp.lat, sp.lon], 8, { duration: 0.6 }); render(); } return; }
    if (t.dataset.log) {
      const act = t.dataset.log;
      if (act === "start") startLog();
      else if (act === "stop") stopLog();
      else if (act === "csv") logCsv();
      else if (act === "print") logPrint();
      else if (act === "clear") { state.log = null; try { localStorage.removeItem(LOG_KEY); } catch { /* private mode */ } }
      render();
      return;
    }
    if (t.dataset.clear) { state.place = null; drawPlace(); drawStormTracks(); render(); return; }
    if (t.dataset.goalert) {
      const a = state.alerts.find((x) => x.id === t.dataset.goalert);
      if (a) { state.view = "alerts"; if (!GROUPS[state.group].test(a.event)) state.group = MARINE.test(a.event) ? "marine" : "land"; state.openEvent = a.event; setView("alerts"); selectAlert(a.id); }
      return;
    }
    if (t.dataset.forecastHere) {
      const p = state.place;
      await loadPointForecast(L.latLng(p.lat, p.lon)).catch(() => null);
      setView("forecast");
      return;
    }
    if (t.dataset.group) { state.group = t.dataset.group; state.openEvent = null; render(); return; }
    if (t.dataset.event) { state.openEvent = state.openEvent === t.dataset.event ? null : t.dataset.event; state.selectedAlert = null; layers.highlight.clearLayers(); render(); return; }
    if (t.dataset.alert) { selectAlert(t.dataset.alert); return; }
    if (t.dataset.day || t.dataset.otype) {
      if (t.dataset.day) state.outlookDay = t.dataset.day;
      if (t.dataset.otype) state.outlookType = t.dataset.otype;
      await loadOutlook().catch(() => setStatus("SPC outlook unavailable"));
      render();
      return;
    }
    if (t.dataset.md && !e.target.closest("a")) {
      const f = state.mds.features[+t.dataset.md];
      if (f) map.flyToBounds(L.geoJSON(f).getBounds().pad(0.5), { maxZoom: 7, duration: 0.6 });
      return;
    }
    if (t.dataset.rday) { state.reportsDay = t.dataset.rday; await loadReports().catch(() => {}); render(); return; }
    if (t.dataset.period) { const i = +t.dataset.period; state.openPeriod = state.openPeriod === i ? null : i; render(); return; }
    if (t.dataset.ll) {
      const [lat, lon] = t.dataset.ll.split(",").map(Number);
      map.flyTo([lat, lon], Math.max(map.getZoom(), 8), { duration: 0.6 });
    }
  });

  $("panel").addEventListener("change", async (e) => {
    if (!e.target.dataset?.notify || !state.place) return;
    if (e.target.checked && Notification.permission !== "granted") {
      const perm = await Notification.requestPermission().catch(() => "denied");
      if (perm !== "granted") { e.target.checked = false; setStatus("Notifications are blocked for this site"); setTimeout(() => setStatus(""), 4000); return; }
    }
    state.place.notify = e.target.checked;
    if (state.place.notify) (state.place.alerts || []).forEach((a) => state.place.seen.add(a.id));
  });

  $("layers").addEventListener("change", (e) => {
    const k = e.target.dataset?.layer;
    if (!k) return;
    state.on[k] = e.target.checked;
    if (k === "radar") { loadRadar(true); return; }
    e.target.checked ? layers[k].addTo(map) : layers[k].remove();
    if (k === "obs" && e.target.checked) loadObs().catch(() => setStatus("Surface observations unavailable"));
    if (k === "lightning" || k === "obs") drawLegend();
  });

  // —— Load & refresh ———————————————————————————————————————————————
  async function init() {
    loadRadar(true);
    setStatus("Loading alerts…");
    if (state.on.lightning) layers.lightning.addTo(map);
    const results = await Promise.allSettled([loadAlerts(), loadOutlook(), loadMds(), loadReports(), loadLightning()]);
    setStatus(results[0].status === "rejected" ? "NWS alerts unavailable — try again shortly" : "");
    drawStormTracks();
    render();

    setInterval(() => loadAlerts().then(() => { drawStormTracks(); render(); }).catch(() => {}), 2 * 60000);
    setInterval(() => refreshPlace(false), 2 * 60000);
    setInterval(() => { if (state.on.obs) loadObs().catch(() => {}); }, 10 * 60000);
    setInterval(() => { loadMds().catch(() => {}); loadReports().then(() => { if (state.view === "reports") render(); }).catch(() => {}); }, 5 * 60000);
    setInterval(() => { loadOutlook().then(() => { if (state.view === "outlook") render(); }).catch(() => {}); }, 15 * 60000);
    setInterval(() => { if (!state.radar.timer) loadRadar(false); }, 4 * 60000);
    setInterval(() => loadLightning().catch(() => {}), 2 * 60000);
    setInterval(() => { if (state.swath.hail !== "off" || state.swath.rot !== "off") redrawSwaths(); }, 5 * 60000);
  }

  // ?loc=lat,lon (from ForensicWeather and the other pages) watches that spot.
  const locParam = new URLSearchParams(location.search).get("loc")?.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (locParam) {
    const lat = +locParam[1], lon = +locParam[2];
    const sp = savedPlace();
    setPlace({ label: sp && Math.abs(sp.lat - lat) < 1e-3 && Math.abs(sp.lon - lon) < 1e-3 ? sp.label : null, lat, lon });
    state.view = "place";
    document.querySelectorAll("#views button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === "place"));
    map.setView([lat, lon], 8);
  }

  // A log that was recording when the page closed carries on for the same place.
  if (state.log?.on) {
    if (!state.place) setPlace({ label: state.log.label, lat: state.log.lat, lon: state.log.lon }, false);
    if (Math.abs(state.log.lat - state.place.lat) < 1e-4 && Math.abs(state.log.lon - state.place.lon) < 1e-4) {
      logTimer = setInterval(logSample, LOG_EVERY);
      setTimeout(logSample, 20000);
    }
  }

  init();
})();
