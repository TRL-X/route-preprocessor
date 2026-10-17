import type { WorkerTask } from '../workers/route.worker';

export function runWorkerTask<T>(task: WorkerTask, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let worker: Worker | undefined;
    const cleanup = () => {
      worker?.terminate();
      signal.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      cleanup();
      reject(signal.reason);
    };
    try {
      worker = new Worker(new URL('../workers/route.worker.ts', import.meta.url), {
        type: 'module',
      });
      signal.addEventListener('abort', cancel, { once: true });
      worker.onmessage = ({ data }: MessageEvent<{ ok: boolean; value: T; error?: string }>) => {
        cleanup();
        if (data.ok) resolve(data.value);
        else reject(new Error(data.error || 'Processing failed.'));
      };
      worker.onerror = (event) => {
        cleanup();
        reject(new Error(event.message || 'Processing worker failed.'));
      };
      worker.postMessage(task);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
