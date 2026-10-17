import { IMPORT_LIMITS, PROCESSING_LIMITS, PROCESSING_RANGES } from '../core/policy';

/** Shared limits used in help text and diagnostics. */
export const POLICY_MESSAGE_PARAMS = {
  importMaxMiB: IMPORT_LIMITS.maxBytes / (1024 * 1024),
  geometryMinM: PROCESSING_RANGES.geometryToleranceM.min,
  geometryMaxM: PROCESSING_RANGES.geometryToleranceM.max,
  elevationIntervalMinM: PROCESSING_RANGES.elevationIntervalM.min,
  elevationIntervalMaxM: PROCESSING_RANGES.elevationIntervalM.max,
  smoothingMinM: PROCESSING_RANGES.smoothingWindowM.min,
  smoothingMaxM: PROCESSING_RANGES.smoothingWindowM.max,
  profileNodeLimit: PROCESSING_LIMITS.maxElevationNodes,
  elevationGapWarningM: PROCESSING_LIMITS.elevationGapWarningM,
};
