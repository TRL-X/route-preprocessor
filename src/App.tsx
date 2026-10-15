import { availableLanguages } from './i18n';
import { useLocale } from './i18n/useLocale';
import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import type { ChangeEvent } from 'react';
import { useMachine } from '@xstate/react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Circle, FileUp, Flag, Globe2, Layers, LoaderCircle, MapPinned, Mountain, Plus, RotateCcw, Route, ShieldCheck, SlidersHorizontal, Trash2, TriangleAlert, Undo2, X } from 'lucide-react';
import { flowMachine, STEPS, type Step } from './app/flow';
import { workerTask } from './app/worker-client';
import { loadDraft, saveDraft, reserveExportRevision, RevisionExhaustedError } from './app/drafts';
import { positionAt } from './core/process';
import type { DraftStation, ImportedFile, ProcessingOptions, ProcessingResult, ReferenceRoute, RouteData } from './core/types';
import ElevationChart from './components/ElevationChart';
import ImportLanding from './features/import/ImportLanding';
import IssuesList from './features/review/IssuesList';
import StageList from './features/review/StageList';

const RouteMap = lazy(() => import('./components/RouteMap'));
type Editor = {
  file: ImportedFile; reference: ReferenceRoute; stations: DraftStation[];
  options: ProcessingOptions; name: string; routeId: Uint8Array; inputSha256: Uint8Array;
  sourceIndex: number; reverse: boolean; startIndex: number;
};
type Ledger = Record<string, { revision: number; hash: string }>;
type Draft = { version: 1 | 2; editor: Editor; ledger: Ledger; savedAt: number };
const DEFAULT_OPTIONS: ProcessingOptions = { geometryToleranceM: 2, elevationIntervalM: 10, smoothingWindowM: 0, elevationMode: 'omit', acceptUncertainElevation: false };
const hex = (bytes: Uint8Array) => Array.from(bytes, v => v.toString(16).padStart(2, '0')).join('');
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
async function digest(bytes: Uint8Array) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))); }
function download(bytes: Uint8Array, filename: string, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export default function App() {
  const { t, language, changeLanguage, number, km, message, uiText } = useLocale();
  const size = (bytes: number) => number(bytes / (bytes >= 1048576 ? 1048576 : 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + (bytes >= 1048576 ? ' MB' : ' KB');
  const [flow, send] = useMachine(flowMachine);
  const step = flow.value as Step;
  const stepIndex = STEPS.indexOf(step);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef(editor); editorRef.current = editor;
  const [history, setHistory] = useState<Editor[]>([]);
  const [ledger, setLedger] = useState<Ledger>({});
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const processedEditor = useRef<Editor | null>(null);
  const [processing, setProcessing] = useState(false);
  const [busy, setBusy] = useState('');
  const cancelTask = useRef<(() => void) | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selectedStationId, setSelectedStationId] = useState<number | null>(null);
  const [cursorS, setCursorS] = useState<number | null>(null);
  const [basemap, setBasemap] = useState(true);
  const [compareSource, setCompareSource] = useState(true);
  const [mobileView, setMobileView] = useState<'map' | 'profile'>('map');
  const [confirmedRoute, setConfirmedRoute] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; body: string; run: () => void } | null>(null);
  const [exported, setExported] = useState<{ filename: string; bytes: number; revision: number; routeId: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileBusy = useRef(false);
  const route = result?.route ?? null;
  const ready = !!route && !processing && processedEditor.current === editor && !busy && confirmedRoute;
  const sortedStations = editor ? [...editor.stations].sort((a, b) => a.s - b.s || a.id - b.id) : [];
  const selected = editor?.stations.find(s => s.id === selectedStationId);
  const unresolved = editor?.stations.filter(s => !s.confirmed).length ?? 0;
  const issues = result?.issues ?? editor?.reference.issues ?? [];
  const totalM = editor?.reference.totalM ?? 0;
  const currentRevision = editor ? ledger[hex(editor.routeId)]?.revision ?? 1 : 1;
  const go = (next: Step) => { if (next === 'import' || editor) { send({ type: next.toUpperCase() }); setError(''); } };

  useEffect(() => {
    loadDraft<Draft>().then(value => { if ((value?.version === 1 || value?.version === 2) && value.editor?.file && value.editor.routeId instanceof Uint8Array) setDraft(value); }).catch(() => setSaved('failed'));
  }, []);
  useEffect(() => {
    if (!editor) return;
    setSaved('saving');
    const timer = setTimeout(() => {
      saveDraft({ version: 2, editor, ledger, savedAt: Date.now() } satisfies Draft).then(() => setSaved('saved')).catch(() => setSaved('failed'));
    }, 500);
    return () => clearTimeout(timer);
  }, [editor, ledger]);
  useEffect(() => {
    if (!editor) { setResult(null); return; }
    setProcessing(true);
    let active = true;
    let cancel: (() => void) | undefined;
    const timer = setTimeout(() => {
      const job = workerTask<ProcessingResult>({ type: 'process', reference: editor.reference, stations: editor.stations, options: editor.options, identity: { routeId: editor.routeId, revision: currentRevision, name: editor.name, inputSha256: editor.inputSha256 } });
      cancel = job.cancel;
      job.promise.then(value => { if (active) { setResult(value); processedEditor.current = editor; setProcessing(false); } }).catch(e => {
        if (active && !aborted(e)) { setResult({ route: null, issues: [{ code: 'processing', severity: 'error', message: errorText(e) }] }); setProcessing(false); }
      });
    }, 120);
    return () => { active = false; clearTimeout(timer); cancel?.(); };
  }, [editor, currentRevision]);
  useEffect(() => { setExported(null); }, [editor]);
  useEffect(() => {
    setCursorS(previous => previous === null || !editor ? null : Math.min(editor.reference.totalM, Math.max(0, previous)));
  }, [editor?.reference]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => () => cancelTask.current?.(), []);

  const edit = useCallback((update: (previous: Editor) => Editor) => {
    const previous = editorRef.current;
    if (!previous || fileBusy.current) return;
    setHistory(history => [...history.slice(-24), previous]);
    setEditor(update(previous)); setError('');
  }, []);
  const editStation = (patch: Partial<DraftStation>) => edit(e => ({ ...e, stations: e.stations.map(s => s.id === selectedStationId ? { ...s, ...patch } : s) }));
  const editOptions = (patch: Partial<ProcessingOptions>) => edit(e => ({ ...e, options: { ...e.options, ...patch } }));

  async function importFile(file: File) {
    if (fileBusy.current) return;
    setError('');
    if (!/\.(gpx|kml)$/i.test(file.name)) { setError('app.chooseAGpxOrKmlRouteFile'); return; }
    if (file.size > 20 * 1024 * 1024) { setError('app.theFileLimitIs20MbChooseA'); return; }
    fileBusy.current = true; setBusy('app.readingYourRoute');
    let cancelled = false;
    cancelTask.current = () => { cancelled = true; };
    try {
      const bytes = await file.arrayBuffer();
      if (cancelled) return;
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      if (cancelled) return;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const job = workerTask<{ file: ImportedFile; reference: ReferenceRoute; stations: DraftStation[] }>({ type: 'import', text, fileName: file.name });
      cancelTask.current = job.cancel;
      const data = await job.promise;
      const complete = data.reference.points.every(p => p.elevation !== null) && !data.reference.elevationUncertain;
      setEditor({ ...data, options: { ...DEFAULT_OPTIONS, elevationMode: complete ? 'source' : 'omit' }, name: data.file.routes[0].name || file.name.replace(/\.(gpx|kml)$/i, ''), routeId: crypto.getRandomValues(new Uint8Array(16)), inputSha256: hash, sourceIndex: 0, reverse: false, startIndex: 0 });
      setHistory([]); setDraft(null); setCursorS(0); setSelectedStationId(null); setConfirmedRoute(false); setExported(null);
      send({ type: 'ROUTE' });
    } catch (e) { if (!aborted(e)) setError(errorText(e)); }
    finally { setBusy(''); cancelTask.current = null; fileBusy.current = false; }
  }

  async function rebuild(sourceIndex: number, reverse: boolean, startIndex: number) {
    if (!editor || fileBusy.current) return;
    fileBusy.current = true;
    setBusy('app.rebuildingDistanceAndStationOrder'); setError('');
    const snapshot = editor;
    const job = workerTask<{ reference: ReferenceRoute; stations: DraftStation[] }>({ type: 'reference', source: editor.file.routes[sourceIndex], reverse, startIndex, landmarks: editor.file.landmarks });
    cancelTask.current = job.cancel;
    try {
      const data = await job.promise;
      setHistory(past => [...past.slice(-24), snapshot]);
      setEditor({ ...snapshot, ...data, sourceIndex, reverse, startIndex });
      setConfirmedRoute(false); setSelectedStationId(null); setCursorS(0);
    } catch (e) { if (!aborted(e)) setError(errorText(e)); }
    finally { setBusy(''); cancelTask.current = null; fileBusy.current = false; }
  }
  function confirmRebuild(sourceIndex: number, reverse: boolean, startIndex: number) {
    setDialog({ title: 'app.rebuildThisRoute', body: 'app.distancesAndStationPositionsWillBeRecalculatedStation', run: () => { void rebuild(sourceIndex, reverse, startIndex); } });
  }
  function addStation() {
    if (!editor) return;
    const s = Math.max(0, Math.min(totalM, cursorS ?? totalM / 2)), point = positionAt(editor.reference, s);
    const id = Math.max(...editor.stations.map(s => s.id)) + 1;
    edit(e => ({ ...e, stations: [...e.stations, { id, name: t('app.newCheckpoint'), shortLabel: 'CP' + id, kind: 2, stageBoundary: true, s, lat: point.lat, lon: point.lon, confirmed: true, candidates: [] }] }));
    setSelectedStationId(id);
  }
  function restoreDraft() {
    if (!draft) return;
    setEditor(draft.editor); setLedger(draft.ledger ?? {}); setHistory([]); setDraft(null); setConfirmedRoute(false); setCursorS(0); send({ type: 'ROUTE' });
  }
  async function exportRoute() {
    if (!editor || !route || !ready || fileBusy.current) return;
    fileBusy.current = true;
    setError(''); setBusy('app.encodingAndCheckingEverySection');
    let cancelled = false;
    let cancelWorker: (() => void) | undefined;
    cancelTask.current = () => { cancelled = true; cancelWorker?.(); };
    const checkCancelled = () => { if (cancelled) throw new DOMException('Cancelled', 'AbortError'); };
    try {
      const key = hex(editor.routeId);
      const encode = async (data: RouteData) => {
        const job = workerTask<Uint8Array>({ type: 'export', route: data }); cancelWorker = job.cancel;
        const value = await job.promise; checkCancelled(); return value;
      };
      const canonical = await encode({ ...route, revision: 1 });
      const hash = await digest(canonical);
      checkCancelled();
      let revision: number;
      let outputId = editor.routeId;
      let persisted = true;
      try {
        revision = await reserveExportRevision(key, hash, ledger[key]?.revision ?? 0);
      } catch (reservationError) {
        if (reservationError instanceof RevisionExhaustedError) throw reservationError;
        // Without durable ownership, each download gets a unique identity.
        // The editable project's old identity is never used by this fallback.
        persisted = false; revision = 1;
        outputId = crypto.getRandomValues(new Uint8Array(16));
      }
      checkCancelled();
      const bytes = revision === 1 && persisted ? canonical : await encode({ ...route, routeId: outputId, revision });
      checkCancelled();
      const nextLedger = persisted ? { ...ledger, [key]: { revision, hash } } : ledger;
      const filename = (editor.name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0,80) || 'route') + '.rte';
      setLedger(nextLedger);
      await saveDraft({ version: 2, editor, ledger: nextLedger, savedAt: Date.now() } satisfies Draft).catch(() => setSaved('failed'));
      checkCancelled();
      download(bytes, filename);
      setExported({ filename, bytes: bytes.length, revision, routeId: hex(outputId) });
      setNotice(persisted ? 'app.yourValidatedRouteFileIsReady' : 'app.localStorageIsUnavailableExportedWithANew');
    } catch (e) { if (!aborted(e)) setError(errorText(e)); }
    finally { setBusy(''); cancelTask.current = null; fileBusy.current = false; }
  }
  function exportReport() {
    if (!editor) return;
    const report = { name: editor.name, source: editor.file.fileName, routeId: exported?.routeId ?? hex(editor.routeId), revision: exported?.revision ?? currentRevision, parameters: editor.options, totalDistanceM: totalM, reportLanguage: language, issues: issues.map(issue => ({ ...issue, message: message(issue) })), stationCount: editor.stations.length, inputSha256: hex(editor.inputSha256) };
    download(new TextEncoder().encode(JSON.stringify(report, null, 2)), 'route-quality-report.json', 'application/json');
  }
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; };
  const lastElev = route?.elev?.at(-1);
  const estimateBytes = route ? 64 + (route.elev ? 96 : 72) + route.geom.length * 12 + (route.elev?.length ?? 0) * 16 + Math.ceil((route.geom.length - 1) / 128) * 32 + route.stations.length * 80 + 256 : 0;
  const selectStation = (id: number) => { setSelectedStationId(id); const station = editor?.stations.find(s => s.id === id); if (station) setCursorS(station.s); go('stations'); };

  return <div className="studio">
    <header className="topbar">
      <a className="brand" href="/" onClick={e => { e.preventDefault(); go('import'); }} aria-label="TRL-X Route Studio">
        <span className="brand-mark"><Mountain size={23} strokeWidth={1.8} /></span><span>TRL-X <span className="brand-light">/ ROUTE STUDIO</span></span>
      </a>
      <div className="top-actions">
        <span className="local-badge"><span className="status-dot" />{t('app.localFirstWorkspace')}</span>
        <label className="language-button"><Globe2 size={16} /><select aria-label={t('app.language')} value={language} onChange={event => void changeLanguage(event.target.value)}>{availableLanguages.map(locale => <option key={locale.code} value={locale.code} lang={locale.code}>{locale.label}</option>)}</select></label>
        <span className="version-badge">V1.0</span>
      </div>
    </header>
    <main className="main-shell">
      <section className="title-row">
        <div><p className="eyebrow"><span className="tiny-line" />{t('app.fromFileToFinishLine')}</p><h1>{editor && step !== 'import' ? editor.name : t('app.aBetterRouteStartsHere')}</h1><p className="page-description">{editor && step !== 'import' ? t('app.refineTheDetailsKeepTheAdventure') : t('app.turnYourGpxOrKmlIntoATrail')}</p></div>
        {editor && <div className="document-actions"><span className="save-status">{saved === 'saved' ? <Check size={14} /> : saved === 'saving' ? <LoaderCircle size={14} className="spin" /> : <Circle size={12} />}{saved === 'saved' ? t('app.savedOnThisDevice') : saved === 'failed' ? t('app.localSaveUnavailable') : t('app.saving')}</span><button className="button button-ghost" disabled={!history.length || !!busy} onClick={() => { const previous = history.at(-1); if (previous) { setEditor(previous); setHistory(history.slice(0,-1)); setConfirmedRoute(false); } }}><Undo2 size={16} />{t('app.undo')}</button></div>}
      </section>
      <nav className="stepper" aria-label={t('app.routePreparationSteps')}>
        {STEPS.map((item, index) => <button key={item} className={'step ' + (step === item ? 'active' : '') + (index < stepIndex ? ' visited' : '')} disabled={(!editor && index > 0) || !!busy} onClick={() => go(item)} aria-current={step === item ? 'step' : undefined}><span className="step-number">{index < stepIndex ? <Check size={14} /> : String(index + 1).padStart(2, '0')}</span><span>{t(`steps.${item}.label`)}</span>{index < 5 && <span className="step-connector" />}</button>)}
      </nav>
      {error && <div className="alert error" role="alert"><TriangleAlert size={18} /><span>{uiText(error)}</span><button aria-label={t('app.dismissError')} onClick={() => setError('')}><X size={16} /></button></div>}
      {busy && <div className="busy-banner" role="status"><LoaderCircle size={18} className="spin" /><span>{uiText(busy)}</span><button className="text-button" onClick={() => cancelTask.current?.()}>{t('app.cancel')}</button></div>}
      <input className="visually-hidden" ref={fileInput} type="file" accept=".gpx,.kml,application/gpx+xml,application/vnd.google-earth.kml+xml" onChange={handleFile} aria-label={t('app.chooseRouteFile')} />
      {step === 'import' ? <ImportLanding

        busy={!!busy}
        draftName={draft?.editor.name ?? null}
        onChooseFile={() => fileInput.current?.click()}
        onFileDrop={file => { void importFile(file); }}
        onRestoreDraft={restoreDraft}
      /> : editor && <section className="editor-layout">
        <aside className="editor-panel">
          <div className="panel-heading"><span className="panel-kicker">{String(stepIndex + 1).padStart(2,'0')} / {t('app.prepareYourRoute')}</span><h2>{t(`steps.${step}.label`)}</h2><p className="muted">{t(`steps.${step}.description`)}</p></div>
          <fieldset className="panel-body" disabled={!!busy}>
            {step === 'route' && <>
              <label className="field"><span>{t('app.routeName')}</span><input value={editor.name} onChange={e => edit(p => ({...p,name:e.target.value}))} /></label>
              <div className="source-file"><FileUp size={17} /><span>{editor.file.fileName}<small>{t('app.sourcePointCount', { count: editor.file.routes[editor.sourceIndex].points.length })}</small></span></div>
              {editor.file.routes.length > 1 && <label className="field"><span>{t('app.continuousRouteSegment')}</span><select value={editor.sourceIndex} onChange={e => confirmRebuild(Number(e.target.value),false,0)}>{editor.file.routes.map((r,i)=><option key={r.id} value={i}>{t('app.segmentOption', { name: r.name, count: r.points.length })}</option>)}</select><small>{t('app.segmentsAreNeverJoinedAutomatically')}</small></label>}
              <div className="section-label">{t('app.travelDirection')}</div><div className="direction-card"><Flag size={18} /><span>{editor.reverse ? t('app.reversedFromSource') : t('app.asRecordedInSource')}<small>{km(totalM)} km · {editor.reference.isClosed ? t('app.closedLoop') : t('app.openRoute')}</small></span><button className="icon-button" aria-label={t('app.reverseRoute')} onClick={() => confirmRebuild(editor.sourceIndex,!editor.reverse,editor.startIndex)}><RotateCcw size={19} /></button></div>
              {editor.reference.isClosed && <button className="button button-secondary full-width" disabled={cursorS === null} onClick={() => { const point=editor.reference.points.reduce((a,b)=>Math.abs(a.s-(cursorS??0))<Math.abs(b.s-(cursorS??0))?a:b); confirmRebuild(editor.sourceIndex,editor.reverse,point.sourceIndex??0); }}><Flag size={16} />{t('app.setCursorPositionAsStart')}</button>}
              <details className="advanced"><summary><SlidersHorizontal size={15}/>{t('app.geometrySettings')}<ChevronDown size={14}/></summary><label className="field"><span>{t('app.simplificationToleranceM')}</span><input type="number" min="0" max="50" step="0.5" value={editor.options.geometryToleranceM} onChange={e=>editOptions({geometryToleranceM:Number(e.target.value)})}/><small>{t('app.referenceDistancesStayUnchanged')}</small></label></details>
              <label className="check-field"><input type="checkbox" checked={confirmedRoute} onChange={e=>setConfirmedRoute(e.target.checked)}/><span>{t('app.iHaveCheckedTheRouteAndDirectionOn')}</span></label>
              {editor.file.warnings.map((warning,i)=><div className="inline-note" key={i}><TriangleAlert size={15}/>{typeof warning === 'string' ? warning : message(warning)}</div>)}
            </>}
            {step === 'stations' && <>
              <div className="section-toolbar"><span>{t('app.alongRouteCount', { count: sortedStations.length })}</span><button className="button button-small" onClick={addStation}><Plus size={15}/>{t('app.add')}</button></div>
              <p className="small muted">{t('app.tapTheMapOrProfileToPlaceThe')}</p>
              {unresolved > 0 && <div className="inline-note warning"><TriangleAlert size={15}/>{t('app.unconfirmedCount', { count: unresolved })}</div>}
              <div className="station-list">{sortedStations.map((station,i)=><button key={station.id} className={'station-row '+(selectedStationId===station.id?'selected':'')} onClick={()=>{setSelectedStationId(station.id);setCursorS(station.s);}}><span className={'station-pin '+(station.kind<2?'endpoint':'')}>{station.kind<2?<Flag size={12}/>:i}</span><span className="station-label"><strong>{station.name}</strong><small>{km(station.s)} km {station.stageBoundary?'· '+t('app.stageBoundary'):''}</small></span>{!station.confirmed?<TriangleAlert size={15} className="warning-text"/>:<Check size={14} className="muted"/>}</button>)}</div>
              {selected && <div className="station-editor"><div className="section-toolbar"><strong>{t('app.editStation')}</strong>{selected.kind>1&&<button className="icon-button danger" aria-label={t('app.deleteStation')} onClick={()=>{edit(e=>({...e,stations:e.stations.filter(s=>s.id!==selected.id)}));setSelectedStationId(null);}}><Trash2 size={15}/></button>}</div>
                <label className="field"><span>{t('app.name')}</span><input value={selected.name} onChange={e=>editStation({name:e.target.value})}/></label>
                <div className="field-pair"><label className="field"><span>{t('app.shortLabel')}</span><input value={selected.shortLabel} onChange={e=>editStation({shortLabel:e.target.value})}/></label><label className="field"><span>{t('app.type')}</span><select value={selected.kind} disabled={selected.kind<2} onChange={e=>editStation({kind:Number(e.target.value) as DraftStation['kind']})}>{selected.kind<2?<option value={selected.kind}>{selected.kind===0?t('app.start'):t('app.finish')}</option>:<><option value={2}>{t('app.checkpoint')}</option><option value={3}>{t('app.water')}</option><option value={4}>{t('app.pointOfInterest')}</option></>}</select></label></div>
                <label className="field"><span>{t('app.alongRouteDistanceM')}</span><input type="number" min="0" max={totalM} step="0.1" disabled={selected.kind<2} value={Number(selected.s.toFixed(1))} onChange={e=>editStation({s:Math.min(totalM,Math.max(0,Number(e.target.value))),confirmed:false})}/></label>
                {selected.kind>1&&<button className="text-button" disabled={cursorS===null} onClick={()=>editStation({s:Math.min(totalM,Math.max(0,cursorS??selected.s)),confirmed:true})}>{t('app.useCursorPosition')} {cursorS===null?'':km(cursorS)+' km'}<ArrowRight size={14}/></button>}
                {selected.candidates.length>1&&<div className="candidate-list"><p className="section-label">{t('app.possibleVisits')}</p>{selected.candidates.map((candidate,i)=><button key={i} className={'candidate '+(Math.abs(candidate.s-selected.s)<1?'chosen':'')} onClick={()=>{editStation({s:candidate.s,confirmed:true});setCursorS(candidate.s);}}><span>{km(candidate.s)} km</span><small>{t('app.landmarkOffset', { distance: number(Math.round(candidate.distanceM)) })}</small></button>)}</div>}
                <label className="check-field"><input type="checkbox" disabled={selected.kind<2} checked={selected.stageBoundary} onChange={e=>editStation({stageBoundary:e.target.checked})}/><span>{t('app.splitStagesAtThisStation')}</span></label>
                {selected.kind>1&&!selected.confirmed&&<button className="button button-primary full-width" onClick={()=>editStation({confirmed:true})}><Check size={16}/>{t('app.confirmThisVisit')}</button>}
                <details className="advanced"><summary>{t('app.landmarkCoordinates')}<ChevronDown size={14}/></summary><p className="small muted">{t('app.thePhysicalLandmarkMayBeBesideTheRoute')}</p><div className="field-pair"><label className="field"><span>{t('app.latitude')}</span><input type="number" step="0.0000001" value={selected.lat} onChange={e=>editStation({lat:Number(e.target.value)})}/></label><label className="field"><span>{t('app.longitude')}</span><input type="number" step="0.0000001" value={selected.lon} onChange={e=>editStation({lon:Number(e.target.value)})}/></label></div></details>
              </div>}
            </>}
            {step === 'elevation' && <>
              <div className="inline-note"><Mountain size={18}/><span>{t('app.missingElevationCount', { count: editor.reference.points.filter(p=>p.elevation===null).length })}</span></div>
              <fieldset className="radio-cards"><legend>{t('app.elevationInTheExportedRoute')}</legend>{(['omit','source','interpolate'] as const).map((mode,i)=><label className={'radio-card '+(editor.options.elevationMode===mode?'selected':'')} key={mode}><input type="radio" name="elevation" value={mode} checked={editor.options.elevationMode===mode} onChange={()=>editOptions({elevationMode:mode})}/><span><strong>{[t('app.routeGeometryOnly'),t('app.useSourceElevation'),t('app.fillShortInteriorGaps')][i]}</strong><small>{[t('app.exportWithoutElevationOrClimbStatistics'),t('app.requiresACompleteUsableProfile'),t('app.interpolateGapsUpTo100MNoEndpoint')][i]}</small></span></label>)}</fieldset>
              {editor.reference.elevationUncertain&&editor.options.elevationMode!=='omit'&&<label className="check-field caution"><input type="checkbox" checked={editor.options.acceptUncertainElevation} onChange={e=>editOptions({acceptUncertainElevation:e.target.checked})}/><span>{t('app.iAcceptTheSourceSUncertainElevationReference')}</span></label>}
              {editor.options.elevationMode!=='omit'&&<><label className="field"><span>{t('app.samplingIntervalM')}</span><select value={editor.options.elevationIntervalM} onChange={e=>editOptions({elevationIntervalM:Number(e.target.value)})}>{[5,10,20,50].map(n=><option key={n} value={n}>{n} m</option>)}</select></label><label className="field"><span>{t('app.smoothingWindowM')}</span><select value={editor.options.smoothingWindowM} onChange={e=>editOptions({smoothingWindowM:Number(e.target.value)})}><option value={0}>{t('app.offPreserveSourceShape')}</option>{[10,30,50].map(n=><option key={n} value={n}>{n} m</option>)}</select><small>{t('app.smoothingChangesCalculatedAscentAndDescentCompareThe')}</small></label></>}
              {route?.elev&&<label className="check-field"><input type="checkbox" checked={compareSource} onChange={e=>setCompareSource(e.target.checked)}/><span>{t('app.compareOriginalElevation')}</span></label>}<div className="info-card"><ShieldCheck size={18}/><p>{t('app.noElevationIsBetterThanInventedElevationUnknown')}</p></div>
            </>}
            {step === 'preview' && <>
              <div className="review-summary"><span className="summary-icon"><Route size={24}/></span><h3>{editor.name}</h3><p>{km(totalM)} km · {t('common.stationCount', { count: editor.stations.length })}</p></div>
              <p className="small muted">{t('app.moveTheDistanceCursorToInspectTheSame')}</p>
              <label className="field"><span>{t('app.distanceCursor')}<strong>{km(cursorS??0)} km</strong></span><input type="range" min="0" max={totalM} step="1" value={cursorS??0} onChange={e=>setCursorS(Number(e.target.value))}/></label>
              <StageList stations={sortedStations} route={route} onSelectDistance={setCursorS} />
              <button className="button button-secondary full-width" onClick={exportReport}><ArrowDownToLine size={16}/>{t('app.downloadQualityReport')}</button>
            </>}
            {step === 'export' && <>
              <div className={'export-status '+(ready?'valid':'')}><span>{ready?<ShieldCheck size={30}/>:<TriangleAlert size={30}/>}</span><h3>{ready?t('app.readyForTheTrail'):t('app.aFewDetailsToResolve')}</h3><p>{ready?t('app.yourRouteIsReadyForFinalEncodingAnd'):t('app.resolveTheIssuesBelowBeforeDownloadingYourRoute')}</p></div>
              {!confirmedRoute&&<button className="button button-secondary full-width" onClick={()=>go('route')}>{t('app.confirmRouteAndDirectionFirst')}<ArrowRight size={15}/></button>}<dl className="export-details"><div><dt>{t('app.format')}</dt><dd>TRL-X Route 1.0</dd></div><div><dt>{t('app.revision')}</dt><dd>{currentRevision}</dd></div><div><dt>{t('app.geometryNodes')}</dt><dd>{route ? number(route.geom.length) : '—'}</dd></div><div><dt>{t('app.elevationNodes')}</dt><dd>{route?.elev ? number(route.elev.length) : t('app.notIncluded')}</dd></div><div><dt>{t('app.estimatedSize')}</dt><dd>{route?'~ '+size(estimateBytes):'—'}</dd></div></dl>
              <button className="button button-primary full-width export-button" disabled={!ready} onClick={()=>void exportRoute()}><ArrowDownToLine size={18}/>{t('app.downloadRte')}</button>
              {exported&&<div className="success-card"><CheckCircle2 size={20}/><span><strong>{exported.filename}</strong><small>{t('app.exportDetails', { size: size(exported.bytes), revision: number(exported.revision) })}</small></span></div>}
              <button className="text-button full-width" onClick={exportReport}>{t('app.downloadProcessingReport')}<ArrowDownToLine size={14}/></button>
              <p className="small muted">{t('app.theFileIsDecodedAndFullyValidatedBefore')}</p>
            </>}
            <IssuesList issues={issues} onLocate={s => { setCursorS(s); setMobileView('map'); }} />
          </fieldset>
          <div className="panel-footer"><button className="button button-ghost" disabled={!!busy} onClick={()=>go(STEPS[Math.max(0,stepIndex-1)])}><ArrowLeft size={16}/>{t('app.back')}</button>{stepIndex<5&&<button className="button button-primary" disabled={!!busy||(step==='route'&&!confirmedRoute)} onClick={()=>go(STEPS[stepIndex+1])}>{t('app.continue')}<ArrowRight size={16}/></button>}</div>
        </aside>
        <div className={'visual-workspace mobile-'+mobileView}>
          <div className="workspace-toolbar"><div className="view-switch"><button className={mobileView==='map'?'active':''} onClick={()=>setMobileView('map')}><MapPinned size={15}/>{t('app.map')}</button><button className={mobileView==='profile'?'active':''} onClick={()=>setMobileView('profile')}><Mountain size={15}/>{t('app.profile')}</button></div><span className="processing-label">{processing?<><LoaderCircle size={13} className="spin"/>{t('app.updating')}</>:<><span className="status-dot"/>{t('app.linkedPreview')}</>}</span><button className={'button button-small basemap-toggle '+(basemap?'on':'')} onClick={()=>setBasemap(!basemap)} aria-pressed={basemap}><Layers size={15}/>{t('app.basemap')}</button></div>
          <div className="map-panel"><Suspense fallback={<div className="map-loading"><LoaderCircle className="spin"/>{t('app.loadingMap')}</div>}><RouteMap reference={editor.reference} stations={editor.stations} selectedStationId={selectedStationId} cursorS={cursorS} onCursorChange={setCursorS} onStationSelect={selectStation} onRouteClick={setCursorS} basemap={basemap}/></Suspense></div>
          <div className="stats-strip"><div><span>{t('app.distance')}</span><strong>{km(totalM)}<small> km</small></strong></div><div><span>{t('app.ascent')}</span><strong>{lastElev?number(Math.round(lastElev.upDm/10)):'—'}<small>{lastElev?' m':''}</small></strong></div><div><span>{t('app.descent')}</span><strong>{lastElev?number(Math.round(lastElev.downDm/10)):'—'}<small>{lastElev?' m':''}</small></strong></div><div><span>{t('app.stationsLabel')}</span><strong>{editor.stations.length.toString().padStart(2,'0')}</strong></div></div>
          <div className="profile-panel"><ElevationChart reference={editor.reference} route={route} stations={editor.stations} cursorS={cursorS} onCursorChange={setCursorS} onStationSelect={selectStation} compareSource={compareSource}/></div>
        </div>
      </section>}
      <footer className="page-footer"><span>TRL-X ROUTE STUDIO <span>·</span> {t('app.madeForTheMilesAhead')}</span><span><ShieldCheck size={13}/>{t('app.onDeviceProcessing')}<span> / </span>GPX + KML → RTE</span></footer>
    </main>
    {notice&&<div className="toast" role="status"><CheckCircle2 size={18}/>{uiText(notice)}</div>}
    <Dialog.Root open={!!dialog} onOpenChange={open=>{if(!open)setDialog(null);}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="dialog-content"><Dialog.Title>{dialog && uiText(dialog.title)}</Dialog.Title><Dialog.Description>{dialog && uiText(dialog.body)}</Dialog.Description><div className="dialog-actions"><Dialog.Close asChild><button className="button button-secondary">{t('app.keepEditing')}</button></Dialog.Close><button className="button button-primary" onClick={()=>{const run=dialog?.run;setDialog(null);run?.();}}>{t('app.rebuildRoute')}</button></div><Dialog.Close className="dialog-close" aria-label={t('app.close')}><X size={18}/></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
