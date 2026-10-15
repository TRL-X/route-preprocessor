import { createMachine } from 'xstate';
export const STEPS = ['import', 'route', 'stations', 'elevation', 'preview', 'export'] as const;
export type Step = typeof STEPS[number];
export const flowMachine = createMachine({
  id: 'route-studio', initial: 'import',
  on: {
    IMPORT: '.import', ROUTE: '.route', STATIONS: '.stations',
    ELEVATION: '.elevation', PREVIEW: '.preview', EXPORT: '.export',
  },
  states: Object.fromEntries(STEPS.map(step => [step, {}])),
});
