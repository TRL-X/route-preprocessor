import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runWorkerTask } from '../../src/app/worker-client';

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    TestWorker.instances.push(this);
  }
}

beforeEach(() => {
  TestWorker.instances = [];
  vi.stubGlobal('Worker', TestWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('skips worker creation when already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runWorkerTask({ type: 'import', text: '', fileName: 'route.gpx' }, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(TestWorker.instances).toHaveLength(0);
});

it('terminates a pending worker when cancelled', async () => {
  const controller = new AbortController();
  const promise = runWorkerTask(
    { type: 'import', text: '', fileName: 'route.gpx' },
    controller.signal,
  );
  const result = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await result;
  expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
});

it('releases the abort listener after receiving a result', async () => {
  const controller = new AbortController();
  const promise = runWorkerTask<string>(
    { type: 'import', text: '', fileName: 'route.gpx' },
    controller.signal,
  );
  const worker = TestWorker.instances[0];
  worker.onmessage?.({ data: { ok: true, value: 'ready' } });
  expect(await promise).toBe('ready');
  controller.abort();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('terminates the worker and reports worker errors', async () => {
  const promise = runWorkerTask(
    { type: 'import', text: '', fileName: 'route.gpx' },
    new AbortController().signal,
  );
  const result = expect(promise).rejects.toThrow('Worker failed');
  const worker = TestWorker.instances[0];
  worker.onerror?.({ message: 'Worker failed' });
  await result;
  expect(worker.terminate).toHaveBeenCalledOnce();
});
