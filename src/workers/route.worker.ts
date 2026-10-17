import { parseRouteFile } from '../core/import';
import { buildReference, createStations, processRoute } from '../core/process';
import { decodeRte, encodeRte } from '../core/rte';
import type {
  DraftStation,
  ProcessingOptions,
  ReferenceRoute,
  RouteData,
  RouteIdentity,
  SourceRoute,
} from '../core/types';

export type WorkerTask =
  | { type: 'import'; text: string; fileName: string }
  | {
      type: 'reference';
      source: SourceRoute;
      reverse: boolean;
      startIndex: number;
      landmarks: Parameters<typeof createStations>[1];
    }
  | {
      type: 'process';
      reference: ReferenceRoute;
      stations: DraftStation[];
      options: ProcessingOptions;
      identity: RouteIdentity;
    }
  | { type: 'export'; route: RouteData };

self.onmessage = (event: MessageEvent<WorkerTask>) => {
  try {
    const task = event.data;
    if (task.type === 'import') {
      const file = parseRouteFile(task.text, task.fileName);
      const reference = buildReference(file.routes[0]);
      self.postMessage({
        ok: true,
        value: { file, reference, stations: createStations(reference, file.landmarks) },
      });
    } else if (task.type === 'reference') {
      const reference = buildReference(task.source, {
        reverse: task.reverse,
        startIndex: task.startIndex,
      });
      self.postMessage({
        ok: true,
        value: { reference, stations: createStations(reference, task.landmarks) },
      });
    } else if (task.type === 'process') {
      self.postMessage({
        ok: true,
        value: processRoute(task.reference, task.stations, task.options, task.identity),
      });
    } else {
      const bytes = encodeRte(task.route);
      decodeRte(bytes);
      self.postMessage({ ok: true, value: bytes }, { transfer: [bytes.buffer] });
    }
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
