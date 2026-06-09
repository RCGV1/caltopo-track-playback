const CLASSES = ["Shape", "AppTrack", "FieldTrack", "LiveTrack"];
const MARKER_CLASSES = ["Marker"];
const FOLDER_CLASSES = ["Folder"];
const MIN_POINTS = 2;

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
  if (request.method === "OPTIONS") return response.status(204).end();
  try {
    const input = request.query.url || request.query.map || "";
    const mapId = parseMapId(input);
    if (!mapId) return response.status(400).json({ error: "Paste a CalTopo map URL or map ID." });
    const data = await exportMap(mapId);
    response.setHeader("Cache-Control", "no-store, max-age=0");
    return response.status(200).json(data);
  } catch (error) {
    return response.status(500).json({ error: error.message });
  }
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
  const folders = new Map();
  const markers = [];
  const scanned = {};

  for (const className of FOLDER_CLASSES) {
    const ids = Array.isArray(idsByClass[className]) ? idsByClass[className] : [];
    scanned[className] = ids.length;
    for (const id of ids) {
      const body = await fetchJson(`https://caltopo.com/api/v1/map/${mapId}/${className}/${id}`);
      const folder = normalizeFolder(body?.result, id);
      if (folder) folders.set(id, folder);
    }
  }

  for (const className of CLASSES) {
    const ids = Array.isArray(idsByClass[className]) ? idsByClass[className] : [];
    scanned[className] = ids.length;
    for (const id of ids) {
      const body = await fetchJson(`https://caltopo.com/api/v1/map/${mapId}/${className}/${id}`);
      const track = normalizeTrack(body?.result, className, id);
      if (track) tracks.push(track);
    }
  }

  for (const className of MARKER_CLASSES) {
    const ids = Array.isArray(idsByClass[className]) ? idsByClass[className] : [];
    scanned[className] = ids.length;
    for (const id of ids) {
      const body = await fetchJson(`https://caltopo.com/api/v1/map/${mapId}/${className}/${id}`);
      const marker = normalizeMarker(body?.result, className, id, folders);
      if (marker) markers.push(marker);
    }
  }

  tracks.sort((left, right) => left.start - right.start || left.title.localeCompare(right.title));
  markers.sort((left, right) => left.category.localeCompare(right.category) || left.title.localeCompare(right.title));
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
    tracks,
    markers,
    markerGroups: markerGroups(markers)
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

function normalizeFolder(feature, id) {
  const properties = feature?.properties || {};
  return {
    id,
    title: cleanText(properties.title || properties.name || `Folder ${id}`),
    visible: properties.visible !== false
  };
}

function normalizeMarker(feature, className, id, folders) {
  const geometry = feature?.geometry;
  const properties = feature?.properties || {};
  if (geometry?.type !== "Point") return null;
  const coord = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  const [lng, lat, ele, time] = coord;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const folderId = properties.folderId || "";
  const folder = folderId ? folders.get(folderId) : null;
  const title = cleanText(properties.title || properties.name || `${className} ${id}`);
  const description = cleanText(properties.description || "");
  const symbol = cleanText(properties["marker-symbol"] || properties.symbol || "");
  const color = normalizeColor(properties["marker-color"] || properties.color || "");
  const category = markerCategory({ title, description, symbol, folderTitle: folder?.title || "" });
  return {
    id,
    className,
    title,
    description,
    folderId,
    folderTitle: folder?.title || "",
    category,
    symbol,
    color: color || colorForMarkerCategory(category),
    size: cleanText(properties["marker-size"] || ""),
    labelVisible: Boolean(properties.labelVisible),
    lng: Number(lng.toFixed(7)),
    lat: Number(lat.toFixed(7)),
    ele: Number.isFinite(ele) ? Math.round(ele) : null,
    time: Number.isFinite(time) ? Math.round(time) : null
  };
}

function markerGroups(markers) {
  const counts = new Map();
  for (const marker of markers) counts.set(marker.category, (counts.get(marker.category) || 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([name, count]) => ({ name, count }));
}

function markerCategory(marker) {
  const folder = marker.folderTitle.toLowerCase();
  if (/(hazard|gravel|restricted|dead zone)/.test(folder)) return "Hazards";
  if (/(rest stop|\brest\b|\brs\b|refresh)/.test(folder)) return "Rest Stops";
  if (/(checkpoint|monitor)/.test(folder)) return "Checkpoints";
  if (/(water|restroom|bathroom|shop|services|cell)/.test(folder)) return "Services";
  if (/(hq|start|finish|command)/.test(folder)) return "HQ";
  const haystack = `${marker.folderTitle} ${marker.title} ${marker.description} ${marker.symbol}`.toLowerCase();
  if (/(hazard|construction|closed|closure|danger|crash|downed|down rider|medical|incident|flat tire|one[ -]?way|confusing|restricted|unauthorized)/.test(haystack)) return "Hazards";
  if (/(rest stop|\(rs\)|\brs\b|refresh|foodservice|aid station)/.test(haystack)) return "Rest Stops";
  if (/(hq|start|finish|staging|command)/.test(haystack)) return "HQ";
  if (/(checkpoint|monitor|\(cp\)|\bcp\b|binoc)/.test(haystack)) return "Checkpoints";
  if (/(water|restroom|bathroom|toilet|shop|services|store|hut|lodging)/.test(haystack)) return "Services";
  return marker.folderTitle || "Other Markers";
}

function colorForMarkerCategory(category) {
  if (category === "Hazards") return "#d21f1f";
  if (category === "Rest Stops") return "#0f7b4f";
  if (category === "Checkpoints") return "#111827";
  if (category === "Services") return "#6a1b9a";
  if (category === "HQ") return "#0b6f6a";
  return "#475569";
}

function normalizeColor(value) {
  const text = String(value || "").trim();
  const match = text.match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1]}` : "";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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
