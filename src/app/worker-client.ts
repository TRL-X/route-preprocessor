import type { WorkerTask } from '../workers/route.worker';

export function workerTask<T>(task: WorkerTask): { promise: Promise<T>; cancel: () => void } {
  let worker: Worker | undefined;
  let rejectPromise: (reason: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    try {
      worker = new Worker(new URL('../workers/route.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<{ ok: boolean; value: T; error?: string }>) => {
        worker?.terminate();
        if (data.ok) resolve(data.value);
        else reject(new Error(data.error || 'Processing failed.'));
      };
      worker.onerror = (event) => {
        worker?.terminate();
        reject(new Error(event.message || 'Processing worker failed.'));
      };
      worker.postMessage(task);
    } catch (error) {
      worker?.terminate();
      reject(error);
    }
  });
  return {
    promise,
    cancel: () => {
      worker?.terminate();
      rejectPromise(new DOMException('Cancelled', 'AbortError'));
    },
  };
}
