/** Internal units are explicit: source/reference use meters, encoded records use dm/E7. */
export type StationKind = 0 | 1 | 2 | 3 | 4;
export type VerticalDatum = 0 | 1 | 2 | 3;
export interface SourcePoint { lat: number; lon: number; elevation: number | null }
export interface SourceRoute {
  id: string; name: string; points: SourcePoint[];
  elevationDatum: VerticalDatum; elevationUncertain: boolean;
}
export interface SourceLandmark { id: string; name: string; lat: number; lon: number }
export interface ImportedFile {
  fileName: string; format: 'gpx' | 'kml'; routes: SourceRoute[];
  landmarks: SourceLandmark[]; warnings: DiagnosticMessage[];
}
export interface DiagnosticMessage {
  code: string; params?: Record<string, string | number>; message?: string;
}
export interface ProcessingIssue extends DiagnosticMessage {
  severity: 'warning' | 'error'; s?: number;
}
export interface ReferencePoint extends SourcePoint { s: number; sourceIndex?: number }
export interface ReferenceRoute {
  points: ReferencePoint[]; totalM: number; isClosed: boolean;
  elevationDatum: VerticalDatum; elevationUncertain: boolean;
  issues: ProcessingIssue[];
}
export interface MatchCandidate { s: number; distanceM: number; lat: number; lon: number }
export interface DraftStation {
  id: number; name: string; shortLabel: string; kind: StationKind;
  stageBoundary: boolean; s: number; lat: number; lon: number;
  confirmed: boolean; candidates: MatchCandidate[];
}
export interface GeomNode { latE7: number; lonE7: number; sDm: number }
export interface ElevNode { sDm: number; hDm: number; upDm: number; downDm: number }
export interface StationEvent {
  eventId: number; name: string; shortLabel: string; kind: StationKind;
  stageBoundary: boolean; sDm: number; actualLatE7: number; actualLonE7: number;
}
export interface Stage { fromEventId: number; toEventId: number; minHDm?: number; maxHDm?: number }
export interface ElevationInfo {
  source: 0 | 1 | 2 | 3 | 4; verticalDatum: VerticalDatum; quality: 0 | 1 | 2;
  sourceDetail?: string; datumName?: string; containsFilledValues?: boolean;
}
export interface MagneticDeclinationInfo {
  declinationCdeg: number; referenceLatE7: number; referenceLonE7: number;
  referenceDate: string; source: string; referenceHeightDm?: number;
  validFrom?: string; validUntil?: string;
}
export interface PreprocessingInfo {
  tool: string; toolVersion: string; recipeId: string; inputSha256?: Uint8Array;
  parameters?: { geometryToleranceDm?: number; elevationGridDm?: number; elevationSmoothingWindowDm?: number };
}
export interface RouteData {
  routeId: Uint8Array; revision: number; name: string; routeKind: 0 | 1; totalSDm: number;
  geom: GeomNode[]; elev?: ElevNode[]; elevationInfo?: ElevationInfo;
  magneticDeclination?: MagneticDeclinationInfo;
  stations: StationEvent[]; stages?: Stage[]; preprocessing: PreprocessingInfo;
}
export interface ProcessingOptions {
  geometryToleranceM: number; elevationIntervalM: number; smoothingWindowM: number;
  elevationMode: 'omit' | 'source' | 'interpolate'; acceptUncertainElevation: boolean;
}
export interface RouteIdentity { magneticDeclination?: MagneticDeclinationInfo; routeId: Uint8Array; revision: number; name: string; inputSha256?: Uint8Array }
export interface ProcessingResult { route: RouteData | null; issues: ProcessingIssue[] }
export interface ProfileValue { hDm: number; upDm: number; downDm: number }
