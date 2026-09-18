const CLASSES = ["Shape", "AppTrack", "FieldTrack", "LiveTrack"];
const MARKER_CLASSES = ["Marker"];
const FOLDER_CLASSES = ["Folder"];
const MIN_POINTS = 2;
const FETCH_CONCURRENCY = 8;

export class PlaybackError extends Error {
  constructor(message, status = 500, code = "PLAYBACK_ERROR", mapId = "") {
    super(message);
    this.name = "PlaybackError";
    this.status = status;
    this.code = code;
    this.mapId = mapId;
  }
}

export async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("CDN-Cache-Control", "no-store");
  if (request.method === "OPTIONS") return response.status(204).end();
  try {
    const data = await getPlayback(request.query.url || request.query.map || request.query.id || "");
    return response.status(200).json(data);
  } catch (error) {
    const isPlayback = error instanceof PlaybackError;
    const resPayload = {
      error: errorMessage(error),
      code: isPlayback ? error.code : "INTERNAL_ERROR"
    };
    if (isPlayback && error.mapId) {
      resPayload.mapId = error.mapId;
    }
    return response.status(isPlayback ? error.status : 500).json(resPayload);
  }
}
export default handler;

export async function getPlayback(input) {
  const mapId = parseMapId(input);
  if (!mapId) throw new PlaybackError("Paste a CalTopo map URL or map ID.", 400, "INVALID_INPUT");
  return exportMap(mapId);
}

export function errorMessage(error) {
  if (error instanceof PlaybackError) return error.message;
  return "CalTopo could not load this map. Verify the map link is public or share-link accessible and try again.";
}

export function parseMapId(input) {
  let value = String(input || "").trim();
  if (!value) return "";
  if (/^[A-Za-z0-9]{4,12}$/.test(value)) return value;
  if (!/^[a-z]+:\/\//i.test(value)) {
    value = "https://" + value;
  }
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/m\/([A-Za-z0-9]+)/);
    if (match?.[1]) return match[1];
    const idParam = url.searchParams.get("id");
    if (idParam && /^[A-Za-z0-9]{4,12}$/.test(idParam)) return idParam;
    const hashMatch = url.hash.match(/[#&]id=([A-Za-z0-9]{4,12})/);
    if (hashMatch?.[1]) return hashMatch[1];
    return "";
  } catch {
    return "";
  }
}

async function exportMap(mapId) {
  const summary = await fetchJson(`https://caltopo.com/api/v1/map/${mapId}/since/0`, "map summary", mapId);
  const idsByClass = summary?.result?.ids || {};
  const tracks = [];
  const folders = new Map();
  const markers = [];
  const scanned = Object.fromEntries(
    [...FOLDER_CLASSES, ...CLASSES, ...MARKER_CLASSES].map((className) => [
      className,
      Array.isArray(idsByClass[className]) ? idsByClass[className].length : 0
    ])
  );

  const folderFeatures = await fetchMapObjects(mapId, idsByClass, FOLDER_CLASSES);
  for (const { feature, id } of folderFeatures) {
    const folder = normalizeFolder(feature, id);
    if (folder) folders.set(id, folder);
  }

  const [trackFeatures, markerFeatures] = await Promise.all([
    fetchMapObjects(mapId, idsByClass, CLASSES),
    fetchMapObjects(mapId, idsByClass, MARKER_CLASSES)
  ]);
  for (const { feature, className, id } of trackFeatures) {
    const track = normalizeTrack(feature, className, id, folders);
    if (track) tracks.push(track);
  }
  const icons = markerFeatures.length ? await loadIconCatalog() : new Map();
  for (const { feature, className, id } of markerFeatures) {
    const marker = normalizeMarker(feature, className, id, folders, icons);
    if (marker) markers.push(marker);
  }
  await attachMarkerIconData(markers);

  tracks.sort((left, right) => left.start - right.start || left.title.localeCompare(right.title));
  markers.sort((left, right) => left.category.localeCompare(right.category) || left.title.localeCompare(right.title));
  if (tracks.length === 0) throw new PlaybackError(`No timestamped line tracks found on map ${mapId}.`, 404, "NO_TRACKS", mapId);

  let start = Infinity;
  let end = -Infinity;
  for (const track of tracks) {
    if (track.start < start) start = track.start;
    if (track.end > end) end = track.end;
  }
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
  for (const marker of markers) {
    bounds.minLat = Math.min(bounds.minLat, marker.lat);
    bounds.maxLat = Math.max(bounds.maxLat, marker.lat);
    bounds.minLng = Math.min(bounds.minLng, marker.lng);
    bounds.maxLng = Math.max(bounds.maxLng, marker.lng);
  }

  return {
    mapId,
    generatedAt: new Date().toISOString(),
    scanned,
    start,
    end,
    bounds,
    tracks,
    folders: [...folders.values()].sort((left, right) => left.title.localeCompare(right.title)),
    markers,
    markerGroups: markerGroups(markers)
  };
}

async function fetchMapObjects(mapId, idsByClass, classNames) {
  const objects = classNames.flatMap((className) =>
    (Array.isArray(idsByClass[className]) ? idsByClass[className] : []).map((id) => ({
      className,
      id: String(id)
    }))
  );
  return mapWithConcurrency(objects, FETCH_CONCURRENCY, async ({ className, id }) => ({
    className,
    id,
    feature: (await fetchJson(
      `https://caltopo.com/api/v1/map/${mapId}/${className}/${encodeURIComponent(id)}`,
      `${className} ${id}`,
      mapId
    ))?.result
  }));
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, worker));
  return results;
}

async function fetchJson(url, description, mapId = "") {
  let response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new PlaybackError(`CalTopo could not be reached while loading ${description}.`, 502, "NETWORK_ERROR", mapId);
  }
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new PlaybackError(
        "CalTopo permission denied: This map is private. In CalTopo, open the map, click 'Share' (top left), and change access to 'URL Viewable' or 'Public'.",
        response.status,
        "PERMISSION_DENIED",
        mapId
      );
    }
    if (response.status === 404 && description.includes("map summary")) {
      throw new PlaybackError(
        `CalTopo map not found: Map '${mapId || "unknown"}' does not exist or access is restricted. Make sure the map ID is correct and map permissions are set to 'URL Viewable' or 'Public'.`,
        404,
        "NOT_FOUND",
        mapId
      );
    }
    const message = `CalTopo could not load ${description} (HTTP ${response.status}).`;
    throw new PlaybackError(message, response.status >= 400 && response.status < 500 ? response.status : 502, "UPSTREAM_ERROR", mapId);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new PlaybackError(`CalTopo returned an invalid response while loading ${description}.`, 502, "INVALID_RESPONSE", mapId);
  }
}

function normalizeTrack(feature, className, id, folders) {
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
  const folderId = properties.folderId || "";
  const folder = folderId && folders ? folders.get(folderId) : null;
  const distanceMeters = calculateTrackDistance(points);
  return {
    id,
    className,
    title: properties.title || properties.name || properties.deviceId || `${className} ${id}`,
    deviceId: properties.deviceId || "",
    folderId,
    folderTitle: folder?.title || "",
    color: normalizeColor(properties.stroke || properties.color) || colorFor(id),
    pointCount: points.length,
    distanceMeters,
    distanceMiles: Number((distanceMeters / 1609.344).toFixed(2)),
    durationMs: Math.max(0, last.time - first.time),
    start: first.time,
    end: last.time,
    points
  };
}

function calculateTrackDistance(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineDistance(points[i - 1], points[i]);
  }
  return Math.round(total);
}

function haversineDistance(a, b) {
  const R = 6371000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = Math.max(0, Math.min(1, sinLat * sinLat + Math.cos(p1) * Math.cos(p2) * sinLng * sinLng));
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function normalizeFolder(feature, id) {
  const properties = feature?.properties || {};
  return {
    id,
    title: cleanText(properties.title || properties.name || `Folder ${id}`),
    visible: properties.visible !== false
  };
}

function normalizeMarker(feature, className, id, folders, icons) {
  const geometry = feature?.geometry;
  const properties = feature?.properties || {};
  if (geometry?.type !== "Point") return null;
  const coord = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  const [lng, lat, ele] = coord;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const folderId = properties.folderId || "";
  const folder = folderId ? folders.get(folderId) : null;
  const title = cleanText(properties.title || properties.name || `${className} ${id}`);
  const description = cleanText(properties.description || "");
  const symbol = cleanText(properties["marker-symbol"] || properties.symbol || "");
  const color = normalizeColor(properties["marker-color"] || properties.color || "");
  const category = markerCategory({ title, description, symbol, folderTitle: folder?.title || "" });
  const createdOn = markerCreatedTime(properties);
  if (!createdOn) return null;
  return {
    id,
    className,
    title,
    description,
    folderId,
    folderTitle: folder?.title || "",
    category,
    symbol,
    color,
    size: cleanText(properties["marker-size"] || ""),
    labelVisible: Boolean(properties.labelVisible),
    lng: Number(lng.toFixed(7)),
    lat: Number(lat.toFixed(7)),
    ele: Number.isFinite(ele) ? Math.round(ele) : null,
    time: createdOn,
    ...markerImage(properties, icons)
  };
}

let cachedIcons;
let iconsFetchedAt = 0;
async function loadIconCatalog() {
  if (cachedIcons && Date.now() - iconsFetchedAt < 3600000) return cachedIcons;
  try {
    const constants = await fetchJson('https://caltopo.com/sideload/constants.json', 'marker styles');
    cachedIcons = new Map(Object.values(constants.icons || {}).flat().map(icon => [icon.id, icon]));
    iconsFetchedAt = Date.now();
  } catch {
    // A temporary style-catalog failure should not prevent track playback.
    return cachedIcons || new Map();
  }
  return cachedIcons;
}

function markerImage(properties, icons) {
  const symbol = cleanText(properties['marker-symbol'] || properties.symbol || 'point');
  const requestedScale = Number(properties['marker-size']);
  const scale = Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1;
  let baseSize = 0, anchor = [.5, .5];
  for (const part of symbol.split('$')) {
    const custom = /^icon-[^-]+-([\d.]+)-([\d.]+)-([\d.]+)-[tf]{2}$/.exec(part);
    const spec = custom ? { size: Number(custom[1]), anchor: [Number(custom[2]), Number(custom[3])] } : icons.get(part.split(':')[0]);
    if (spec) {
      baseSize = Math.max(baseSize, spec.size);
      anchor = spec.anchor || [.5, .5];
    }
  }
  if (symbol === '/static/images/icons/usgs.png') baseSize = 12;
  const size = (baseSize || 24) * scale;
  let iconUrl, iconRetinaUrl;
  if (/^(https?:\/\/|\/(?!\/))/i.test(symbol)) {
    iconUrl = new URL(symbol, 'https://caltopo.com').href.replace(/^http:/i, 'https:');
    iconRetinaUrl = iconUrl;
  } else {
    let cfg = symbol;
    const fill = normalizeColor(properties['marker-fill'] || '');
    const color = normalizeColor(properties['marker-color'] || properties.color || '');
    if (fill) cfg += ',' + fill.slice(1);
    if (color) cfg += ',' + color.slice(1);
    const rotation = Number(properties['marker-rotation']);
    if (Number.isFinite(rotation) && rotation !== 0) cfg += '@' + rotation;
    if (Number.isFinite(requestedScale) && requestedScale > 0) cfg += '#' + scale;
    iconUrl = 'https://caltopo.com/icon.png?cfg=' + encodeURIComponent(cfg);
    iconRetinaUrl = 'https://caltopo.com/icon@2x.png?cfg=' + encodeURIComponent(cfg);
  }
  return { iconUrl, iconRetinaUrl, iconSize: [size, size], iconAnchor: [size * anchor[0], size * anchor[1]] };
}

const markerIconDataCache = new Map();
const MAX_ICON_CACHE_ENTRIES = 500;

async function attachMarkerIconData(markers) {
  const uniqueUrls = new Set();
  for (const m of markers) {
    if (m.iconRetinaUrl && !markerIconDataCache.has(m.iconRetinaUrl)) uniqueUrls.add(m.iconRetinaUrl);
    if (m.iconUrl && !markerIconDataCache.has(m.iconUrl)) uniqueUrls.add(m.iconUrl);
  }
  if (uniqueUrls.size > 0) {
    // Prevent unbounded memory growth across multiple map requests
    if (markerIconDataCache.size + uniqueUrls.size > MAX_ICON_CACHE_ENTRIES) {
      const keysToDelete = Array.from(markerIconDataCache.keys()).slice(0, 150);
      for (const k of keysToDelete) markerIconDataCache.delete(k);
    }
    await Promise.all(Array.from(uniqueUrls).map(async (url) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (res && res.ok) {
          const contentType = res.headers?.get ? (res.headers.get("content-type") || "image/png") : "image/png";
          if (!contentType.includes("json")) {
            const buffer = await res.arrayBuffer();
            const base64 = Buffer.from(buffer).toString("base64");
            markerIconDataCache.set(url, `data:${contentType.split(";")[0]};base64,${base64}`);
          }
        }
      } catch {
        // Silently continue; client has vector fallbacks
      }
    }));
  }
  for (const m of markers) {
    if (m.iconRetinaUrl && markerIconDataCache.has(m.iconRetinaUrl)) {
      m.iconRetinaDataUrl = markerIconDataCache.get(m.iconRetinaUrl);
    }
    if (m.iconUrl && markerIconDataCache.has(m.iconUrl)) {
      m.iconDataUrl = markerIconDataCache.get(m.iconUrl);
    }
  }
}

function markerCreatedTime(properties) {
  const value = properties["-created-on"];
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
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
