import { describe, expect, it } from 'vitest';
import {
  INITIAL_WORKFLOW,
  STEPS,
  canNavigate,
  completedSteps,
  confirmWorkflowRoute,
  getContinueBlocker,
  navigateWorkflow,
  resetWorkflow,
  workflowAfterEdit,
  type Step,
  type StepCompletion,
  type WorkflowState,
} from '../../src/app/flow';
import type { Editor } from '../../src/app/editor';
import { parseRouteFile } from '../../src/core/import';
import { PROCESSING_DEFAULTS } from '../../src/core/policy';
import { buildReference, createStations } from '../../src/core/process';

const file = parseRouteFile(
  '<gpx><trk><trkseg><trkpt lat="0" lon="0"><ele>100</ele></trkpt><trkpt lat="0" lon="0.001"><ele>120</ele></trkpt></trkseg></trk></gpx>',
  'trail.gpx',
);
const reference = buildReference(file.routes[0]);
const editor: Editor = {
  file,
  reference,
  stations: createStations(reference, file.landmarks),
  options: { ...PROCESSING_DEFAULTS },
  name: 'Trail',
  routeId: new Uint8Array(16),
  inputSha256: new Uint8Array(32),
  sourceIndex: 0,
  reverse: false,
  startIndex: 0,
  declinationMode: 'omit',
};
const exported: WorkflowState = { step: 'export', unlockedStep: 5, confirmedRoute: true };
const complete: StepCompletion = {
  import: true,
  route: true,
  stations: true,
  elevation: true,
  preview: true,
  export: true,
};
type CompletionInput = Parameters<typeof completedSteps>[0];
const input: CompletionInput = {
  editor,
  issues: [],
  currentResult: true,
  hasRoute: true,
  declinationLoading: false,
  busy: false,
  confirmedRoute: true,
};

describe('workflow completion and export readiness', () => {
  it.each<{
    name: string;
    overrides: Partial<CompletionInput>;
    expected: boolean[];
  }>([
    {
      name: 'valid confirmed route',
      overrides: {},
      expected: [true, true, true, true, true, true],
    },
    {
      name: 'no imported editor',
      overrides: { editor: null, currentResult: false, hasRoute: false },
      expected: [false, false, false, false, false, false],
    },
    {
      name: 'route needs confirmation',
      overrides: { confirmedRoute: false },
      expected: [true, false, false, false, false, false],
    },
    {
      name: 'stale processing result',
      overrides: { currentResult: false },
      expected: [true, false, false, false, false, false],
    },
    {
      name: 'no generated route',
      overrides: { hasRoute: false },
      expected: [true, true, true, false, false, false],
    },
    {
      name: 'declination lookup pending',
      overrides: { declinationLoading: true },
      expected: [true, true, true, true, true, false],
    },
    {
      name: 'file operation or device upload busy',
      overrides: { busy: true },
      expected: [true, true, true, true, true, false],
    },
    {
      name: 'warnings do not block completion',
      overrides: { issues: [{ code: 'LARGE_SOURCE_EDGE', severity: 'warning' }] },
      expected: [true, true, true, true, true, true],
    },
    {
      name: 'route validation error',
      overrides: { issues: [{ code: 'ROUTE_NAME_INVALID', severity: 'error' }], hasRoute: false },
      expected: [true, false, false, false, false, false],
    },
    {
      name: 'unknown blocking error',
      overrides: { issues: [{ code: 'FUTURE_ERROR', severity: 'error' }], hasRoute: false },
      expected: [true, false, false, false, false, false],
    },
    {
      name: 'station validation error leaves route complete',
      overrides: { issues: [{ code: 'STATION_UNCONFIRMED', severity: 'error' }], hasRoute: false },
      expected: [true, true, false, false, false, false],
    },
    {
      name: 'unconfirmed station leaves route complete',
      overrides: {
        editor: {
          ...editor,
          stations: editor.stations.map((station) => ({ ...station, confirmed: false })),
        },
        hasRoute: false,
      },
      expected: [true, true, false, false, false, false],
    },
    {
      name: 'elevation validation error leaves stations complete',
      overrides: { issues: [{ code: 'INCOMPLETE_ELEVATION', severity: 'error' }], hasRoute: false },
      expected: [true, true, true, false, false, false],
    },
    {
      name: 'invalid geometry option belongs to route confirmation',
      overrides: {
        editor: { ...editor, options: { ...editor.options, geometryToleranceM: NaN } },
        issues: [{ code: 'OPTIONS_INVALID', severity: 'error' }],
        hasRoute: false,
      },
      expected: [true, false, false, false, false, false],
    },
    {
      name: 'other invalid processing options belong to elevation',
      overrides: {
        editor: { ...editor, options: { ...editor.options, elevationIntervalM: NaN } },
        issues: [{ code: 'OPTIONS_INVALID', severity: 'error' }],
        hasRoute: false,
      },
      expected: [true, true, true, false, false, false],
    },
  ])('$name', ({ overrides, expected }) => {
    const actual = completedSteps({ ...input, ...overrides });
    expect(STEPS.map((step) => actual[step])).toEqual(expected);
  });
});

describe('workflow navigation', () => {
  it.each<{
    name: string;
    state: WorkflowState;
    next: Step;
    completion?: StepCompletion;
    busy?: boolean;
    allowed: boolean;
  }>([
    {
      name: 'initial import stays reachable',
      state: INITIAL_WORKFLOW,
      next: 'import',
      allowed: true,
    },
    {
      name: 'editor required to leave import',
      state: INITIAL_WORKFLOW,
      next: 'route',
      completion: { ...complete, import: false },
      allowed: false,
    },
    {
      name: 'next step does not need prior unlocking',
      state: { ...exported, step: 'route', unlockedStep: 1 },
      next: 'stations',
      allowed: true,
    },
    {
      name: 'unvisited steps cannot be skipped',
      state: { ...exported, step: 'route', unlockedStep: 1 },
      next: 'elevation',
      allowed: false,
    },
    {
      name: 'previously unlocked forward steps remain available',
      state: { ...exported, step: 'route' },
      next: 'preview',
      allowed: true,
    },
    {
      name: 'forward navigation still requires completed prerequisites',
      state: { ...exported, step: 'route' },
      next: 'export',
      completion: { ...complete, stations: false },
      allowed: false,
    },
    {
      name: 'backward navigation survives invalidated confirmation',
      state: { ...exported, confirmedRoute: false, unlockedStep: 1 },
      next: 'stations',
      completion: { ...complete, route: false, stations: false },
      allowed: true,
    },
    {
      name: 'current step survives invalidated confirmation',
      state: { ...exported, confirmedRoute: false, unlockedStep: 1 },
      next: 'export',
      completion: { ...complete, route: false },
      allowed: true,
    },
    { name: 'busy blocks import', state: exported, next: 'import', busy: true, allowed: false },
    {
      name: 'busy blocks backward steps',
      state: exported,
      next: 'route',
      busy: true,
      allowed: false,
    },
    {
      name: 'busy blocks forward steps',
      state: { ...exported, step: 'route' },
      next: 'stations',
      busy: true,
      allowed: false,
    },
  ])('$name', ({ state, next, completion = complete, busy = false, allowed }) => {
    expect(canNavigate(state, next, completion, busy)).toBe(allowed);
    const result = navigateWorkflow(state, next, completion, busy);
    if (allowed) {
      expect(result).toEqual({
        ...state,
        step: next,
        unlockedStep: Math.max(state.unlockedStep, STEPS.indexOf(next)),
      });
    } else {
      expect(result).toBe(state);
    }
  });
});

describe('next-step feedback', () => {
  it.each<{
    name: string;
    state: WorkflowState;
    overrides?: Partial<CompletionInput>;
    expected: ReturnType<typeof getContinueBlocker>;
  }>([
    {
      name: 'offers the next step when its prerequisites are complete',
      state: { ...exported, step: 'route' },
      expected: null,
    },
    {
      name: 'allows leaving import before route processing or confirmation',
      state: INITIAL_WORKFLOW,
      overrides: { currentResult: false, hasRoute: false },
      expected: null,
    },
    {
      name: 'prioritizes an active task over pending processing and confirmation',
      state: { ...exported, step: 'elevation', confirmedRoute: false },
      overrides: { busy: true, currentResult: false },
      expected: 'busy',
    },
    {
      name: 'waits for the current processing result before showing a validation blocker',
      state: { ...exported, step: 'route', confirmedRoute: false },
      overrides: { currentResult: false },
      expected: 'processing',
    },
    {
      name: 'requests route confirmation after undo without moving the current view',
      state: { ...exported, step: 'preview', confirmedRoute: false, unlockedStep: 1 },
      expected: 'routeConfirmation',
    },
    {
      name: 'identifies route errors after confirmation',
      state: { ...exported, step: 'route' },
      overrides: {
        issues: [{ code: 'ROUTE_NAME_INVALID', severity: 'error' }],
        hasRoute: false,
      },
      expected: 'route',
    },
    {
      name: 'identifies an earlier station requirement while viewing elevation',
      state: { ...exported, step: 'elevation', unlockedStep: 2 },
      overrides: {
        issues: [{ code: 'STATION_UNCONFIRMED', severity: 'error' }],
        hasRoute: false,
      },
      expected: 'stations',
    },
    {
      name: 'identifies an elevation requirement on the current step',
      state: { ...exported, step: 'elevation' },
      overrides: {
        issues: [{ code: 'INCOMPLETE_ELEVATION', severity: 'error' }],
        hasRoute: false,
      },
      expected: 'elevation',
    },
    {
      name: 'allows opening export while its declination lookup is still pending',
      state: { ...exported, step: 'preview' },
      overrides: { declinationLoading: true },
      expected: null,
    },
    {
      name: 'has no continuation restriction on the final step',
      state: { ...exported, confirmedRoute: false },
      overrides: { busy: true, currentResult: false },
      expected: null,
    },
  ])('$name', ({ state, overrides, expected }) => {
    const completionInput = { ...input, confirmedRoute: state.confirmedRoute, ...overrides };
    const completion = completedSteps(completionInput);
    const blocker = getContinueBlocker(
      state,
      completion,
      completionInput.busy,
      completionInput.currentResult,
    );
    expect(blocker).toBe(expected);
    const next = STEPS[STEPS.indexOf(state.step) + 1];
    if (next) {
      expect(blocker === null).toBe(canNavigate(state, next, completion, completionInput.busy));
    }
  });
});

describe('workflow invalidation', () => {
  it.each<[string, Partial<Editor>]>([
    ['name', { name: 'Changed' }],
    ['reference', { reference: { ...reference } }],
    [
      'declination',
      {
        magneticDeclination: {
          declinationCdeg: 100,
          referenceLatE7: 0,
          referenceLonE7: 0,
          referenceDate: '2026-10-18',
          source: 'manual',
        },
      },
    ],
    ['declination mode', { declinationMode: 'auto' }],
    ['declination date', { declinationQueryDate: '2026-10-18' }],
    ['geometry tolerance', { options: { ...editor.options, geometryToleranceM: 3 } }],
  ])('requires route reconfirmation after changing %s without moving the view', (_, patch) => {
    expect(workflowAfterEdit(exported, editor, { ...editor, ...patch })).toEqual({
      step: 'export',
      unlockedStep: 1,
      confirmedRoute: false,
    });
  });

  it.each<[string, Partial<Editor>, number]>([
    ['stations', { stations: [...editor.stations] }, 2],
    ['elevation options', { options: { ...editor.options, elevationIntervalM: 20 } }, 3],
    [
      'stations and elevation options together',
      { stations: [...editor.stations], options: { ...editor.options, elevationIntervalM: 20 } },
      2,
    ],
  ])('invalidates later steps after changing %s', (_, patch, unlockedStep) => {
    expect(workflowAfterEdit(exported, editor, { ...editor, ...patch })).toEqual({
      ...exported,
      unlockedStep,
    });
    expect(workflowAfterEdit(INITIAL_WORKFLOW, editor, { ...editor, ...patch }).unlockedStep).toBe(
      1,
    );
  });

  it('keeps route invalidation first when a change also replaces stations and options', () => {
    expect(
      workflowAfterEdit(exported, editor, {
        ...editor,
        name: 'Changed',
        stations: [...editor.stations],
        options: { ...editor.options, elevationIntervalM: 20 },
      }),
    ).toEqual({ ...exported, unlockedStep: 1, confirmedRoute: false });
  });

  it('keeps workflow state for edits that affect no workflow prerequisite', () => {
    expect(workflowAfterEdit(exported, editor, { ...editor })).toBe(exported);
  });

  it('resets route confirmation on undo or unchecking without changing the current step', () => {
    const invalidated = confirmWorkflowRoute(exported, false);
    expect(invalidated).toEqual({ ...exported, confirmedRoute: false, unlockedStep: 1 });
    expect(confirmWorkflowRoute(invalidated, true)).toEqual({
      ...invalidated,
      confirmedRoute: true,
    });
    expect(confirmWorkflowRoute(exported, true)).toEqual(exported);
  });

  it('starts imports, restored drafts and reference rebuilds at route confirmation', () => {
    expect(resetWorkflow()).toEqual({ step: 'route', unlockedStep: 1, confirmedRoute: false });
    expect(INITIAL_WORKFLOW).toEqual({ step: 'import', unlockedStep: 1, confirmedRoute: false });
  });
});
