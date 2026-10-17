import { useEffect, useRef, useState } from 'react';
import type { RouteData } from '../core/types';
import {
  download,
  errorText,
  importRouteFile,
  isCancelled,
  prepareRouteExport,
  rebuildRoute,
  type ExportedRoute,
} from './route-files';
import type { EditorSession } from './useEditorSession';

export function useRouteFiles(
  session: Pick<EditorSession, 'editor' | 'ledger' | 'openEditor' | 'edit' | 'saveExport'>,
) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exported, setExported] = useState<ExportedRoute | null>(null);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => {
    setExported(null);
  }, [session.editor]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => () => operation.current?.abort(), []);

  async function run<T>(
    label: string,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(label);
    setError('');
    try {
      return await action(controller.signal);
    } catch (error) {
      if (!isCancelled(error)) setError(errorText(error));
    } finally {
      operation.current = null;
      setBusy('');
    }
  }

  async function importFile(file: File) {
    return (
      (await run('app.importingRoute', async (signal) => {
        const editor = await importRouteFile(file, signal);
        signal.throwIfAborted();
        session.openEditor(editor);
        return true;
      })) ?? false
    );
  }

  async function rebuild(sourceIndex: number, reverse: boolean, startIndex: number) {
    const editor = session.editor;
    if (!editor) return false;
    return (
      (await run('app.rebuildingRoute', async (signal) => {
        const next = await rebuildRoute(editor, sourceIndex, reverse, startIndex, signal);
        signal.throwIfAborted();
        session.edit(() => next);
        return true;
      })) ?? false
    );
  }

  async function exportRoute(route: RouteData | null, ready: boolean) {
    const editor = session.editor;
    if (!editor || !route || !ready) return;
    await run('app.exportingRoute', async (signal) => {
      const output = await prepareRouteExport(editor, route, session.ledger, signal);
      signal.throwIfAborted();
      await session.saveExport(editor, output.ledger);
      signal.throwIfAborted();
      download(output.bytes, output.exported.filename);
      setExported(output.exported);
      setNotice(output.persisted ? 'app.exportSuccess' : 'app.exportWithNewIdentity');
    });
  }

  return {
    busy,
    error,
    notice,
    exported,
    importFile,
    rebuild,
    exportRoute,
    clearError: () => setError(''),
    cancel: () => operation.current?.abort(),
    isBusy: () => operation.current !== null,
  };
}
