import { useLocale } from '../i18n/useLocale';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { DraftStation, ReferenceRoute, RouteData } from '../core/types';
import './components.css';

interface Props {
  reference: ReferenceRoute | null;
  route: RouteData | null;
  stations: DraftStation[];
  cursorS: number | null;
  onCursorChange: (s: number) => void;
  onStationSelect: (id: number) => void;
  compareSource?: boolean;
}
interface ProfilePoint { s: number; h: number | null }
const HEIGHT = 180;
const LEFT = 50;
const RIGHT = 16;
const TOP = 16;
const BOTTOM = 30;

// Preserve each gap and each bucket's extremes. This only reduces drawing work;
// totals and the cursor are always computed from the complete profile.
function displaySegments(points: ProfilePoint[]): ProfilePoint[][] {
  const segments: ProfilePoint[][] = [];
  let segment: ProfilePoint[] = [];
  const flush = () => {
    if (segment.length) {
      if (segment.length <= 1200) segments.push(segment);
      else {
        const result = [segment[0]];
        const bucketSize = Math.ceil(segment.length / 600);
        for (let start = 1; start < segment.length - 1; start += bucketSize) {
          const end = Math.min(segment.length - 1, start + bucketSize);
          let low = start; let high = start;
          for (let i = start + 1; i < end; i++) {
            if (segment[i].h! < segment[low].h!) low = i;
            if (segment[i].h! > segment[high].h!) high = i;
          }
          for (const i of low === high ? [low] : [Math.min(low, high), Math.max(low, high)]) result.push(segment[i]);
        }
        result.push(segment[segment.length - 1]);
        segments.push(result);
      }
    }
    segment = [];
  };
  for (const point of points) { if (point.h === null) flush(); else segment.push(point); }
  flush();
  return segments;
}

function heightAt(points: ProfilePoint[], s: number): number | null {
  let lo = 0; let hi = points.length - 1;
  if (hi < 0) return null;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (points[mid].s < s) lo = mid + 1; else hi = mid; }
  const b = points[lo]; const a = points[Math.max(0, lo - 1)];
  if (Math.abs(b.s - s) < 0.001) return b.h;
  if (a.h === null || b.h === null) return null;
  const t = Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s || 1)));
  return a.h + (b.h - a.h) * t;
}

export default function ElevationChart({ reference, route, stations, cursorS, onCursorChange, onStationSelect, compareSource = false }: Props) {
  const { t, km, number } = useLocale();
  const uid = useId().replace(/:/g, '');
  const containerRef = useRef<HTMLElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(700);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const css = getComputedStyle(container);
      setWidth(Math.max(250, container.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const processed = !!route?.elev?.length;
  const sourcePoints = useMemo<ProfilePoint[]>(() => (reference?.points ?? []).map((p) => ({ s: p.s, h: p.elevation })), [reference]);
  const points = useMemo<ProfilePoint[]>(() => processed
    ? route!.elev!.map((p) => ({ s: p.sDm / 10, h: p.hDm / 10 }))
    : sourcePoints, [sourcePoints, route, processed]);
  const sourceSegments = useMemo(() => processed && compareSource ? displaySegments(sourcePoints) : [], [sourcePoints, processed, compareSource]);
  const profile = useMemo(() => {
    let min = Infinity; let max = -Infinity; let count = 0;
    for (const p of points) if (p.h !== null) { min = Math.min(min, p.h); max = Math.max(max, p.h); count++; }
    let axisMin = min; let axisMax = max;
    for (const segment of sourceSegments) for (const p of segment) if (p.h !== null) { axisMin = Math.min(axisMin, p.h); axisMax = Math.max(axisMax, p.h); }
    const padding = Math.max(5, (axisMax - axisMin) * 0.15);
    return { min, max, axisMin, axisMax, count, low: axisMin - padding, high: axisMax + padding, segments: displaySegments(points) };
  }, [points, sourceSegments]);
  const total = route ? route.totalSDm / 10 : reference?.totalM ?? 0;
  const currentS = Math.max(0, Math.min(total, cursorS ?? 0));
  const currentH = heightAt(points, currentS);
  const x = (s: number) => LEFT + s / (total || 1) * (width - LEFT - RIGHT);
  const y = (h: number) => TOP + (profile.high - h) / (profile.high - profile.low || 1) * (HEIGHT - TOP - BOTTOM);
  const base = HEIGHT - BOTTOM;
  const distanceLabel = `${km(currentS)} km`;
  const heightLabel = currentH === null ? (t('profile.noElevation')) : `${number(Math.round(currentH))} m`;
  const label = t('profile.routeProgress');
  const valueText = `${distanceLabel}, ${heightLabel}`;
  const changeFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    onCursorChange(Math.max(0, Math.min(total, (point.x - LEFT) / (width - LEFT - RIGHT) * total)));
  };

  return <section ref={containerRef} className="elevation-chart" aria-label={t('profile.elevationProfile')}>
    <div className="elevation-chart__heading">
      <div className="elevation-chart__title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m3 18 6-10 4 6 3-4 5 8H3Z" /></svg><h3>{t('profile.elevationProfile')}</h3>{profile.count > 0 && <span className="elevation-chart__badge">{processed ? (t('profile.exportData')) : (t('profile.sourceElevation'))}</span>}</div>
      {reference && <div className="elevation-chart__readout"><strong>{distanceLabel}</strong><span>{heightLabel}</span></div>}
    </div>
    {profile.count > 0 ? <>
      <svg ref={svgRef} className="elevation-chart__svg" viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true"
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); changeFromPointer(event); }}
        onPointerMove={(event) => { if (event.pointerType === 'mouse' || event.buttons) changeFromPointer(event); }}>
        <defs><linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#91ae6f" stopOpacity="0.45"/><stop offset="100%" stopColor="#c6d8ad" stopOpacity="0.10"/></linearGradient></defs>
        {(profile.axisMin === profile.axisMax ? [0] : [0, 0.5, 1]).map((fraction) => {
          const h = profile.axisMin + (profile.axisMax - profile.axisMin) * fraction;
          return <g key={fraction}><line x1={LEFT} y1={y(h)} x2={width - RIGHT} y2={y(h)} stroke="#e1e4d9" strokeDasharray="3 5"/><text x={LEFT - 10} y={y(h) + 4} textAnchor="end" className="elevation-chart__axis">{number(Math.round(h))}</text></g>;
        })}
        {profile.segments.map((segment, i) => {
          const line = segment.map((p, j) => `${j === 0 ? 'M' : 'L'}${x(p.s).toFixed(2)},${y(p.h!).toFixed(2)}`).join(' ');
          return <g key={i}>
            <path d={`${line} L${x(segment.at(-1)!.s)},${base} L${x(segment[0].s)},${base} Z`} fill={`url(#${uid}-fill)`}/>
            <path d={line} fill="none" stroke="#557749" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
            {segment.length === 1 && <circle cx={x(segment[0].s)} cy={y(segment[0].h!)} r="2.5" fill="#557749"/>}
          </g>;
        })}
        {sourceSegments.map((segment, i) => <path key={`source-${i}`} className="elevation-chart__source-line" d={segment.map((p, j) => `${j === 0 ? 'M' : 'L'}${x(p.s).toFixed(2)},${y(p.h!).toFixed(2)}`).join(' ')} fill="none" stroke="#929b8b" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke"/>)}
        {stations.map((station) => <g key={station.id} className="elevation-chart__station" onPointerDown={(event) => event.stopPropagation()} onPointerMove={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onStationSelect(station.id); }}>
          <line x1={x(station.s)} y1={TOP} x2={x(station.s)} y2={base} stroke="#a8b89c" strokeDasharray="2 4"/>
          <circle cx={x(station.s)} cy={base} r="22" fill="transparent"/><circle cx={x(station.s)} cy={base} r="4" fill="#fffdf5" stroke="#557749" strokeWidth="2"/>
        </g>)}
        <line x1={x(currentS)} y1={TOP} x2={x(currentS)} y2={base} stroke="#355b45" strokeWidth="1.3" strokeDasharray="4 3" vectorEffect="non-scaling-stroke"/>
        {currentH !== null && <circle cx={x(currentS)} cy={y(currentH)} r="4.5" fill="#d3ed99" stroke="#355b45" strokeWidth="2" vectorEffect="non-scaling-stroke"/>}
        {(width < 400 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((fraction) => <text key={fraction} x={x(total * fraction)} y={HEIGHT - 7} textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'} className="elevation-chart__axis">{number(total * fraction / 1000, { minimumFractionDigits: total < 10000 ? 1 : 0, maximumFractionDigits: total < 10000 ? 1 : 0 })} km</text>)}
      </svg>
      {sourceSegments.length > 0 && <div className="elevation-chart__comparison-legend"><span><i/>{t('profile.exportElevation')}</span><span><i/>{t('profile.sourceElevation')}</span></div>}
      <div className="elevation-chart__footer"><span>{t('profile.elevationRange', { min: number(Math.round(profile.min)), max: number(Math.round(profile.max)) })}</span><span>{t('profile.slideAlongTheProfileToExplore')}</span></div>
    </> : <div className="elevation-chart__empty"><span className="elevation-chart__empty-line"/>{reference ? (t('profile.noElevationAvailableYouCanStillExploreRoute')) : (t('profile.importARouteToDiscoverItsUpsAnd'))}</div>}
    {reference && <div className="elevation-chart__slider-row"><label htmlFor={`${uid}-progress`}>{label}</label><input id={`${uid}-progress`} type="range" min="0" max={Math.max(1, total)} step="1" value={currentS} onChange={(event) => onCursorChange(Number(event.target.value))} aria-valuetext={valueText}/></div>}
  </section>;
}
