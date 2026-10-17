import { describe, expect, it } from 'vitest';
import { issuesForStep } from '../../src/features/review/issue-visibility';
import type { ProcessingIssue, ProcessingOptions } from '../../src/core/types';

const options: ProcessingOptions = { geometryToleranceM: 2, elevationIntervalM: 10, smoothingWindowM: 0, elevationMode: 'source', acceptUncertainElevation: false };
const warning = (code: string): ProcessingIssue => ({ code, severity: 'warning' });
const error = (code: string): ProcessingIssue => ({ code, severity: 'error' });
const codes = (issues: ProcessingIssue[]) => issues.map(issue => issue.code);

describe('stage-specific user diagnostics', () => {
  const issues = [warning('DUPLICATE_COORDINATES'), warning('GEOMETRY_QUANTIZATION_MERGE'), warning('ELEVATION_FILLED'), warning('ELEVATION_MISSING'), warning('ELEVATION_CONFLICT'), warning('LARGE_SOURCE_EDGE'), error('ROUTE_NAME_INVALID'), error('STATION_UNCONFIRMED'), error('INCOMPLETE_ELEVATION')];
  it('keeps automatic cleanup in the report, with only relevant actions on each page', () => {
    expect(codes(issuesForStep(issues, 'route', options))).toEqual(['LARGE_SOURCE_EDGE', 'ROUTE_NAME_INVALID']);
    expect(codes(issuesForStep(issues, 'stations', options))).toEqual(['STATION_UNCONFIRMED']);
    expect(codes(issuesForStep(issues, 'elevation', options))).toEqual(['INCOMPLETE_ELEVATION']);
    expect(issues).toHaveLength(9);
  });
  it('shows only remaining blockers during final review and export', () => {
    for (const step of ['preview', 'export'] as const) {
      expect(codes(issuesForStep(issues, step, options))).toEqual(['ROUTE_NAME_INVALID', 'STATION_UNCONFIRMED', 'INCOMPLETE_ELEVATION']);
    }
  });
  it('shows required elevation warnings and avoids duplicate KML confirmation messages', () => {
    const imported = [warning('IMPORT_SHORT_SEGMENT'), warning('IMPORT_MULTIPLE_SEGMENTS'), warning('IMPORT_KML_ELEVATION')];
    expect(codes(issuesForStep(imported, 'route', options))).toEqual(['IMPORT_SHORT_SEGMENT']);
    expect(codes(issuesForStep(imported, 'elevation', options))).toEqual(['IMPORT_KML_ELEVATION']);
    expect(codes(issuesForStep([...imported, error('ELEVATION_UNCONFIRMED')], 'elevation', options))).toEqual(['ELEVATION_UNCONFIRMED']);
    expect(issuesForStep(imported, 'elevation', { ...options, acceptUncertainElevation: true })).toEqual([]);
  });
  it('shows long elevation gap warnings without adding export blockers', () => {
    const issues = [warning('ELEVATION_LARGE_GAP')];
    expect(codes(issuesForStep(issues, 'elevation', { ...options, elevationMode: 'interpolate' }))).toEqual(['ELEVATION_LARGE_GAP']);
    expect(issuesForStep(issues, 'export', options)).toEqual([]);
  });
  it('keeps unexpected blocking failures visible and puts invalid parameters on the editable step', () => {
    expect(codes(issuesForStep([error('processing'), error('FUTURE_ERROR')], 'stations', options))).toEqual(['processing', 'FUTURE_ERROR']);
    expect(codes(issuesForStep([error('OPTIONS_INVALID')], 'route', { ...options, geometryToleranceM: NaN }))).toEqual(['OPTIONS_INVALID']);
    expect(codes(issuesForStep([error('OPTIONS_INVALID')], 'elevation', { ...options, elevationIntervalM: NaN }))).toEqual(['OPTIONS_INVALID']);
  });
});
