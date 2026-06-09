const CLASSES = ["Shape", "AppTrack", "FieldTrack", "LiveTrack"];
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
    response.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
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
