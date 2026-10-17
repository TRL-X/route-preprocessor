import { useEffect, useRef, useState } from 'react';
import { loadDraft, saveDraft } from './drafts';
import { DRAFT_VERSION, type Draft, type Editor, type Ledger } from './editor';
import { errorText, hex } from './route-files';

export function useEditorSession() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const [history, setHistory] = useState<Editor[]>([]);
  const [ledger, setLedger] = useState<Ledger>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    loadDraft()
      .then((value) => {
        if (active && !editorRef.current) setDraft(value);
      })
      .catch((error) => {
        if (active && !editorRef.current) {
          setSaved('failed');
          setLoadError(errorText(error));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    let active = true;
    setSaved('saving');
    const timer = setTimeout(() => {
      saveDraft({ version: DRAFT_VERSION, editor, ledger, savedAt: Date.now() })
        .then(() => {
          if (active) setSaved('saved');
        })
        .catch(() => {
          if (active) setSaved('failed');
        });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [editor, ledger]);

  function openEditor(next: Editor) {
    editorRef.current = next;
    setEditor(next);
    setHistory([]);
    setDraft(null);
    setLoadError('');
  }

  function edit(update: (previous: Editor) => Editor) {
    const previous = editorRef.current;
    if (!previous) return null;
    const next = update(previous);
    setHistory((past) => [...past.slice(-24), previous]);
    editorRef.current = next;
    setEditor(next);
    return { previous, next };
  }

  function undo() {
    const previous = history.at(-1);
    if (!previous) return false;
    editorRef.current = previous;
    setEditor(previous);
    setHistory(history.slice(0, -1));
    return true;
  }

  function restoreDraft() {
    if (!draft) return false;
    openEditor(draft.editor);
    setLedger(draft.ledger);
    return true;
  }

  async function saveExport(snapshot: Editor, nextLedger: Ledger) {
    setLedger(nextLedger);
    await saveDraft({
      version: DRAFT_VERSION,
      editor: snapshot,
      ledger: nextLedger,
      savedAt: Date.now(),
    }).catch(() => setSaved('failed'));
  }

  const currentRevision = editor ? (ledger[hex(editor.routeId)]?.revision ?? 1) : 1;
  return {
    editor,
    setEditor,
    ledger,
    draft,
    saved,
    loadError,
    canUndo: history.length > 0,
    currentRevision,
    openEditor,
    edit,
    undo,
    restoreDraft,
    saveExport,
    clearLoadError: () => setLoadError(''),
  };
}

export type EditorSession = ReturnType<typeof useEditorSession>;
