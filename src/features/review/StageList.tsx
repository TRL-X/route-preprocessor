import { ArrowRight } from 'lucide-react';
import { queryElevation } from '../../core/rte';
import type { DraftStation, RouteData } from '../../core/types';

type StageStation = Pick<DraftStation, 'id' | 'name' | 'shortLabel' | 's' | 'stageBoundary'>;
type StageProfile = Pick<RouteData, 'elev' | 'stations'>;

export interface StageListProps {
  /** Stations in along-route order. */
  stations: readonly StageStation[];
  route: StageProfile | null;
  language: 'en' | 'zh';
  onSelectDistance: (distanceM: number) => void;
}

const km = (meters: number) => (meters / 1000).toLocaleString('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function stageClimb(route: StageProfile | null, fromId: number, toId: number) {
  if (!route?.elev) return null;
  const from = route.stations.find(station => station.eventId === fromId);
  const to = route.stations.find(station => station.eventId === toId);
  if (!from || !to) return null;
  const a = queryElevation(route.elev, from.sDm);
  const b = queryElevation(route.elev, to.sDm);
  return {
    up: Math.round((b.upDm - a.upDm) / 10),
    down: Math.round((b.downDm - a.downDm) / 10),
  };
}

export default function StageList({ stations, route, language, onSelectDistance }: StageListProps) {
  const boundaries = stations.filter(station => station.stageBoundary);
  return <>
    <div className="section-label">{language === 'zh' ? '阶段' : 'STAGES'}</div>
    {boundaries.slice(0, -1).map((from, index) => {
      const to = boundaries[index + 1];
      const climb = stageClimb(route, from.id, to.id);
      return <button key={from.id} className="stage-row" onClick={() => onSelectDistance(from.s)}>
        <span>
          <strong>{from.shortLabel} <ArrowRight size={12} /> {to.shortLabel}</strong>
          <small>{from.name} → {to.name}</small>
          {climb && <small className="stage-climb">
            ↗ {climb.up.toLocaleString()} m <span>↘ {climb.down.toLocaleString()} m</span>
          </small>}
        </span>
        <b>{km(to.s - from.s)}<small> km</small></b>
      </button>;
    })}
  </>;
}
