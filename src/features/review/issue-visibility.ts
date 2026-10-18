import { issueStage, type Step } from '../../app/flow';
import type { ProcessingIssue, ProcessingOptions } from '../../core/types';

const automaticResults = new Set([
  'DUPLICATE_COORDINATES',
  'GEOMETRY_QUANTIZATION_MERGE',
  'ELEVATION_FILLED',
  // The settings show missing values; INCOMPLETE_ELEVATION blocks their export.
  'ELEVATION_CONFLICT',
  'ELEVATION_MISSING',
  // Segment selection already lists the available segments.
  'IMPORT_MULTIPLE_SEGMENTS',
]);
/** Presentation filtering only. Validation and reports always use every issue. */
export function issuesForStep(
  issues: readonly ProcessingIssue[],
  step: Step,
  options: ProcessingOptions,
): ProcessingIssue[] {
  return issues.filter((issue) => {
    if (automaticResults.has(issue.code) && issue.severity !== 'error') return false;
    // Final review and export show only problems that still block the output.
    if (step === 'preview' || step === 'export') return issue.severity === 'error';
    const owner = issueStage(issue, options);
    if (owner !== 'all' && owner !== step) return false;
    if (owner === 'all') return issue.severity === 'error';
    if (issue.code === 'IMPORT_KML_ELEVATION') {
      return (
        !options.acceptUncertainElevation &&
        !issues.some((item) => item.code === 'ELEVATION_UNCONFIRMED')
      );
    }
    return true;
  });
}
