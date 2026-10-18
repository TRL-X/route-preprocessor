import type { ProcessingOptions } from './types';

export const PROCESSING_DEFAULTS: Readonly<ProcessingOptions> = Object.freeze({
  geometryToleranceM: 2,
  elevationIntervalM: 10,
  smoothingWindowM: 0,
  elevationMode: 'source',
  acceptUncertainElevation: false,
});

export const PROCESSING_RANGES = Object.freeze({
  geometryToleranceM: { min: 0, max: 1000 },
  elevationIntervalM: { min: 0.1, max: 1000 },
  smoothingWindowM: { min: 0, max: 10_000 },
} as const);

export const PROCESSING_CHOICES = Object.freeze({
  elevationIntervalM: [5, 10, 20, 50],
  smoothingWindowM: [0, 10, 30, 50],
} as const);

// Keep the common geometry control narrower than the accepted processing range.
export const PROCESSING_CONTROLS = Object.freeze({
  geometryToleranceM: { min: 1, max: 5, step: 0.5 },
} as const);

/** Browser budgets, separate from the RTE format and reader limits. */
export const IMPORT_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxPoints: 200_000,
  maxRoutes: 256,
  maxLandmarks: 4096,
  maxXmlDepth: 64,
  maxXmlElements: 1_500_000,
});

export const PROCESSING_LIMITS = Object.freeze({
  maxGeometryNodes: 400_000,
  maxElevationNodes: 200_000,
  maxMatchCandidates: 32,
  maxGeometryEdgeM: 250,
  elevationGapWarningM: 100,
  sourceEdgeWarningM: 1000,
  minRouteLengthM: 0.1,
});
