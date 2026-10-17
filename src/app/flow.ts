export const STEPS = ['import', 'route', 'stations', 'elevation', 'preview', 'export'] as const;
export type Step = (typeof STEPS)[number];
