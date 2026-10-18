import { PROCESSING_RANGES } from '../core/policy';
import type { ProcessingIssue, ProcessingOptions } from '../core/types';
import type { Editor } from './editor';

export const STEPS = ['import', 'route', 'stations', 'elevation', 'preview', 'export'] as const;
export type Step = (typeof STEPS)[number];

export interface WorkflowState {
  step: Step;
  unlockedStep: number;
  confirmedRoute: boolean;
}

export const INITIAL_WORKFLOW: WorkflowState = {
  step: 'import',
  unlockedStep: 1,
  confirmedRoute: false,
};

export type StepCompletion = Record<Step, boolean>;
export type ContinueBlocker = 'busy' | 'processing' | 'routeConfirmation' | Step;

const routeIssues = new Set([
  'MAGNETIC_DECLINATION_INVALID',
  'ROUTE_TOO_SHORT',
  'ROUTE_NAME_INVALID',
  'DISTANCE_RANGE',
  'LARGE_SOURCE_EDGE',
  'GEOMETRY_RESOURCE_LIMIT',
  'IMPORT_SHORT_SEGMENT',
]);

export function issueStage(issue: ProcessingIssue, options?: ProcessingOptions): Step | 'all' {
  if (
    /^(STATION_|EVENT_|ENDPOINT_|BOUNDARY_)/.test(issue.code) ||
    issue.code === 'GEOMETRY_QUANTIZATION_COLLISION'
  )
    return 'stations';
  if (
    /^(ELEVATION_|INCOMPLETE_ELEVATION|PROFILE_)/.test(issue.code) ||
    issue.code === 'IMPORT_KML_ELEVATION'
  )
    return 'elevation';
  if (issue.code === 'OPTIONS_INVALID') {
    const { min, max } = PROCESSING_RANGES.geometryToleranceM;
    return options &&
      Number.isFinite(options.geometryToleranceM) &&
      options.geometryToleranceM >= min &&
      options.geometryToleranceM <= max
      ? 'elevation'
      : 'route';
  }
  return routeIssues.has(issue.code) ? 'route' : 'all';
}

export function completedSteps({
  editor,
  issues,
  currentResult,
  hasRoute,
  declinationLoading,
  busy,
  confirmedRoute,
}: {
  editor: Editor | null;
  issues: readonly ProcessingIssue[];
  currentResult: boolean;
  hasRoute: boolean;
  declinationLoading: boolean;
  busy: boolean;
  confirmedRoute: boolean;
}): StepCompletion {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const route =
    !!editor &&
    currentResult &&
    confirmedRoute &&
    !errors.some((issue) => !['stations', 'elevation'].includes(issueStage(issue, editor.options)));
  const stations =
    route &&
    editor.stations.every((station) => station.confirmed) &&
    !errors.some((issue) => issueStage(issue, editor.options) === 'stations');
  const elevation = stations && hasRoute && currentResult;
  return {
    import: !!editor,
    route,
    stations,
    elevation,
    preview: elevation,
    export: !declinationLoading && hasRoute && currentResult && !busy && confirmedRoute,
  };
}

export function canNavigate(
  state: WorkflowState,
  next: Step,
  complete: StepCompletion,
  busy: boolean,
): boolean {
  if (busy) return false;
  const target = STEPS.indexOf(next);
  if (target === 0) return true;
  if (!complete.import) return false;
  const current = STEPS.indexOf(state.step);
  // Previously visited steps remain reachable after edits invalidate completion.
  if (target <= current) return true;
  if (target > state.unlockedStep && target !== current + 1) return false;
  return STEPS.slice(0, target).every((step) => complete[step]);
}

/** Explain the next-step restriction using the same prerequisites as navigation. */
export function getContinueBlocker(
  state: WorkflowState,
  complete: StepCompletion,
  busy: boolean,
  currentResult: boolean,
): ContinueBlocker | null {
  const nextIndex = STEPS.indexOf(state.step) + 1;
  const next = STEPS[nextIndex];
  if (!next || canNavigate(state, next, complete, busy)) return null;
  if (busy) return 'busy';
  if (!currentResult) return 'processing';
  if (!state.confirmedRoute) return 'routeConfirmation';
  return STEPS.slice(0, nextIndex).find((step) => !complete[step]) ?? null;
}

export function navigateWorkflow(
  state: WorkflowState,
  next: Step,
  complete: StepCompletion,
  busy: boolean,
): WorkflowState {
  return canNavigate(state, next, complete, busy)
    ? { ...state, step: next, unlockedStep: Math.max(state.unlockedStep, STEPS.indexOf(next)) }
    : state;
}

/** Unchecking the route or undoing an edit invalidates later steps without moving the view. */
export function confirmWorkflowRoute(state: WorkflowState, confirmed: boolean): WorkflowState {
  return { ...state, confirmedRoute: confirmed, unlockedStep: confirmed ? state.unlockedStep : 1 };
}

/** Import, draft restoration and reference rebuild all start at route confirmation. */
export function resetWorkflow(): WorkflowState {
  return { ...INITIAL_WORKFLOW, step: 'route' };
}

export function workflowAfterEdit(
  state: WorkflowState,
  previous: Editor,
  next: Editor,
): WorkflowState {
  if (
    next.name !== previous.name ||
    next.reference !== previous.reference ||
    next.magneticDeclination !== previous.magneticDeclination ||
    next.declinationMode !== previous.declinationMode ||
    next.declinationQueryDate !== previous.declinationQueryDate ||
    next.options.geometryToleranceM !== previous.options.geometryToleranceM
  ) {
    return confirmWorkflowRoute(state, false);
  }
  if (next.stations !== previous.stations) {
    return { ...state, unlockedStep: Math.min(state.unlockedStep, 2) };
  }
  if (next.options !== previous.options) {
    return { ...state, unlockedStep: Math.min(state.unlockedStep, 3) };
  }
  return state;
}
