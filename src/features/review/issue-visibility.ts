import type { Step } from '../../app/flow';
import type { ProcessingIssue, ProcessingOptions } from '../../core/types';

const automaticResults = new Set([
  'DUPLICATE_COORDINATES', 'GEOMETRY_QUANTIZATION_MERGE', 'ELEVATION_FILLED',
  // Missing elevation already has a count beside the elevation settings. Conflicts
  // become missing values; exporting them is covered by INCOMPLETE_ELEVATION.
  'ELEVATION_CONFLICT', 'ELEVATION_MISSING',
  // Segment selection already lists the available segments.
  'IMPORT_MULTIPLE_SEGMENTS',
]);
const routeIssues = new Set([
  'MAGNETIC_DECLINATION_INVALID', 'ROUTE_TOO_SHORT', 'ROUTE_NAME_INVALID', 'DISTANCE_RANGE',
  'LARGE_SOURCE_EDGE', 'GEOMETRY_RESOURCE_LIMIT', 'IMPORT_SHORT_SEGMENT',
]);

export function issueStage(issue: ProcessingIssue, options?: ProcessingOptions): Step | 'all' {
  if (/^(STATION_|EVENT_|ENDPOINT_|BOUNDARY_)/.test(issue.code) || issue.code === 'GEOMETRY_QUANTIZATION_COLLISION') return 'stations';
  if (/^(ELEVATION_|INCOMPLETE_ELEVATION|PROFILE_)/.test(issue.code) || issue.code === 'IMPORT_KML_ELEVATION') return 'elevation';
  if (issue.code === 'OPTIONS_INVALID') {
    return options && Number.isFinite(options.geometryToleranceM) && options.geometryToleranceM >= 0 && options.geometryToleranceM <= 1000 ? 'elevation' : 'route';
  }
  return routeIssues.has(issue.code) ? 'route' : 'all';
}

/** Presentation filtering only. Validation and reports always use every issue. */
export function issuesForStep(issues: readonly ProcessingIssue[], step: Step, options: ProcessingOptions): ProcessingIssue[] {
  return issues.filter(issue => {
    if (automaticResults.has(issue.code) && issue.severity !== 'error') return false;
    // Final review and export show only problems that still block the output.
    if (step === 'preview' || step === 'export') return issue.severity === 'error';
    const owner = issueStage(issue, options);
    if (owner !== 'all' && owner !== step) return false;
    if (owner === 'all') return issue.severity === 'error';
    if (owner === 'elevation') {
      if (options.elevationMode === 'omit' && issue.code !== 'OPTIONS_INVALID') return false;
      if (issue.code === 'IMPORT_KML_ELEVATION') {
        return !options.acceptUncertainElevation && !issues.some(item => item.code === 'ELEVATION_UNCONFIRMED');
      }
    }
    return true;
  });
}
