/* NowWeather — live hazards console for standardweather.github.io.
 *
 * Everything loads live in the browser from government services that allow cross-origin requests:
 *   NWS API (api.weather.gov)        active alerts (text, storm-based polygons, zone shapes)
 *   nowCOAST (NOAA)                  watches/warnings/advisories map layer in NWS colors; radar mosaic loop
 *   SPC (spc.noaa.gov)               convective outlooks (GeoJSON + text), today's/yesterday's storm reports
 *   NOAA map services                SPC mesoscale discussions
 */
(() => {
  "use strict";

  const NWS = "https://api.weather.gov";
  const NOWCOAST = "https://nowcoast.noaa.gov/geoserver";
  const SPC = "https://www.spc.noaa.gov";
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
    on: { radar: true, alerts: true, outlook: false, mds: true, reports: true },
    radar: { times: [], layers: [], idx: 0, timer: null, opacity: 0.75 },
  };

  // —— Map ————————————————————————————————————————————————————————
  const map = L.map("map", { zoomControl: false, minZoom: 3, maxZoom: 12 }).fitBounds(CONUS);
  L.control.zoom({ position: "topright" }).addTo(map);
  map.attributionControl.setPrefix("");
  [["radar", 300], ["outlook", 350], ["alerts", 400], ["highlight", 450], ["mds", 460], ["points", 620], ["labels", 640]]
    .forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
  map.getPane("labels").style.pointerEvents = "none";
  map.getPane("alerts").style.pointerEvents = "none";
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Esri" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "labels", opacity: 0.85 }).addTo(map);
  map.attributionControl.addAttribution("NWS · SPC · NOAA nowCOAST");

  const layers = {
    alerts: L.tileLayer.wms(`${NOWCOAST}/alerts/wms`, { layers: "watches_warnings_advisories", format: "image/png", transparent: true, version: "1.3.0", pane: "alerts", opacity: 0.6, tileSize: 512, attribution: "" }),
    outlook: L.layerGroup(),
    mds: L.layerGroup(),
    reports: L.layerGroup(),
    highlight: L.layerGroup().addTo(map),
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
  map.on("click", async (e) => {
    if (!state.on.alerts) return;
    const size = map.getSize();
    const b = map.getBounds();
    const p = map.latLngToContainerPoint(e.latlng);
    const url = `${NOWCOAST}/alerts/wms?service=WMS&version=1.3.0&request=GetFeatureInfo&layers=watches_warnings_advisories&query_layers=watches_warnings_advisories` +
      `&info_format=application/json&feature_count=20&crs=EPSG:4326&bbox=${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}` +
      `&width=${size.x}&height=${size.y}&i=${Math.round(p.x)}&j=${Math.round(p.y)}` + (lastFilter ? `&CQL_FILTER=${encodeURIComponent(lastFilter)}` : "");
    try {
      const d = await (await fetch(url)).json();
      const seen = new Set();
      const feats = d.features.map((f) => f.properties).filter((p2) => !seen.has(p2.cap_id) && seen.add(p2.cap_id))
        .sort((x, y) => rank(x.prod_type) - rank(y.prod_type));
      if (!feats.length) return;
      const html = feats.map((p2) => {
        const a = state.alerts.find((x) => x.id === p2.cap_id);
        return `<h4><span class="dot" style="background:${colorOf(p2.prod_type)}"></span>${esc(p2.prod_type)}</h4>
          <p>${esc(a ? a.senderName.replace("NWS ", "") : p2.wfo)} · until ${esc(dayZ(p2.ends || p2.expiration))}${a ? ` · <a href="#" data-open="${esc(a.id)}">details</a>` : ""}</p>`;
      }).join("");
      L.popup({ maxWidth: 320 }).setLatLng(e.latlng).setContent(html).openOn(map);
    } catch { /* identify is best-effort */ }
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
    const html = state.view === "alerts" ? alertsView() : state.view === "outlook" ? outlookView() : reportsView();
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
    if (t.dataset.ll) {
      const [lat, lon] = t.dataset.ll.split(",").map(Number);
      map.flyTo([lat, lon], Math.max(map.getZoom(), 8), { duration: 0.6 });
    }
  });

  $("layers").addEventListener("change", (e) => {
    const k = e.target.dataset?.layer;
    if (!k) return;
    state.on[k] = e.target.checked;
    if (k === "radar") { loadRadar(true); return; }
    e.target.checked ? layers[k].addTo(map) : layers[k].remove();
  });

  // —— Load & refresh ———————————————————————————————————————————————
  async function init() {
    loadRadar(true);
    setStatus("Loading alerts…");
    const results = await Promise.allSettled([loadAlerts(), loadOutlook(), loadMds(), loadReports()]);
    setStatus(results[0].status === "rejected" ? "NWS alerts unavailable — try again shortly" : "");
    render();

    setInterval(() => loadAlerts().then(render).catch(() => {}), 2 * 60000);
    setInterval(() => { loadMds().catch(() => {}); loadReports().then(() => { if (state.view === "reports") render(); }).catch(() => {}); }, 5 * 60000);
    setInterval(() => { loadOutlook().then(() => { if (state.view === "outlook") render(); }).catch(() => {}); }, 15 * 60000);
    setInterval(() => { if (!state.radar.timer) loadRadar(false); }, 4 * 60000);
  }

  init();
})();
