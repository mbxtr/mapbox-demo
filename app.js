// ── Constants ─────────────────────────────────────────────────────────────────

const MATCH_API      = 'https://api.mapbox.com/matching/v5/mapbox/walking';
const MAX_MATCH_PTS  = 100;    // Map Matching API limit
const MIN_PX_GAP     = 10;     // px between sampled draw points
const TOUR_ZOOM      = 17.5;
const TOUR_PITCH     = 65;
// Simulated walking speeds in metres/second per speed level (1×–5×)
const SPEED_MPS      = [3, 6, 12, 25, 50];
const SPEED_LABELS   = ['1×', '2×', '4×', '8×', '16×'];

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  mode: 'idle',         // idle | drawing | snapping | ready | touring
  rawPoints: [],
  snappedCoords: [],
  cumDists: [],
  totalDist: 0,
  steps: [],
  tourCurrentDist: 0,
  tourLastTime: null,
  tourAnimFrame: null,
  tourSpeed: 0,
};

// ── Map globals ───────────────────────────────────────────────────────────────

let map;
let token;

// ── Map initialisation ────────────────────────────────────────────────────────

function initMap(accessToken) {
  token = accessToken;
  mapboxgl.accessToken = accessToken;

  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [-74.006, 40.7128],
    zoom: 14,
    pitch: 0,
    bearing: 0,
    antialias: true,
  });

  map.addControl(new mapboxgl.NavigationControl(), 'top-left');
  map.addControl(
    new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }),
    'top-left'
  );

  map.on('load', onMapLoad);
}

function onMapLoad() {
  // Terrain elevation
  map.addSource('mapbox-dem', {
    type: 'raster-dem',
    url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
    tileSize: 512,
    maxzoom: 14,
  });
  map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });

  // Atmospheric haze
  map.setFog({ range: [0.5, 10], color: 'white', 'horizon-blend': 0.1 });

  // 3D buildings — inserted below the first symbol layer so labels stay on top
  const firstSymbolId = map.getStyle().layers.find(
    l => l.type === 'symbol' && l.layout?.['text-field']
  )?.id;

  map.addLayer(
    {
      id: '3d-buildings',
      source: 'composite',
      'source-layer': 'building',
      filter: ['==', 'extrude', 'true'],
      type: 'fill-extrusion',
      minzoom: 15,
      paint: {
        'fill-extrusion-color': '#d0d8e0',
        'fill-extrusion-height': [
          'interpolate', ['linear'], ['zoom'], 15, 0, 15.05, ['get', 'height'],
        ],
        'fill-extrusion-base': [
          'interpolate', ['linear'], ['zoom'], 15, 0, 15.05, ['get', 'min_height'],
        ],
        'fill-extrusion-opacity': 0.75,
      },
    },
    firstSymbolId
  );

  // ── Route sources & layers ─────────────────────────────────────────────────

  map.addSource('drawn', { type: 'geojson', data: nullGJ() });
  map.addLayer({
    id: 'drawn-line',
    type: 'line',
    source: 'drawn',
    paint: { 'line-color': '#ff6b6b', 'line-width': 3, 'line-dasharray': [3, 3], 'line-opacity': 0.8 },
  });

  map.addSource('snapped', { type: 'geojson', data: nullGJ() });
  map.addLayer({
    id: 'snapped-casing',
    type: 'line',
    source: 'snapped',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'snapped-line',
    type: 'line',
    source: 'snapped',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#3b82f6', 'line-width': 5 },
  });

  map.addSource('marker', { type: 'geojson', data: nullGJ() });
  map.addLayer({
    id: 'marker-circle',
    type: 'circle',
    source: 'marker',
    paint: {
      'circle-radius': 9,
      'circle-color': '#ff6b6b',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2.5,
    },
  });

  setMode('idle');
  document.getElementById('draw-btn').disabled = false;
}

// ── GeoJSON helpers ───────────────────────────────────────────────────────────

function nullGJ() {
  return { type: 'FeatureCollection', features: [] };
}

function lineGJ(coords) {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };
}

function pointGJ(coord) {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: coord } };
}

// ── Geometry math ─────────────────────────────────────────────────────────────

function haversine([lng1, lat1], [lng2, lat2]) {
  const R = 6_371_000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing([lng1, lat1], [lng2, lat2]) {
  const r = Math.PI / 180;
  const dLng = (lng2 - lng1) * r;
  const y = Math.sin(dLng) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function buildCumDists(coords) {
  const d = [0];
  for (let i = 1; i < coords.length; i++) d.push(d[i - 1] + haversine(coords[i - 1], coords[i]));
  return d;
}

function posAtDist(coords, cum, target) {
  for (let i = 0; i < coords.length - 1; i++) {
    if (cum[i + 1] >= target) {
      const seg = cum[i + 1] - cum[i];
      const t = seg > 0 ? (target - cum[i]) / seg : 0;
      return [
        coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
        coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
      ];
    }
  }
  return coords[coords.length - 1];
}

function bearingAtDist(coords, cum, target) {
  for (let i = 0; i < coords.length - 1; i++) {
    if (cum[i + 1] >= target) return bearing(coords[i], coords[i + 1]);
  }
  return bearing(coords[coords.length - 2], coords[coords.length - 1]);
}

function sampleUniform(pts, n) {
  if (pts.length <= n) return pts;
  const step = (pts.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => pts[Math.round(i * step)]);
}

// Perpendicular distance in metres from pt to segment [a, b]
function ptToSegDist(pt, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return haversine(pt, a);
  const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return haversine(pt, [a[0] + t * dx, a[1] + t * dy]);
}

// Ramer-Douglas-Peucker simplification, epsilon in metres
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, maxI = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = ptToSegDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; maxI = i; }
  }
  if (maxD > eps) {
    const l = rdp(pts.slice(0, maxI + 1), eps);
    const r = rdp(pts.slice(maxI), eps);
    return [...l.slice(0, -1), ...r];
  }
  return [pts[0], pts[pts.length - 1]];
}

// Binary-search for the largest epsilon that keeps point count <= maxN
function rdpToLimit(pts, maxN) {
  if (pts.length <= maxN) return pts;
  let lo = 0, hi = 500;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    rdp(pts, mid).length > maxN ? (lo = mid) : (hi = mid);
  }
  const result = rdp(pts, hi);
  return result.length <= maxN ? result : sampleUniform(result, maxN);
}

function fmtDist(m) {
  const miles = m / 1609.344;
  return miles >= 0.1 ? `${miles.toFixed(2)} mi` : `${Math.round(m * 3.28084)} ft`;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} min ${Math.round(s % 60)} sec` : `${Math.round(s)} sec`;
}

// ── Freehand drawing ──────────────────────────────────────────────────────────

let drawing = false;
let lastPx = null;

function enableDrawing() {
  drawing = false;
  lastPx = null;
  state.rawPoints = [];
  map.dragPan.disable();
  map.dragRotate.disable();
  map.getCanvas().style.cursor = 'crosshair';
  map.on('mousedown', onDown);
  map.on('mousemove', onMove);
  map.on('mouseup', onUp);
  map.on('touchstart', onTouchStart);
  map.on('touchmove', onTouchMove);
  map.on('touchend', onTouchEnd);
}

function disableDrawing() {
  map.off('mousedown', onDown);
  map.off('mousemove', onMove);
  map.off('mouseup', onUp);
  map.off('touchstart', onTouchStart);
  map.off('touchmove', onTouchMove);
  map.off('touchend', onTouchEnd);
  map.dragPan.enable();
  map.dragRotate.enable();
  map.getCanvas().style.cursor = '';
}

function onDown(e) {
  drawing = true;
  lastPx = e.point;
  state.rawPoints = [[e.lngLat.lng, e.lngLat.lat]];
}

function onMove(e) {
  if (!drawing) return;
  const px = e.point;
  if (lastPx) {
    const dx = px.x - lastPx.x, dy = px.y - lastPx.y;
    if (dx * dx + dy * dy < MIN_PX_GAP * MIN_PX_GAP) return;
  }
  lastPx = px;
  state.rawPoints.push([e.lngLat.lng, e.lngLat.lat]);
  if (state.rawPoints.length >= 2) {
    map.getSource('drawn').setData(lineGJ(state.rawPoints));
  }
}

function onUp() {
  if (!drawing) return;
  drawing = false;
  disableDrawing();
  if (state.rawPoints.length < 2) {
    setMode('idle');
    return;
  }
  snapRoute();
}

function onTouchStart(e) {
  const ll = e.lngLat;
  drawing = true;
  lastPx = e.point;
  state.rawPoints = [[ll.lng, ll.lat]];
}

function onTouchMove(e) {
  if (!drawing) return;
  const px = e.point;
  if (lastPx) {
    const dx = px.x - lastPx.x, dy = px.y - lastPx.y;
    if (dx * dx + dy * dy < MIN_PX_GAP * MIN_PX_GAP) return;
  }
  lastPx = px;
  const ll = e.lngLat;
  state.rawPoints.push([ll.lng, ll.lat]);
  if (state.rawPoints.length >= 2) {
    map.getSource('drawn').setData(lineGJ(state.rawPoints));
  }
}

function onTouchEnd() {
  onUp();
}

// ── Map Matching API ──────────────────────────────────────────────────────────

async function snapRoute() {
  setMode('snapping');

  const waypoints = rdpToLimit(
    state.rawPoints.filter(([lng, lat]) => isFinite(lng) && isFinite(lat)),
    MAX_MATCH_PTS
  );

  const coordPath = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(';');
  const radii     = waypoints.map(() => 25).join(';');

  try {
    const params = new URLSearchParams({
      access_token: token,
      steps: 'true',
      geometries: 'geojson',
      overview: 'full',
      radiuses: radii,
    });

    const res  = await fetch(`${MATCH_API}/${coordPath}?${params}`);
    const json = await res.json();

    if (json.code !== 'Ok' || !json.matchings?.length) {
      throw new Error(
        json.message || 'No road found near your path. Try drawing closer to streets or paths.'
      );
    }

    // Stitch all matchings — the API splits when a point is too far from any road
    const allCoords = json.matchings.flatMap(m => m.geometry.coordinates);
    const allSteps  = json.matchings.flatMap(m => m.legs.flatMap(l => l.steps));
    const totalDist = json.matchings.reduce((s, m) => s + m.distance, 0);
    const totalDur  = json.matchings.reduce((s, m) => s + m.duration, 0);

    state.snappedCoords = allCoords;
    state.cumDists      = buildCumDists(allCoords);
    state.totalDist     = state.cumDists[state.cumDists.length - 1];
    state.steps         = allSteps;

    map.getSource('drawn').setData(nullGJ());
    map.getSource('snapped').setData(lineGJ(allCoords));

    const bounds = allCoords.reduce(
      (b, c) => b.extend(c),
      new mapboxgl.LngLatBounds(allCoords[0], allCoords[0])
    );
    map.fitBounds(bounds, { padding: 60, pitch: 0, bearing: 0, duration: 1000 });

    setMode('ready');
    renderRouteInfo(totalDist, totalDur);
    renderDirections(allSteps);

  } catch (err) {
    map.getSource('drawn').setData(nullGJ());
    showError(err.message);
    setMode('idle');
  }
}

// ── Directions rendering ──────────────────────────────────────────────────────

const ICONS = {
  depart:             '▶',
  arrive:             '⬛',
  straight:           '↑',
  'turn left':        '↰',
  'turn right':       '↱',
  'turn slight left': '↖',
  'turn slight right':'↗',
  'turn sharp left':  '↶',
  'turn sharp right': '↷',
  roundabout:         '↻',
  rotary:             '↻',
  merge:              '⤷',
  'fork left':        '↰',
  'fork right':       '↱',
};

function stepIcon(type, modifier) {
  if (type === 'depart') return ICONS.depart;
  if (type === 'arrive') return ICONS.arrive;
  const key = modifier ? `${type} ${modifier}` : type;
  return ICONS[key] ?? ICONS[type] ?? '→';
}

function renderRouteInfo(dist, dur) {
  document.getElementById('distance').textContent = fmtDist(dist);
  document.getElementById('duration').textContent = fmtTime(dur);
}

function renderDirections(steps) {
  document.getElementById('directions-list').innerHTML = steps.map((s, i) => `
    <li class="step" data-i="${i}">
      <span class="step-icon">${stepIcon(s.maneuver.type, s.maneuver.modifier)}</span>
      <span class="step-body">
        <span class="step-text">${s.maneuver.instruction}</span>
        ${s.distance > 0 ? `<span class="step-dist">${fmtDist(s.distance)}</span>` : ''}
      </span>
    </li>
  `).join('');
}

function highlightStep(i) {
  document.querySelectorAll('.step').forEach((el, j) => {
    const active = j === i;
    el.classList.toggle('active', active);
    if (active) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  const s = state.steps[i];
  if (s) {
    document.getElementById('current-step-icon').textContent = stepIcon(s.maneuver.type, s.maneuver.modifier);
    document.getElementById('current-step-text').textContent = s.maneuver.instruction;
    document.getElementById('current-step-dist').textContent = s.distance > 0 ? fmtDist(s.distance) : '';
  }
}

function activeStepAt(dist) {
  let acc = 0;
  for (let i = 0; i < state.steps.length; i++) {
    acc += state.steps[i].distance;
    if (dist <= acc) return i;
  }
  return state.steps.length - 1;
}

// ── Tour ──────────────────────────────────────────────────────────────────────

function startTour() {
  state.tourCurrentDist = 0;
  state.tourLastTime = null;
  setMode('touring');

  const [c0, c1] = state.snappedCoords;
  map.flyTo({
    center: c0,
    zoom: TOUR_ZOOM,
    pitch: TOUR_PITCH,
    bearing: c1 ? bearing(c0, c1) : 0,
    duration: 1500,
    essential: true,
  });

  setTimeout(runTour, 1600);
}

function runTour() {
  if (state.mode !== 'touring') return;

  function tick(now) {
    if (state.mode !== 'touring') return;

    if (state.tourLastTime !== null) {
      const dt = (now - state.tourLastTime) / 1000;
      state.tourCurrentDist = Math.min(
        state.tourCurrentDist + dt * SPEED_MPS[state.tourSpeed],
        state.totalDist
      );
    }
    state.tourLastTime = now;

    const d = state.tourCurrentDist;
    const pos = posAtDist(state.snappedCoords, state.cumDists, d);
    // Look slightly ahead for smoother bearing transitions
    const lookAhead = posAtDist(state.snappedCoords, state.cumDists, Math.min(d + 8, state.totalDist));
    const brng = bearing(pos, lookAhead);

    map.jumpTo({ center: pos, bearing: brng, pitch: TOUR_PITCH, zoom: TOUR_ZOOM });
    map.getSource('marker').setData(pointGJ(pos));
    highlightStep(activeStepAt(d));

    if (d < state.totalDist) {
      state.tourAnimFrame = requestAnimationFrame(tick);
    } else {
      finishTour();
    }
  }

  state.tourAnimFrame = requestAnimationFrame(tick);
}

function stopTour() {
  if (state.tourAnimFrame) {
    cancelAnimationFrame(state.tourAnimFrame);
    state.tourAnimFrame = null;
  }
  map.getSource('marker').setData(nullGJ());
  setMode('ready');
}

function finishTour() {
  map.getSource('marker').setData(nullGJ());
  setMode('ready');

  const bounds = state.snappedCoords.reduce(
    (b, c) => b.extend(c),
    new mapboxgl.LngLatBounds(state.snappedCoords[0], state.snappedCoords[0])
  );
  map.fitBounds(bounds, { padding: 80, pitch: 30, bearing: 0, duration: 2000 });
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function clearAll() {
  if (state.tourAnimFrame) {
    cancelAnimationFrame(state.tourAnimFrame);
    state.tourAnimFrame = null;
  }
  disableDrawing();
  drawing = false;

  Object.assign(state, {
    rawPoints: [],
    snappedCoords: [],
    cumDists: [],
    totalDist: 0,
    steps: [],
    tourCurrentDist: 0,
    tourLastTime: null,
    tourSpeed: 0,
  });

  if (map) {
    ['drawn', 'snapped', 'marker'].forEach(id => {
      if (map.getSource(id)) map.getSource(id).setData(nullGJ());
    });
    map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
  }

  document.getElementById('directions-list').innerHTML = '';
  document.querySelectorAll('.speed-seg').forEach((el, i) => el.classList.toggle('active', i === 0));

  setMode('idle');
}

// ── UI state machine ──────────────────────────────────────────────────────────

const STATUS_MSG = {
  idle:     'Click "Draw Route" then drag on the map to trace your path.',
  drawing:  'Drag to draw your route.',
  snapping: 'Snapping route to roads…',
  ready:    'Route ready! Start the tour or draw a new one.',
  touring:  'Tour in progress…',
};

function showError(msg) {
  const el = document.getElementById('status-text');
  el.textContent = `Error: ${msg}`;
  el.classList.add('error');
}

function setMode(m) {
  state.mode = m;

  const el = id => document.getElementById(id);
  const touring = m === 'touring';
  const show = ['ready', 'touring'].includes(m);

  el('status-text').textContent = STATUS_MSG[m] ?? '';
  el('status-text').classList.remove('error');
  el('spinner').classList.toggle('hidden', m !== 'snapping');

  el('draw-btn').disabled = ['drawing', 'snapping', 'touring'].includes(m);
  el('draw-btn').textContent = m === 'drawing' ? 'Drawing…' : 'Draw Route';
  el('draw-btn').classList.toggle('hidden', touring || m === 'ready');
  el('clear-btn').disabled = ['idle', 'drawing', 'snapping'].includes(m);

  // During tour: collapse sheet to current-step only
  el('sheet-header').classList.toggle('hidden', touring);
  el('status').classList.toggle('hidden', touring);
  el('route-info').classList.toggle('hidden', !show || touring);
  el('directions-panel').classList.toggle('hidden', !show || touring);
  el('current-step').classList.toggle('hidden', !touring);

  el('tour-controls').classList.toggle('hidden', !show);
  el('tour-btn').classList.toggle('hidden', touring);
  el('tour-speed').classList.toggle('hidden', !touring);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function bootstrap() {
  initMap('pk.eyJ1IjoibWJ4dHIiLCJhIjoiY2p1MjE3b3IxMDQzMzQ0bzZic3JnZ3BzeSJ9.DXMOudIzUmXJGu8YayWK3g');
}

// ── Event listeners ───────────────────────────────────────────────────────────

document.getElementById('draw-btn').addEventListener('click', () => {
  if (!['idle', 'ready'].includes(state.mode)) return;
  clearAll();
  setMode('drawing');
  enableDrawing();
});

document.getElementById('clear-btn').addEventListener('click', clearAll);

document.getElementById('tour-btn').addEventListener('click', startTour);

document.getElementById('stop-tour-btn').addEventListener('click', stopTour);

document.getElementById('speed-segments').addEventListener('click', e => {
  const seg = e.target.closest('.speed-seg');
  if (!seg) return;
  state.tourSpeed = Number(seg.dataset.speed);
  document.querySelectorAll('.speed-seg').forEach(el => el.classList.toggle('active', el === seg));
});

bootstrap();
