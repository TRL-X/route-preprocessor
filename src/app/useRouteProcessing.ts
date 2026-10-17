import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { fetchRouteDeclination } from '../core/declination';
import type { ProcessingResult, ReferenceRoute } from '../core/types';
import type { Editor } from './editor';
import { errorText, isCancelled } from './route-files';
import { runWorkerTask } from './worker-client';

export function useRouteProcessing(
  editor: Editor | null,
  setEditor: Dispatch<SetStateAction<Editor | null>>,
  revision: number,
) {
  const [processed, setProcessed] = useState<{
    editor: Editor;
    revision: number;
    result: ProcessingResult;
  } | null>(null);
  const [lookup, setLookup] = useState<{
    reference: ReferenceRoute;
    date: string;
    status: 'loading' | 'available' | 'unavailable';
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const declinationMode =
    editor?.declinationMode ?? (editor?.magneticDeclination ? 'manual' : 'omit');
  const declinationDate = editor?.declinationQueryDate ?? '';
  const declinationStatus =
    declinationMode === 'auto'
      ? lookup?.reference === editor?.reference && lookup?.date === declinationDate
        ? lookup.status
        : 'loading'
      : null;

  useEffect(() => {
    if (!editor) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void runWorkerTask<ProcessingResult>(
        {
          type: 'process',
          reference: editor.reference,
          stations: editor.stations,
          options: editor.options,
          identity: {
            routeId: editor.routeId,
            revision,
            name: editor.name,
            magneticDeclination: editor.magneticDeclination,
          },
        },
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) setProcessed({ editor, revision, result });
        })
        .catch((error) => {
          if (!controller.signal.aborted && !isCancelled(error)) {
            setProcessed({
              editor,
              revision,
              result: {
                route: null,
                issues: [{ code: 'processing', severity: 'error', message: errorText(error) }],
              },
            });
          }
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [editor, revision]);

  useEffect(() => {
    if (!editor || declinationMode !== 'auto') {
      setLookup(null);
      return;
    }
    const reference = editor.reference;
    const controller = new AbortController();
    setLookup({ reference, date: declinationDate, status: 'loading' });
    setEditor((previous) =>
      previous?.reference === reference
        ? { ...previous, magneticDeclination: undefined }
        : previous,
    );
    void fetchRouteDeclination(reference, declinationDate, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setEditor((previous) =>
        previous?.reference === reference &&
        previous.declinationMode === 'auto' &&
        previous.declinationQueryDate === declinationDate
          ? { ...previous, magneticDeclination: value }
          : previous,
      );
      setLookup({ reference, date: declinationDate, status: value ? 'available' : 'unavailable' });
    });
    return () => controller.abort();
  }, [editor?.reference, declinationMode, declinationDate, retry, setEditor]);

  const currentResult = !!editor && processed?.editor === editor && processed.revision === revision;
  return {
    result: editor ? (processed?.result ?? null) : null,
    currentResult,
    processing: !!editor && !currentResult,
    declinationMode,
    declinationDate,
    declinationStatus,
    retryDeclination: () => setRetry((previous) => previous + 1),
  };
}
