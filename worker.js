const CLASSES = ["Shape", "AppTrack", "FieldTrack", "LiveTrack"];
const MIN_POINTS = 2;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/playback") return playbackResponse(url);
    return htmlResponse();
  }
};

function htmlResponse() {
  return new Response(HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function playbackResponse(url) {
  const input = url.searchParams.get("url") || url.searchParams.get("map") || "";
  const mapId = parseMapId(input);
  if (!mapId) return json({ error: "Paste a CalTopo map URL or map ID." }, 400);

  const data = await exportMap(mapId);
  return json(data, 200);
}

function parseMapId(input) {
  const value = String(input).trim();
  if (/^[A-Za-z0-9]{5,12}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/m\/([A-Za-z0-9]+)/);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

async function exportMap(mapId) {
  const summary = await fetchJson(`https://caltopo.com/api/v1/map/${mapId}/since/0`);
  const idsByClass = summary?.result?.ids || {};
  const tracks = [];
  const scanned = {};

  for (const className of CLASSES) {
    const ids = Array.isArray(idsByClass[className]) ? idsByClass[className] : [];
    scanned[className] = ids.length;
    for (const id of ids) {
      const body = await fetchJson(`https://caltopo.com/api/v1/map/${mapId}/${className}/${id}`);
      const track = normalizeTrack(body?.result, className, id);
      if (track) tracks.push(track);
    }
  }

  tracks.sort((left, right) => left.start - right.start || left.title.localeCompare(right.title));
  if (tracks.length === 0) throw new Error(`No timestamped line tracks found on map ${mapId}.`);

  const start = Math.min(...tracks.map((track) => track.start));
  const end = Math.max(...tracks.map((track) => track.end));
  const bounds = tracks.reduce(
    (acc, track) => {
      for (const point of track.points) {
        acc.minLat = Math.min(acc.minLat, point.lat);
        acc.maxLat = Math.max(acc.maxLat, point.lat);
        acc.minLng = Math.min(acc.minLng, point.lng);
        acc.maxLng = Math.max(acc.maxLng, point.lng);
      }
      return acc;
    },
    { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity }
  );

  return {
    mapId,
    generatedAt: new Date().toISOString(),
    scanned,
    start,
    end,
    bounds,
    tracks
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" && body?.message
        ? body.message
        : String(text).slice(0, 180);
    throw new Error(`${url} returned HTTP ${response.status}: ${detail}`);
  }
  return body;
}

function normalizeTrack(feature, className, id) {
  const geometry = feature?.geometry;
  const properties = feature?.properties || {};
  if (geometry?.type !== "LineString") return null;
  const points = (geometry.coordinates || [])
    .map(timestampedPoint)
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);
  if (points.length < MIN_POINTS) return null;
  const first = points[0];
  const last = points[points.length - 1];
  return {
    id,
    className,
    title: properties.title || properties.name || properties.deviceId || `${className} ${id}`,
    deviceId: properties.deviceId || "",
    color: properties.stroke || properties.color || colorFor(id),
    pointCount: points.length,
    start: first.time,
    end: last.time,
    points
  };
}

function timestampedPoint(coord) {
  if (!Array.isArray(coord) || coord.length < 4) return null;
  const [lng, lat, ele, time] = coord;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(time)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {
    lng: Number(lng.toFixed(7)),
    lat: Number(lat.toFixed(7)),
    ele: Number.isFinite(ele) ? Math.round(ele) : null,
    time: Math.round(time)
  };
}

function colorFor(value) {
  let hash = 0;
  for (const char of String(value)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360}, 70%, 42%)`;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CalTopo Playback Tool</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <style>
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17212b; background: #edf1f4; overflow: hidden; }
    #map { position: absolute; inset: 0; }
    .loader { position: absolute; inset: 0; z-index: 800; display: grid; place-items: center; background: #eef3f6; }
    .load-card { width: min(620px, calc(100vw - 28px)); background: #fff; border: 1px solid #d7dde2; border-radius: 8px; box-shadow: 0 8px 24px rgba(22,32,42,.18); padding: 18px; }
    h1 { margin: 0 0 10px; font-size: 24px; }
    .form { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    input, button, select { min-height: 36px; border: 1px solid #d7dde2; border-radius: 6px; background: #fff; color: #17212b; font: inherit; }
    input { min-width: 0; padding: 0 10px; }
    button { padding: 0 14px; font-weight: 700; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .72; }
    button.primary { border-color: #0b6f6a; background: #0b6f6a; color: #fff; }
    .hint { margin-top: 10px; color: #5f6b76; font-size: 13px; line-height: 1.35; }
    .loading { display: none; margin-top: 12px; }
    .loading.active { display: grid; gap: 6px; }
    .loading-text { color: #41505d; font-size: 13px; }
    .progress { height: 7px; overflow: hidden; border-radius: 999px; background: #dce4ea; }
    .progress span { display: block; width: 42%; height: 100%; border-radius: inherit; background: #0b6f6a; animation: loadbar 1.1s ease-in-out infinite; }
    @keyframes loadbar { 0% { transform: translateX(-110%); } 100% { transform: translateX(250%); } }
    .error { margin-top: 10px; color: #9b1c1c; font-size: 13px; }
    .topbar { position: absolute; top: 12px; left: 54px; right: 12px; z-index: 500; display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 360px); gap: 12px; align-items: start; pointer-events: none; }
    .panel { pointer-events: auto; background: #fff; border: 1px solid rgba(0,0,0,.12); box-shadow: 0 8px 24px rgba(22,32,42,.18); border-radius: 8px; }
    .controls { min-width: 0; min-height: 56px; padding: 10px 12px; display: grid; grid-template-columns: auto minmax(120px,1fr) minmax(92px,116px) minmax(92px,116px) minmax(92px,116px); gap: 10px; align-items: center; }
    input[type=range] { width: 100%; accent-color: #0b6f6a; }
    .control-label { display: grid; gap: 3px; color: #5f6b76; font-size: 11px; line-height: 1; }
    .control-label select { width: 100%; min-width: 0; font-size: 14px; }
    .time { min-width: 178px; grid-column: 1 / -1; text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; font-size: 17px; white-space: nowrap; }
    .summary { max-height: calc(100vh - 24px); overflow: auto; padding: 12px; }
    .summary h1 { margin: 0 0 4px; font-size: 17px; line-height: 1.2; }
    .meta { color: #5f6b76; font-size: 12px; line-height: 1.35; margin-bottom: 10px; }
    .track-list { display: grid; gap: 6px; }
    label.track { display: grid; grid-template-columns: auto auto 1fr auto; gap: 8px; align-items: center; min-height: 30px; font-size: 13px; }
    .swatch { width: 12px; height: 12px; border-radius: 50%; border: 1px solid rgba(0,0,0,.25); }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { color: #5f6b76; font-variant-numeric: tabular-nums; font-size: 12px; }
    .leaflet-tooltip.playback-label { border: 0; border-radius: 4px; background: rgba(23,33,43,.9); color: #fff; font-weight: 700; padding: 2px 6px; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
    @media (max-width: 900px) { .topbar { left: 12px; grid-template-columns: 1fr; } .controls { grid-template-columns: auto 1fr auto; } .time { grid-column: 1 / -1; text-align: left; } .summary { max-height: 34vh; } }
  </style>
</head>
<body>
  <div id="map"></div>
  <div id="loader" class="loader">
    <div class="load-card">
      <h1>CalTopo Playback Tool</h1>
      <form id="loadForm" class="form">
        <input id="mapInput" placeholder="Paste any CalTopo map share link or map ID">
        <button id="load" class="primary">Load</button>
      </form>
      <div class="hint">Works for CalTopo maps that are public or secret-link accessible. It reads timestamped Shape, AppTrack, FieldTrack, and LiveTrack lines.</div>
      <div id="loading" class="loading">
        <div id="loadingText" class="loading-text">Loading CalTopo tracks...</div>
        <div class="progress"><span></span></div>
      </div>
      <div id="error" class="error"></div>
    </div>
  </div>
  <div class="topbar" hidden>
    <div class="panel controls">
      <button id="play" class="primary">Play</button>
      <input id="slider" type="range" min="0" max="1000" value="0" step="1">
      <label class="control-label">Speed<select id="speed"><option value="60">60x</option><option value="180" selected>180x</option><option value="600">600x</option><option value="1800">1800x</option><option value="3600">3600x</option></select></label>
      <label class="control-label">Stale<select id="stale"><option value="0">Never</option><option value="300000">5 min</option><option value="600000" selected>10 min</option><option value="1200000">20 min</option><option value="1800000">30 min</option></select></label>
      <label class="control-label">View<select id="mode"><option value="trail" selected>Trails</option><option value="position">Positions</option></select></label>
      <div id="time" class="time"></div>
    </div>
    <aside class="panel summary"><h1>Track Playback</h1><div id="meta" class="meta"></div><div id="trackList" class="track-list"></div></aside>
  </div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const map = L.map("map", { preferCanvas: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    map.setView([37.35, -122.15], 10);
    const API_BASE = window.PLAYBACK_API_BASE || "";
    const params = new URLSearchParams(location.search);
    if (params.get("map")) document.getElementById("mapInput").value = params.get("map");
    document.getElementById("loadForm").addEventListener("submit", event => { event.preventDefault(); loadFromInput(); });
    document.getElementById("load").onclick = event => { event.preventDefault(); loadFromInput(); };
    document.getElementById("mapInput").addEventListener("keydown", (event) => { if (event.key === "Enter") loadFromInput(); });
    window.loadFromInput = loadFromInput;
    if (params.get("map")) {
      document.getElementById("loading").classList.add("active");
      document.getElementById("loadingText").textContent = "Auto-loading CalTopo tracks...";
      setTimeout(loadFromInput, 250);
    }
    async function loadFromInput() {
      const input = document.getElementById("mapInput").value.trim();
      const error = document.getElementById("error");
      const loadButton = document.getElementById("load");
      const loading = document.getElementById("loading");
      const loadingText = document.getElementById("loadingText");
      error.textContent = "";
      if (!input) {
        error.textContent = "Paste a CalTopo map URL, share URL, or map ID first.";
        return;
      }
      loadButton.textContent = "Loading";
      loadButton.disabled = true;
      loading.classList.add("active");
      loadingText.textContent = "Contacting CalTopo and reading timestamped tracks...";
      const started = Date.now();
      const statusTimer = setInterval(() => {
        const seconds = Math.round((Date.now() - started) / 1000);
        loadingText.textContent = "Still loading CalTopo tracks... " + seconds + "s";
      }, 5000);
      try {
        const response = await fetch(API_BASE + "/api/playback?url=" + encodeURIComponent(input));
        const text = await response.text();
        let data;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          throw new Error("The playback server returned a non-JSON response. Try again in a minute.");
        }
        if (!response.ok) throw new Error(data.error || "Could not load map.");
        loadingText.textContent = "Loaded " + data.tracks.length.toLocaleString() + " tracks. Rendering playback map...";
        startPlayback(data);
        history.replaceState(null, "", "?map=" + encodeURIComponent(input));
      } catch (err) {
        document.getElementById("loader").hidden = false;
        document.querySelector(".topbar").hidden = true;
        error.textContent = err.message || "Could not load playback.";
      } finally {
        clearInterval(statusTimer);
        loading.classList.remove("active");
        loadButton.disabled = false;
        loadButton.textContent = "Load";
      }
    }
    function startPlayback(data) {
      if (!data || !Array.isArray(data.tracks) || data.tracks.length === 0) {
        throw new Error("No replayable timestamped tracks were found on this map.");
      }
      if (!data.bounds || !Number.isFinite(data.bounds.minLat) || !Number.isFinite(data.bounds.minLng) || !Number.isFinite(data.bounds.maxLat) || !Number.isFinite(data.bounds.maxLng)) {
        throw new Error("The map returned tracks, but their map bounds were invalid.");
      }
      const bounds = L.latLngBounds([data.bounds.minLat, data.bounds.minLng], [data.bounds.maxLat, data.bounds.maxLng]);
      map.fitBounds(bounds.pad(.08));
      const visible = new Set(data.tracks.map(t => t.id));
      const layers = new Map();
      const slider = document.getElementById("slider"), playButton = document.getElementById("play"), speed = document.getElementById("speed"), stale = document.getElementById("stale"), mode = document.getElementById("mode"), timeEl = document.getElementById("time"), metaEl = document.getElementById("meta"), trackList = document.getElementById("trackList");
      trackList.innerHTML = "";
      const duration = data.end - data.start;
      let current = data.start, playing = false, previousFrame = null;
      for (const track of data.tracks) {
        const layer = { line: L.polyline([], { color: track.color, weight: 3, opacity: .78 }).addTo(map), marker: L.marker([track.points[0].lat, track.points[0].lng], { icon: markerIcon(track, 1, 0), keyboard: false }).addTo(map) };
        layer.marker.bindTooltip(track.title, { permanent: true, direction: "top", offset: [0,-7], className: "playback-label", opacity: .95 });
        layers.set(track.id, layer);
        const row = document.createElement("label");
        row.className = "track";
        row.title = track.title;
        row.innerHTML = '<input type="checkbox" checked><span class="swatch"></span><span class="name"></span><span class="count"></span>';
        row.querySelector(".swatch").style.background = track.color;
        row.querySelector(".name").textContent = track.title;
        row.querySelector(".count").textContent = track.pointCount.toLocaleString();
        row.querySelector("input").onchange = e => { e.target.checked ? visible.add(track.id) : visible.delete(track.id); update(current); };
        trackList.append(row);
      }
      metaEl.textContent = data.tracks.length.toLocaleString() + " tracks, " + new Date(data.start).toLocaleString() + " to " + new Date(data.end).toLocaleString();
      function pointAt(track, at) {
        const p = track.points;
        if (at < p[0].time) return { previous: null, current: null, next: p[0] };
        if (at >= p[p.length - 1].time) return { previous: p[p.length - 2] || null, current: p[p.length - 1], next: null };
        let low = 0, high = p.length - 1;
        while (low <= high) { const mid = (low + high) >> 1; if (p[mid].time <= at) low = mid + 1; else high = mid - 1; }
        const left = p[Math.max(0, high)], right = p[Math.min(p.length - 1, high + 1)];
        if (!right || left.time === right.time) return { previous: p[Math.max(0, high - 1)] || null, current: left, next: right || null };
        const r = (at - left.time) / (right.time - left.time);
        return { previous: left, current: { lat: left.lat + (right.lat - left.lat) * r, lng: left.lng + (right.lng - left.lng) * r, time: at }, next: right };
      }
      const interp = (track, at) => pointAt(track, at).current;
      const dist = (a,b) => { const R=6371000, p1=a.lat*Math.PI/180, p2=b.lat*Math.PI/180, d1=(b.lat-a.lat)*Math.PI/180, d2=(b.lng-a.lng)*Math.PI/180, x=Math.sin(d1/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(d2/2)**2; return R*2*Math.atan2(Math.sqrt(x), Math.sqrt(1-x)); };
      function heading(track, at) { const {previous,current,next}=pointAt(track, at); if (!current) return null; const from=previous||current, to=previous?current:next; if (!to) return null; const seconds=Math.max(1, Math.abs((to.time||at)-(from.time||at))/1000), meters=dist(from,to); if (meters < 8 || meters/seconds < .5) return null; const a=from.lat*Math.PI/180, b=to.lat*Math.PI/180, d=(to.lng-from.lng)*Math.PI/180, y=Math.sin(d)*Math.cos(b), x=Math.cos(a)*Math.sin(b)-Math.sin(a)*Math.cos(b)*Math.cos(d); return (Math.atan2(y,x)*180/Math.PI+360)%360; }
      function markerIcon(track, opacity, h) { if (!Number.isFinite(h)) return L.divIcon({ className:"", iconSize:[18,18], iconAnchor:[9,9], html:'<div style="width:18px;height:18px;opacity:'+opacity+'"><svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="6" fill="'+track.color+'" stroke="#111" stroke-width="1.4"/></svg></div>' }); return L.divIcon({ className:"", iconSize:[24,24], iconAnchor:[12,12], html:'<div style="width:24px;height:24px;opacity:'+opacity+';transform:rotate('+h+'deg)"><svg width="24" height="24" viewBox="0 0 24 24"><path d="M12 2 19 21 12 17 5 21Z" fill="'+track.color+'" stroke="#111" stroke-width="1.4"/></svg></div>' }); }
      function pointsUntil(track, at) { const out=[]; for (const point of track.points) { if (point.time <= at) out.push([point.lat, point.lng]); else break; } const p=interp(track, at); if (p) out.push([p.lat,p.lng]); return out; }
      function update(at) {
        current = Math.max(data.start, Math.min(data.end, at));
        slider.value = duration > 0 ? Math.round(((current - data.start) / duration) * 1000) : 0;
        timeEl.textContent = new Date(current).toLocaleString();
        for (const track of data.tracks) {
          const layer = layers.get(track.id), point = visible.has(track.id) ? interp(track, current) : null, staleMs = Number(stale.value), age = point ? current - point.time : Infinity, fadeStart = staleMs * .7, opacity = staleMs > 0 && age > fadeStart ? Math.max(0, 1 - ((age - fadeStart) / Math.max(1, staleMs - fadeStart))) : 1;
          if (!point || opacity <= 0) { layer.line.setLatLngs([]); layer.marker.setOpacity(0); layer.marker.closeTooltip(); continue; }
          layer.line.setLatLngs(mode.value === "trail" ? pointsUntil(track, current) : []);
          layer.line.setStyle({ opacity: .78 * opacity });
          layer.marker.setLatLng([point.lat, point.lng]);
          layer.marker.setOpacity(opacity);
          layer.marker.setIcon(markerIcon(track, opacity, heading(track, current)));
          opacity > .45 ? layer.marker.openTooltip() : layer.marker.closeTooltip();
        }
      }
      function frame(ts) { if (!playing) return; if (previousFrame == null) previousFrame = ts; const elapsed = ts - previousFrame; previousFrame = ts; const next = current + elapsed * Number(speed.value); if (next >= data.end) { playing = false; playButton.textContent = "Play"; update(data.end); return; } update(next); requestAnimationFrame(frame); }
      playButton.onclick = () => { playing = !playing; playButton.textContent = playing ? "Pause" : "Play"; previousFrame = null; if (playing) { if (current >= data.end) update(data.start); requestAnimationFrame(frame); } };
      slider.oninput = () => update(data.start + duration * (Number(slider.value) / 1000));
      stale.onchange = () => update(current);
      mode.onchange = () => update(current);
      update(data.start);
      document.getElementById("loader").hidden = true;
      document.querySelector(".topbar").hidden = false;
    }
  </script>
</body>
</html>`;
