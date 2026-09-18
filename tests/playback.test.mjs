import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { getPlayback, parseMapId, handler, PlaybackError, errorMessage } from '../api/playback.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const helpers = html.slice(html.indexOf('    function staticMarkerIcon('), html.lastIndexOf('  </script>'));
const { buildWindows, staticMarkerIcon } = runInNewContext(helpers + '\n({buildWindows, staticMarkerIcon})', {
  L: { icon: options => options, divIcon: options => options }, URL
});
const at = (day, hour) => new Date(2025, 9, day, hour).getTime();
const fixture = () => ({
  start: at(25, 9), end: at(26, 11),
  tracks: [{ id: 'team', points: [{ time: at(25, 9) }, { time: at(25, 15) }, { time: at(26, 10) }, { time: at(26, 11) }] }],
  markers: [{ time: at(25, 8) }, { time: at(26, 12) }, { time: at(27, 10) }]
});

test('daily playback starts at its first object rather than midnight', () => {
  const windows = buildWindows(fixture()).items;
  assert.equal(windows.find(w => w.key === '2025-10-25').start, at(25, 8));
  assert.equal(windows.find(w => w.key === '2025-10-26').start, at(26, 10));
});

test('all-time playback includes markers created before the first track', () => {
  assert.equal(buildWindows(fixture()).items[0].start, at(25, 8));
});

test('track-only days start at their first recorded point', () => {
  const data = fixture(); data.markers = [];
  assert.equal(buildWindows(data).items.find(w => w.key === '2025-10-25').start, at(25, 9));
});

test('marker rendering uses the original CalTopo image, size and anchor', () => {
  const icon = staticMarkerIcon({ iconUrl: 'https://caltopo.com/icon.png?cfg=pin%2C00CD00%231', iconRetinaUrl: 'https://caltopo.com/icon@2x.png?cfg=pin%2C00CD00%231', iconSize: [20, 20], iconAnchor: [10, 20] });
  assert.equal(icon.iconUrl, 'https://caltopo.com/icon.png?cfg=pin%2C00CD00%231');
  assert.equal(icon.iconRetinaUrl, 'https://caltopo.com/icon@2x.png?cfg=pin%2C00CD00%231');
  assert.deepEqual(Array.from(icon.iconSize), [20, 20]);
  assert.deepEqual(Array.from(icon.iconAnchor), [10, 20]);
});

test('API preserves CalTopo colors, fill, rotation, numeric scale and custom icons', async () => {
  const originalFetch = globalThis.fetch;
  const markers = {
    pin: { 'marker-symbol': 'pin', 'marker-color': '#00CD00', 'marker-fill': '#ffffff', 'marker-size': 1.5, 'marker-rotation': 90 },
    cp: { 'marker-symbol': 'cp', 'marker-size': 1 },
    custom: { 'marker-symbol': 'icon-EXAMPLE-32-0.25-1-ff', 'marker-size': 2 },
    composite: { 'marker-symbol': 'icon-EXAMPLE-24-0.5-0.5-ff$pin', 'marker-size': 1 },
    url: { 'marker-symbol': '/static/images/icons/usgs.png', 'marker-size': 1 }
  };
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    let result;
    if (path === '/sideload/constants.json') return Response.json({ icons: { Points: [{ id: 'pin', size: 20, anchor: [.5, 1] }, { id: 'cp', size: 18, anchor: [.5, .5] }] } });
    if (path.endsWith('/since/0')) result = { ids: { Shape: ['team'], Marker: Object.keys(markers) } };
    else if (path.includes('/Shape/')) result = { geometry: { type: 'LineString', coordinates: [[-122, 47, 0, 1000], [-122.01, 47.01, 0, 2000]] }, properties: { title: 'Team' } };
    else result = { geometry: { type: 'Point', coordinates: [-122, 47] }, properties: { title: path.split('/').at(-1), '-created-on': 500, ...markers[path.split('/').at(-1)] } };
    return Response.json({ result });
  };
  try {
    const data = await getPlayback('ABCDE');
    const team = data.tracks.find(t => t.title === 'Team');
    assert.ok(team.distanceMeters > 0, 'Track distance in meters should be greater than 0');
    assert.ok(team.distanceMiles > 0, 'Track distance in miles should be greater than 0');
    assert.equal(team.durationMs, 1000, 'Track duration should match timestamp range');
    const pin = data.markers.find(m => m.title === 'pin');
    assert.equal(pin.iconUrl, 'https://caltopo.com/icon.png?cfg=pin%2Cffffff%2C00CD00%4090%231.5');
    assert.deepEqual(pin.iconSize, [30, 30]); assert.deepEqual(pin.iconAnchor, [15, 30]);
    assert.equal(data.markers.find(m => m.title === 'cp').iconUrl, 'https://caltopo.com/icon.png?cfg=cp%231');
    assert.deepEqual(data.markers.find(m => m.title === 'custom').iconAnchor, [16, 64]);
    assert.deepEqual(data.markers.find(m => m.title === 'composite').iconSize, [24, 24]);
    assert.equal(data.markers.find(m => m.title === 'url').iconUrl, 'https://caltopo.com/static/images/icons/usgs.png');
  } finally { globalThis.fetch = originalFetch; }
});

test('UI layout prevents element overlap and includes CalTopo parity features', () => {
  assert.match(html, /z-index:\s*1100/, 'Topbar and panels must use z-index 1100 above Leaflet panes and controls');
  assert.match(html, /id="coordsDisplay"/, 'Coordinates status bar must be present for CalTopo parity');
  assert.match(html, /id="baseLayer"/, 'Base map layer switcher must be present');
  assert.match(html, /id="tzToggle"/, 'Timezone toggle (Local/UTC) must be present');
  assert.match(html, /id="labelsMode"/, 'Labels mode switcher must be present');
  assert.match(html, /isScrubbing/, 'Scrubber state tracking must be implemented');
  assert.match(html, /visibilitychange/, 'Visibility change handler must be registered to prevent tab backgrounding lag');
});

test('Enhanced Play/Pause transport, loop mode, map HUD, and Export Studio are implemented', () => {
  assert.match(html, /transport-pill-play/, 'Tactile pill button style for Play/Pause must be present');
  assert.match(html, /id="loopToggle"/, 'Loop playback toggle button must be present');
  assert.match(html, /id="mapHud"/, 'Map center HUD ripple element must be present');
  assert.match(html, /id="exportModal"/, 'Export Studio modal must be present');
  assert.match(html, /id="exportOpen"/, 'Export Studio launcher button must be present');
  assert.match(html, /id="exportCamera"/, 'Export camera mode selector must be present');
  assert.match(html, /id="exportFollowTeam"/, 'Team selection dropdown for Follow Selected Team mode must be present');
  assert.match(html, /Cinematic Auto-Cam/, 'Cinematic Auto-Cam option must be available');
  assert.match(html, /crossOrigin:\s*"anonymous"/, 'Base tile layers must configure CORS anonymous for canvas export');
  assert.match(html, /encodeGifBlob/, 'Client-side GIF encoding pipeline must be implemented');
});

test('Active Tracks Only window and active-only idle skipping are implemented', () => {
  assert.match(html, /id="activeOnly"/, 'Active Only checkbox control must be present');
  const fix = fixture();
  const windows = buildWindows(fix).items;
  const activeWin = windows.find(w => w.key === 'active');
  assert.ok(activeWin, 'Active Tracks window must be created when tracks exist');
  assert.equal(activeWin.start, at(25, 9), 'Active Tracks start must match earliest recorded track point');
  assert.equal(activeWin.end, at(26, 11), 'Active Tracks end must match latest recorded track point');
  assert.equal(activeWin.points, 4, 'Active Tracks must tally all points across tracks');
});

test('Export Studio respects main UI settings, renders vector markers, preloads tiles, and scales HUD', () => {
  // Main UI settings parity
  assert.match(html, /masterMarkersVisible = markersToggle \? markersToggle\.checked : true/, 'Export must respect master marker toggle');
  assert.match(html, /markerGroupsVisible\.has\(marker\.category\)/, 'Export must respect marker group toggles');
  assert.match(html, /Number\.isFinite\(marker\.time\) && marker\.time > t/, 'Export must respect marker appearance timestamp');
  assert.match(html, /id="exportShowMarkerLabels"/, 'Export Studio must provide Marker Names overlay toggle');
  assert.match(html, /exportShowMarkerLabels && exportShowMarkerLabels\.checked/, 'Marker names above markers must only be shown in export if explicitly enabled');
  assert.match(html, /labelsModeSelect\.value === "all"/, 'Export must respect labels mode setting');
  assert.match(html, /staleMs = Number\(stale \? stale\.value : 0\)/, 'Export must calculate track staleness');
  assert.match(html, /baseLayerSelect\.value/, 'Export must respect selected base map layer');

  // Vector marker renderer
  assert.match(html, /marker\.symbol === "point"/, 'Export must render point waypoints');
  assert.match(html, /marker\.symbol === "cp"/, 'Export must render checkpoint markers');
  assert.match(html, /ctx\.arc\(0, headY, pinR/, 'Export must render authentic CalTopo pin markers');

  // High-res tile caching & parent fallback
  assert.match(html, /const exportTileCache = new Map\(\)/, 'Export tile cache must be present');
  assert.match(html, /pKey = `\${layerKey}\/\${pZoom}\/\${ptx}\/\${pty}`/, 'Parent tile quadrant fallback must be computed');
  assert.match(html, /!seenKeys\.has\(k\) && !exportTileCache\.has\(k\)/, 'Camera trajectory tile pre-loader must pre-fetch flight tiles');

  // Prominent HUD scaling & branding
  assert.match(html, /hudScale = Math\.max\(1, Math\.min\(2\.5, width \/ 1000\)\)/, 'HUD elements must scale dynamically with resolution');
  assert.match(html, /CalTopo Playback/, 'Brand badge must display CalTopo Playback');
  assert.match(html, /#2dd4bf/, 'Brand badge must use CalTopo accent styling');
});

test('Export Studio achieves authentic CalTopo icon and feel parity with Leaflet map', () => {
  // Marker icon cache and real CalTopo icon drawing
  assert.match(html, /const exportMarkerIconCache = new Map\(\)/, 'Marker icon cache must be present');
  assert.match(html, /ctx\.drawImage\(img, drawX, drawY, drawW, drawH\)/, 'Export must draw authentic marker icons via drawImage');
  assert.match(html, /drawFallbackMarker/, 'Export must provide graceful vector fallback');

  // Navigation puck SVG parity
  assert.match(html, /6\.8 \* puckScale/, 'Puck radius must match SVG 6.8 radius');
  assert.match(html, /2\.2 \* puckScale/, 'Puck stroke and center dot must match SVG 2.2 spec');
  assert.match(html, /ctx\.lineTo\(3\.5 \* puckScale, -5 \* puckScale\)/, 'Directional notch must match SVG points');

  // Tooltip positioning and styling parity
  assert.match(html, /puck\.y - \(14 \* puckScale\) - ph/, 'Track label pill must be placed above puck matching Leaflet offset [0, -14]');
  assert.match(html, /rgba\(15, 23, 42, 0\.88\)/, 'Track label pill must match .playback-label styling');
  assert.match(html, /rgba\(30, 41, 59, 0\.92\)/, 'Marker label pill must match .marker-label styling');

  // Camera motion default
  assert.match(html, /<option value="static" selected>Match Map View/, 'Export camera must default to matching interactive map view');

  // Initialization order check: exportMarkerIconCache must be declared before setupMarkers is called
  const cacheInitPos = html.indexOf('const exportMarkerIconCache = new Map();');
  const setupCallPos = html.indexOf('setupMarkers(data.markers');
  assert.ok(cacheInitPos !== -1, 'exportMarkerIconCache must be defined');
  assert.ok(setupCallPos !== -1, 'setupMarkers call must exist');
  assert.ok(cacheInitPos < setupCallPos, 'exportMarkerIconCache must be declared before setupMarkers is invoked');

  // Map center HUD popups must be disabled per user preference
  assert.match(html, /\.map-hud\s*\{\s*display:\s*none\s*!important;/, 'Map center HUD popup must be disabled in CSS');
});

test('Dark Mode toggle, CSS variables, Esri Dark Canvas base layer, and persistence are implemented', () => {
  // 1. UI Buttons & Base Layer Select Options
  assert.match(html, /id="themeToggle"/, 'Topbar theme toggle button must be present');
  assert.match(html, /id="themeToggleLoader"/, 'Loader theme toggle button must be present');
  assert.match(html, /<option value="esri_dark">Dark \(Esri\)<\/option>/, 'Esri Dark Canvas option must be available in base layer selector');

  // 2. Comprehensive Dark Mode CSS
  assert.match(html, /body\.dark-mode\s*\{[^}]*--bg:\s*#0b0f19/, 'Dark mode background variable must be defined');
  assert.match(html, /body\.dark-mode\s*\{[^}]*--panel-bg:\s*rgba\(15,\s*23,\s*42,\s*0\.94\)/, 'Dark mode panel background must be defined');
  assert.match(html, /body\.dark-mode \.load-card/, 'Dark mode loader card style must be defined');
  assert.match(html, /body\.dark-mode \.export-card/, 'Dark mode export card style must be defined');
  assert.match(html, /body\.dark-mode \.leaflet-control-zoom/, 'Dark mode Leaflet zoom controls must be styled');
  assert.match(html, /body\.dark-mode \.leaflet-popup-content-wrapper/, 'Dark mode popup content must be styled');

  // 3. Basemap and Tile URL support (Esri World Dark Gray Canvas - zero API key required)
  assert.match(html, /esri_dark:\s*L\.tileLayer\("https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/Canvas\/World_Dark_Gray_Base/, 'Esri Dark Canvas tile layer must be configured');
  assert.match(html, /layerKey === "esri_dark"/, 'Export renderer getTileUrl must support Esri Dark Canvas tiles');

  // 4. Persistence & Keyboard Shortcut
  assert.match(html, /const THEME_STORAGE_KEY = "caltopo_theme"/, 'Theme preference must use caltopo_theme storage key');
  assert.match(html, /e\.code === "KeyD"/, 'D key keyboard shortcut must toggle dark mode');
  assert.match(html, /prefers-color-scheme:\s*dark/, 'System dark mode preference must be detected');
});

test('Export marker label toggle, team selection, and authentic Mercator framing are implemented', () => {
  // 1. Export Marker Label Toggle
  assert.match(html, /id="exportShowMarkerLabels"/, 'Export studio must provide a checkbox for marker labels');
  assert.match(html, /exportShowMarkerLabels\s*&&\s*exportShowMarkerLabels\.checked/, 'Export renderer must only render marker label pills if enabled');

  // 2. Follow Selected Team Dropdown
  assert.match(html, /id="exportFollowTeamGroup"/, 'Export studio must have follow team group container');
  assert.match(html, /id="exportFollowTeam"/, 'Export studio must have follow team select element');
  assert.match(html, /function populateExportTeams\(\)/, 'populateExportTeams function must populate team options');
  assert.match(html, /function selectTrack\(trackId/, 'selectTrack function must coordinate track selection across UI');

  // 3. Authentic Web Mercator Framing and Active Track Filtering
  assert.match(html, /function mercatorNormY\(lat\)/, 'Mercator normalized Y projection helper must be present');
  assert.match(html, /function mercatorInvY\(yNorm\)/, 'Mercator inverse Y projection helper must be present');
  assert.match(html, /activeGraceMs\s*=\s*300000/, 'Cinematic auto-cam must strictly filter for active tracks within grace window');
  assert.match(html, /Math\.log2\(availW \/ \(256 \* spanX\)\)/, 'Mercator zoom calculation must fit exact canvas width');
  assert.match(html, /Math\.log2\(availH \/ \(256 \* spanY\)\)/, 'Mercator zoom calculation must fit exact canvas height');
  assert.match(html, /Math\.max\(10\.5,\s*Math\.min\(14\.8/, 'Cinematic auto-cam must clamp zoom to 14.8 to preserve topographic context');
});

test('Performance optimizations: zero DOM churn live playback, Gaussian camera smoothing, fast LUT GIF, and requestFrame video', () => {
  // 1. Live Playback GPU transform without DOM churn
  assert.match(html, /puck-group/, 'Marker icon must use puck-group SVG container');
  assert.match(html, /puckGroup\.setAttribute\("transform",\s*`rotate\(\$\{h\} 12 12\)`\)/, 'Marker rotation must mutate existing SVG transform without calling setIcon every frame');
  assert.match(html, /track\._cachedLatLngs/, 'Polyline points slicing must use cached coordinates array');

  // 2. Export Trajectory Bidirectional Gaussian Smoothing
  assert.match(html, /Math\.exp\(-2\.5 \* dist \* dist\)/, 'Camera trajectory must use zero-lag Gaussian window smoothing');

  // 3. Fast GIF 15-bit color LUT
  assert.match(html, /const colorLUT = new Uint8Array\(32768\)/, 'GIF encoder must precompute 32KB 15-bit color lookup table');
  assert.match(html, /colorLUT\[\(r5 << 10\) \| \(g5 << 5\) \| b5\]/, 'GIF pixel loop must index directly into colorLUT');

  // 4. Deterministic Video Frame Pacing
  assert.match(html, /renderCanvas\.captureStream\(0\)/, 'Video export must initialize stream in manual frame capture mode (0 fps)');
  assert.match(html, /videoTrack\.requestFrame\(\)/, 'Video export loop must trigger videoTrack.requestFrame() per canvas frame');
});

test('Tile flicker prevention: native zoom limits, multi-zoom parent fallbacks, and seamless rendering', () => {
  // 1. Layer native zoom clamping
  assert.match(html, /function getMaxNativeZoom\(layerKey\)/, 'getMaxNativeZoom helper must be defined');
  assert.match(html, /layerKey === "usgs" \|\| layerKey === "esri_dark" \|\| layerKey === "carto_dark"\) return 16/, 'USGS and Esri Dark must be clamped to zoom 16');
  assert.match(html, /layerKey === "opentopo"\) return 17/, 'OpenTopoMap must be clamped to zoom 17');

  // 2. Leaflet base layer smooth zooming and caching
  assert.match(html, /maxNativeZoom:\s*16/, 'Leaflet base layers must configure maxNativeZoom to avoid 404 tile errors');
  assert.match(html, /keepBuffer:\s*8/, 'Leaflet base layers must keep buffer tiles in memory during panning');
  assert.match(html, /updateWhenIdle:\s*false/, 'Leaflet base layers must load continuously to prevent flashing');

  // 3. Subpixel seamless tile sizing and multi-zoom parent fallback
  assert.match(html, /Math\.ceil\(tileSize \* zoomFactor\) \+ 0\.5/, 'Tile dimensions must overlap by half-pixel to eliminate seam grid lines');
  assert.match(html, /gpKey = `\${layerKey}\/\${gpZoom}\/\${gptx}\/\${gpty}`/, 'Grandparent tile fallback must be computed for robust multi-zoom coverage');
  assert.doesNotMatch(html, /ctx\.strokeRect\(px,\s*py,\s*dw,\s*dh\)/, 'RenderExportFrame must never draw artificial bordered grid boxes on loading tiles');

  // 4. Debounced preview rendering
  assert.match(html, /scheduleExportPreviewRender/, 'Preview updates on tile load must be debounced via requestAnimationFrame');
});

test('Code quality and bug hardening: URL parsing, numerical stability, zero-leak sessions, and bit-packed LZW', () => {
  // 1. URL and Map ID Parsing
  assert.equal(parseMapId("04GP2VD"), "04GP2VD");
  assert.equal(parseMapId("https://caltopo.com/m/04GP2VD"), "04GP2VD");
  assert.equal(parseMapId("caltopo.com/m/04GP2VD"), "04GP2VD", "Should parse URLs without protocol scheme");
  assert.equal(parseMapId("https://sartopo.com/m/ABC123"), "ABC123");
  assert.equal(parseMapId("   "), "", "Empty string should return empty");
  assert.equal(parseMapId("invalid-url-here"), "", "Invalid string should return empty");

  // 2. Single KeyD listener to prevent double theme toggle
  assert.match(html, /e\.code === "KeyD"/, 'D key keyboard shortcut must toggle dark mode');
  // Check that KeyD is NOT duplicated inside playback loop
  const innerShortcuts = html.slice(html.indexOf('// Keyboard Shortcuts (Space, L, Left, Right, Home, End)'), html.indexOf('// =========================================='));
  assert.doesNotMatch(innerShortcuts, /KeyD/, 'Inner playback keydown handler must not duplicate KeyD toggle');

  // 3. Markers toggle event parameter safety
  assert.match(html, /markersToggle\.onchange = \(\) => updateMarkers\(current\)/, 'markersToggle must not forward DOM Event to updateMarkers');
  assert.match(html, /typeof at === "number" \? at : current/, 'updateMarkers must guard timestamp argument against non-number');

  // 4. Session lifecycle cleanup and zero-allocation bounds
  assert.match(html, /let activePlaybackCleanup = null/, 'activePlaybackCleanup lifecycle handle must exist');
  assert.match(html, /new AbortController\(\)/, 'Session controller must manage listener lifecycles');
  assert.match(html, /let minLat = Infinity, maxLat = -Infinity/, 'fitWindowBounds must calculate bounds directly without allocating coordinate arrays');

  // 5. Zero-allocation integer bit-packed LZW compression
  assert.match(html, /const key = \(prefix << 8\) \| k/, 'LZW compressor must use bit-packed integer keys instead of string concatenation');

  // 6. MediaStream release
  assert.match(html, /stream\.getTracks\(\)\.forEach/, 'Video export must release captureStream tracks');

  // 7. GitHub Repository Link
  assert.match(html, /href="https:\/\/github\.com\/RCGV1\/caltopo-track-playback"/, 'GitHub repository links must be present in the UI');
  assert.match(html, /id="githubBtn"/, 'Topbar GitHub button must be present');
});

test('CalTopo 401/403 permission denied returns PERMISSION_DENIED code, mapId, and actionable instructions', async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 1. Backend: 403 Forbidden on map summary
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: "Access Denied" })
    });

    await assert.rejects(
      async () => getPlayback("PRIV123"),
      (err) => {
        assert.ok(err instanceof PlaybackError);
        assert.equal(err.status, 403);
        assert.equal(err.code, "PERMISSION_DENIED");
        assert.equal(err.mapId, "PRIV123");
        assert.match(err.message, /CalTopo permission denied: This map is private/);
        assert.match(err.message, /URL Viewable/);
        return true;
      }
    );

    // 2. Backend: 401 Unauthorized
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => "Unauthorized"
    });

    await assert.rejects(
      async () => getPlayback("SECRET77"),
      (err) => {
        assert.ok(err instanceof PlaybackError);
        assert.equal(err.status, 401);
        assert.equal(err.code, "PERMISSION_DENIED");
        assert.equal(err.mapId, "SECRET77");
        return true;
      }
    );

    // 3. Serverless API handler responds with 403 status and structured JSON
    let responseStatus = 0;
    let responseJson = null;
    const mockRes = {
      setHeader: () => {},
      status(s) { responseStatus = s; return this; },
      json(j) { responseJson = j; return this; },
      end() {}
    };
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      text: async () => ""
    });
    await handler({ method: "GET", query: { map: "PRIV123" } }, mockRes);
    assert.equal(responseStatus, 403);
    assert.equal(responseJson.code, "PERMISSION_DENIED");
    assert.equal(responseJson.mapId, "PRIV123");
    assert.match(responseJson.error, /CalTopo permission denied/);

    // 4. CalTopo 404 summary returns NOT_FOUND code
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      text: async () => ""
    });
    await assert.rejects(
      async () => getPlayback("MISSING99"),
      (err) => {
        assert.ok(err instanceof PlaybackError);
        assert.equal(err.status, 404);
        assert.equal(err.code, "NOT_FOUND");
        assert.equal(err.mapId, "MISSING99");
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 5. Frontend UI error banner styles & step-by-step instructions parity
  assert.match(html, /\.error-banner/, 'Error banner style must be defined');
  assert.match(html, /\.error-banner\.permission-error/, 'Permission error banner variant must be supported');
  assert.match(html, /CalTopo Permission Denied \(Map is Private\)/, 'Permission denied headline must be present');
  assert.match(html, /How to enable playback in CalTopo:/, 'Clear step-by-step instructions header must be present');
  assert.match(html, /URL Viewable/, 'URL Viewable guidance must be highlighted');
  assert.match(html, /Open in CalTopo/, 'Direct link button to open map in CalTopo must be present');
  assert.match(html, /Try Public Demo \(SAR Academy\)/, 'Fallback button to try public demo map must be provided');
  assert.match(html, /body\.dark-mode \.error-banner/, 'Dark mode error banner styling must be defined');
});

test('dist function is hoisted before distance calculation to prevent TDZ ReferenceError', () => {
  const distDeclPos = html.indexOf('function dist(a, b) {');
  const distUsagePos = html.indexOf('meters += dist(track.points[i - 1], track.points[i]);');
  assert.ok(distDeclPos !== -1, 'dist helper must be declared');
  assert.ok(distUsagePos !== -1, 'dist helper usage must exist');
  assert.ok(distDeclPos < distUsagePos, 'dist helper must be declared before track distance calculation loop');

  // Verify function execution in sandbox
  const distFuncCode = html.slice(distDeclPos, html.indexOf('// Calculate track distances', distDeclPos));
  const { dist } = runInNewContext(distFuncCode + '\n({dist})');
  const ptA = { lat: 47.0, lng: -122.0 };
  const ptB = { lat: 47.01, lng: -122.01 };
  const d = dist(ptA, ptB);
  assert.ok(d > 1000 && d < 2000, `Distance should be ~1340m, got ${d}`);

  // Test that interp is declared as hoisted function
  assert.match(html, /function interp\(track, at\)/, 'interp must be a function declaration');
});
