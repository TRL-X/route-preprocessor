import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapLibreMap, GeoJSONSource, setWorkerUrl } from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './components.css';
import type { DraftStation, ReferenceRoute } from '../core/types';

setWorkerUrl(workerUrl);

interface Props {
  reference: ReferenceRoute | null;
  stations: DraftStation[];
  selectedStationId: number | null;
  cursorS: number | null;
  onCursorChange: (s: number) => void;
  onStationSelect: (id: number) => void;
  onRouteClick?: (s: number) => void;
  language: 'en' | 'zh';
  basemap: boolean;
}

type Coordinate = [number, number];
const BASE_STYLE = import.meta.env.VITE_MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/liberty';
const emptyCollection = { type: 'FeatureCollection' as const, features: [] };
const blankStyle = (): StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [{ id: 'paper', type: 'background', paint: { 'background-color': '#ebece3' } }],
});

// Keep consecutive points in the same world copy when a route crosses ±180°.
function unwrap(reference: ReferenceRoute | null): Coordinate[] {
  const result: Coordinate[] = [];
  for (const point of reference?.points ?? []) {
    let lon = point.lon;
    const previous = result.at(-1)?.[0] ?? lon;
    while (lon - previous > 180) lon -= 360;
    while (lon - previous < -180) lon += 360;
    result.push([lon, Math.max(-85.051129, Math.min(85.051129, point.lat))]);
  }
  return result;
}

function positionAt(reference: ReferenceRoute, coordinates: Coordinate[], distance: number): Coordinate {
  if (!coordinates.length) return [0, 0];
  let lo = 0;
  let hi = reference.points.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (reference.points[mid].s < distance) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(0, lo - 1);
  const j = Math.min(coordinates.length - 1, lo);
  const span = reference.points[j].s - reference.points[i].s;
  const t = span > 0 ? Math.max(0, Math.min(1, (distance - reference.points[i].s) / span)) : 0;
  return [coordinates[i][0] + (coordinates[j][0] - coordinates[i][0]) * t,
    coordinates[i][1] + (coordinates[j][1] - coordinates[i][1]) * t];
}

function source(map: MapLibreMap, id: string) {
  return map.getSource(id) as GeoJSONSource | undefined;
}

function addLayers(map: MapLibreMap) {
  if (map.getSource('route')) return;
  for (const id of ['route', 'stations', 'cursor', 'directions']) {
    map.addSource(id, { type: 'geojson', data: emptyCollection });
  }
  map.addLayer({ id: 'route-halo', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.85 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#355b45', 'line-width': 4.5 } });
  map.addLayer({ id: 'route-hit', type: 'line', source: 'route', paint: { 'line-width': 28, 'line-opacity': 0 } });
  // A local sprite keeps direction arrows available without a remote font or sprite.
  if (!map.hasImage('route-arrow')) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.strokeStyle = '#f9ffdd'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(11, 25); ctx.lineTo(20, 15); ctx.lineTo(29, 25); ctx.stroke();
      map.addImage('route-arrow', ctx.getImageData(0, 0, 40, 40));
    }
  }
  map.addLayer({ id: 'route-directions', type: 'symbol', source: 'directions', layout: {
    'icon-image': 'route-arrow', 'icon-size': 0.55, 'icon-rotate': ['get', 'bearing'],
    'icon-rotation-alignment': 'map', 'icon-allow-overlap': true,
  } });
  map.addLayer({ id: 'station-hit', type: 'circle', source: 'stations', paint: { 'circle-radius': 20, 'circle-opacity': 0 } });
  map.addLayer({ id: 'station-rings', type: 'circle', source: 'stations', paint: {
    'circle-radius': ['case', ['get', 'selected'], 12, 9], 'circle-color': '#fffdf5',
    'circle-stroke-width': ['case', ['get', 'selected'], 3, 2],
    'circle-stroke-color': ['case', ['get', 'selected'], '#789333', '#355b45'],
  } });
  map.addLayer({ id: 'station-dots', type: 'circle', source: 'stations', paint: {
    'circle-radius': ['case', ['get', 'selected'], 6, 4],
    'circle-color': ['case', ['get', 'selected'], '#badb6e', '#355b45'],
  } });
  map.addLayer({ id: 'cursor-glow', type: 'circle', source: 'cursor', paint: { 'circle-radius': 17, 'circle-color': '#cae48b', 'circle-opacity': 0.36 } });
  map.addLayer({ id: 'cursor-dot', type: 'circle', source: 'cursor', paint: {
    'circle-radius': 7, 'circle-color': '#d3ed99', 'circle-stroke-width': 3, 'circle-stroke-color': '#355b45',
  } });
}

function updateRoute(map: MapLibreMap, reference: ReferenceRoute | null, coordinates: Coordinate[]) {
  source(map, 'route')?.setData(reference && coordinates.length > 1 ? {
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates },
  } : emptyCollection);
  const features = reference && reference.totalM > 0 ? Array.from({ length: 8 }, (_, i) => {
    const s = reference.totalM * ((i + 0.5) / 8);
    const a = positionAt(reference, coordinates, s);
    const b = positionAt(reference, coordinates, Math.min(reference.totalM, s + Math.max(5, reference.totalM / 800)));
    const bearing = Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI;
    return { type: 'Feature' as const, properties: { bearing }, geometry: { type: 'Point' as const, coordinates: a } };
  }) : [];
  source(map, 'directions')?.setData({ type: 'FeatureCollection', features });
}

function updateStations(map: MapLibreMap, props: Props, coordinates: Coordinate[]) {
  source(map, 'stations')?.setData({ type: 'FeatureCollection', features: props.stations.map((station) => ({
    type: 'Feature', properties: { id: station.id, selected: station.id === props.selectedStationId },
    geometry: { type: 'Point', coordinates: props.reference ? positionAt(props.reference, coordinates, station.s) : [station.lon, station.lat] },
  })) });
}

function updateCursor(map: MapLibreMap, props: Props, coordinates: Coordinate[]) {
  source(map, 'cursor')?.setData(props.reference && props.cursorS !== null ? {
    type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: positionAt(props.reference, coordinates, props.cursorS) },
  } : emptyCollection);
}

function fitRoute(map: MapLibreMap, coordinates: Coordinate[]) {
  if (!coordinates.length) return;
  let west = Infinity; let east = -Infinity; let south = Infinity; let north = -Infinity;
  for (const [x, y] of coordinates) { west = Math.min(west, x); east = Math.max(east, x); south = Math.min(south, y); north = Math.max(north, y); }
  map.fitBounds([[west, south], [east, north]], { padding: { top: 64, bottom: 64, left: 48, right: 64 }, maxZoom: 16, duration: 450 });
}

export default function RouteMap(props: Props) {
  const { reference, stations, selectedStationId, cursorS, language, basemap } = props;
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const coordinates = useMemo(() => unwrap(reference), [reference]);
  const coordinatesRef = useRef(coordinates);
  coordinatesRef.current = coordinates;
  const [unavailable, setUnavailable] = useState(false);
  const [noWebGL, setNoWebGL] = useState(false);
  const [ready, setReady] = useState(false);
  const remoteActive = useRef(false);
  const styleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const zh = language === 'zh';

  useEffect(() => {
    if (!host.current) return;
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({ container: host.current, style: blankStyle(), center: [15, 25], zoom: 1.5,
        attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, renderWorldCopies: true });
    } catch {
      setNoWebGL(true);
      return;
    }
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.on('style.load', () => {
      clearTimeout(styleTimer.current);
      addLayers(map);
      updateRoute(map, propsRef.current.reference, coordinatesRef.current);
      updateStations(map, propsRef.current, coordinatesRef.current);
      updateCursor(map, propsRef.current, coordinatesRef.current);
      setReady(true);
    });
    map.on('error', () => {
      if (!remoteActive.current) return;
      remoteActive.current = false;
      clearTimeout(styleTimer.current);
      setUnavailable(true);
      map.setStyle(blankStyle());
    });
    map.on('click', (event) => {
      if (!map.getLayer('station-hit')) return;
      const hits = map.queryRenderedFeatures(event.point, { layers: ['station-hit', 'route-hit'] });
      const station = hits.find((feature) => feature.layer.id === 'station-hit');
      if (station) { propsRef.current.onStationSelect(Number(station.properties.id)); return; }
      const current = propsRef.current.reference;
      if (!hits.length || !current) return;
      let nearest = Infinity;
      let s = 0;
      const coords = coordinatesRef.current;
      for (let i = 1; i < coords.length; i++) {
        const a = map.project(coords[i - 1]); const b = map.project(coords[i]);
        const dx = b.x - a.x; const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((event.point.x - a.x) * dx + (event.point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        const distance = Math.hypot(event.point.x - a.x - t * dx, event.point.y - a.y - t * dy);
        if (distance < nearest) { nearest = distance; s = current.points[i - 1].s + t * (current.points[i].s - current.points[i - 1].s); }
      }
      propsRef.current.onCursorChange(s);
      propsRef.current.onRouteClick?.(s);
    });
    map.on('mousemove', (event) => {
      if (!map.getLayer('route-hit')) return;
      map.getCanvas().style.cursor = map.queryRenderedFeatures(event.point, { layers: ['station-hit', 'route-hit'] }).length ? 'pointer' : '';
    });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(host.current);
    return () => { clearTimeout(styleTimer.current); observer.disconnect(); map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    remoteActive.current = basemap;
    setUnavailable(false);
    clearTimeout(styleTimer.current);
    if (basemap) {
      map.setStyle(BASE_STYLE);
      styleTimer.current = setTimeout(() => {
        if (!remoteActive.current) return;
        remoteActive.current = false; setUnavailable(true); map.setStyle(blankStyle());
      }, 12000);
    } else map.setStyle(blankStyle());
  }, [basemap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.getSource('route')) updateRoute(map, reference, coordinates);
    if (coordinates.length) fitRoute(map, coordinates);
  }, [reference, coordinates, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getSource('stations')) updateStations(map, propsRef.current, coordinates);
  }, [reference, coordinates, stations, selectedStationId, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getSource('cursor')) updateCursor(map, propsRef.current, coordinates);
  }, [reference, coordinates, cursorS, ready]);

  return <div className={`route-map ${!basemap || unavailable || noWebGL ? 'route-map--plain' : ''}`}>
    <div className="route-map__canvas" ref={host} role="region" aria-label={zh ? '交互式路线地图' : 'Interactive route map'} />
    {noWebGL && <RouteSketch {...props} coordinates={coordinates} />}
    <div className="route-map__north" aria-hidden="true"><span>N</span><svg viewBox="0 0 20 24"><path d="M10 1 17 21 10 16 3 21Z" /></svg></div>
    {!noWebGL && <div className="route-map__controls" aria-label={zh ? '地图控制' : 'Map controls'}>
      <button type="button" onClick={() => mapRef.current?.zoomIn()} aria-label={zh ? '放大' : 'Zoom in'} title={zh ? '放大' : 'Zoom in'}>+</button>
      <button type="button" onClick={() => mapRef.current?.zoomOut()} aria-label={zh ? '缩小' : 'Zoom out'} title={zh ? '缩小' : 'Zoom out'}>−</button>
      <button type="button" onClick={() => mapRef.current && fitRoute(mapRef.current, coordinates)} disabled={!reference} aria-label={zh ? '显示完整路线' : 'Fit entire route'} title={zh ? '显示完整路线' : 'Fit entire route'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/><circle cx="12" cy="12" r="3" /></svg></button>
    </div>}
    {reference && <div className="route-map__legend"><span className="route-map__legend-line" />{(reference.totalM / 1000).toFixed(1)} km<span className="route-map__legend-divider" />{stations.length} {zh ? '站点' : 'stations'}</div>}
    {(unavailable || noWebGL) && <div className="route-map__status" role="status">{zh ? '简洁地图 · 路线仍可编辑' : 'Simple map · route editing available'}</div>}
  </div>;
}

/** An interactive route sketch also works when a browser cannot create WebGL. */
function RouteSketch(props: Props & { coordinates: Coordinate[] }) {
  const { reference, coordinates, stations, selectedStationId, cursorS, onStationSelect } = props;
  if (!reference || !coordinates.length) return null;
  const middleLat = coordinates.reduce((sum, p) => sum + p[1], 0) / coordinates.length;
  const scaleX = Math.cos(middleLat * Math.PI / 180);
  const xs = coordinates.map((p) => p[0] * scaleX);
  const ys = coordinates.map((p) => -p[1]);
  const minX = xs.reduce((a, b) => Math.min(a, b), Infinity); const maxX = xs.reduce((a, b) => Math.max(a, b), -Infinity);
  const minY = ys.reduce((a, b) => Math.min(a, b), Infinity); const maxY = ys.reduce((a, b) => Math.max(a, b), -Infinity);
  const scale = Math.min(700 / (maxX - minX || 1), 380 / (maxY - minY || 1));
  const xy = (p: Coordinate): Coordinate => [400 + (p[0] * scaleX - (minX + maxX) / 2) * scale, 250 + (-p[1] - (minY + maxY) / 2) * scale];
  const screenPoints = coordinates.map(xy);
  const line = screenPoints.map((p) => p.join(',')).join(' ');
  const cursor = cursorS === null ? null : xy(positionAt(reference, coordinates, cursorS));
  return <svg className="route-map__sketch" viewBox="0 0 800 500" aria-label={props.language === 'zh' ? '路线预览' : 'Route preview'}>
    <polyline points={line} fill="none" stroke="#fffdf5" strokeWidth="10" strokeLinejoin="round" />
    <polyline points={line} fill="none" stroke="#355b45" strokeWidth="4" strokeLinejoin="round" />
    <polyline points={line} fill="none" stroke="transparent" strokeWidth="28" className="route-map__sketch-hit" onClick={(event) => {
      const svg = event.currentTarget.ownerSVGElement;
      if (!svg) return;
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      let nearest = Infinity; let distanceS = 0;
      for (let i = 1; i < screenPoints.length; i++) {
        const a = screenPoints[i - 1]; const b = screenPoints[i];
        const dx = b[0] - a[0]; const dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(point.x - a[0] - t * dx, point.y - a[1] - t * dy);
        if (d < nearest) { nearest = d; distanceS = reference.points[i - 1].s + t * (reference.points[i].s - reference.points[i - 1].s); }
      }
      props.onCursorChange(distanceS); props.onRouteClick?.(distanceS);
    }} />
    {stations.map((station) => {
      const [x, y] = xy(positionAt(reference, coordinates, station.s));
      return <g key={station.id} role="button" tabIndex={0} aria-label={station.name} className="route-map__sketch-station" onClick={() => onStationSelect(station.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onStationSelect(station.id); } }}>
        <circle cx={x} cy={y} r="20" fill="transparent" /><circle cx={x} cy={y} r="8" fill={station.id === selectedStationId ? '#d3ed99' : '#fffdf5'} stroke="#355b45" strokeWidth="3" />
      </g>;
    })}
    {cursor && <circle cx={cursor[0]} cy={cursor[1]} r="7" fill="#d3ed99" stroke="#355b45" strokeWidth="3" pointerEvents="none" />}
  </svg>;
}
