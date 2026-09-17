import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { getPlayback } from '../api/playback.js';

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
    const pin = data.markers.find(m => m.title === 'pin');
    assert.equal(pin.iconUrl, 'https://caltopo.com/icon.png?cfg=pin%2Cffffff%2C00CD00%4090%231.5');
    assert.deepEqual(pin.iconSize, [30, 30]); assert.deepEqual(pin.iconAnchor, [15, 30]);
    assert.equal(data.markers.find(m => m.title === 'cp').iconUrl, 'https://caltopo.com/icon.png?cfg=cp%231');
    assert.deepEqual(data.markers.find(m => m.title === 'custom').iconAnchor, [16, 64]);
    assert.deepEqual(data.markers.find(m => m.title === 'composite').iconSize, [24, 24]);
    assert.equal(data.markers.find(m => m.title === 'url').iconUrl, 'https://caltopo.com/static/images/icons/usgs.png');
  } finally { globalThis.fetch = originalFetch; }
});
