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
type Language = 'en' | 'zh';
type Editor = {
  file: ImportedFile; reference: ReferenceRoute; stations: DraftStation[];
  options: ProcessingOptions; name: string; routeId: Uint8Array; inputSha256: Uint8Array;
  sourceIndex: number; reverse: boolean; startIndex: number;
};
type Ledger = Record<string, { revision: number; hash: string }>;
type Draft = { version: 1 | 2; editor: Editor; ledger: Ledger; savedAt: number };
const DEFAULT_OPTIONS: ProcessingOptions = { geometryToleranceM: 2, elevationIntervalM: 10, smoothingWindowM: 0, elevationMode: 'omit', acceptUncertainElevation: false };
const stepLabels: Record<Language, string[]> = { en: ['Import', 'Route', 'Stations', 'Elevation', 'Review', 'Export'], zh: ['导入', '路线', '站点', '高程', '预览', '导出'] };
const stepDescriptions: Record<Language, string[]> = {
  en: ['Start with your route file', 'Make sure the direction is right', 'Every stop, in the right order', 'Make the ups and downs count', 'One last look before you go', 'Your route, ready for the trail'],
  zh: ['从一份路线文件开始', '确认路线、起点与前进方向', '让每一站对应正确的经过位置', '检查沿途的每一次起伏', '出发前，再检查一次', '准备好属于你的路线'],
};
const hex = (bytes: Uint8Array) => Array.from(bytes, v => v.toString(16).padStart(2, '0')).join('');
const km = (m: number) => (m / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const size = (bytes: number) => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : (bytes / 1024).toFixed(1) + ' KB';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
async function digest(bytes: Uint8Array) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))); }
function download(bytes: Uint8Array, filename: string, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export default function App() {
  const [language, setLanguage] = useState<Language>(() => navigator.language.startsWith('zh') ? 'zh' : 'en');
  const tr = (en: string, zh: string) => language === 'zh' ? zh : en;
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

  useEffect(() => { document.documentElement.lang = language; }, [language]);
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
    if (!/\.(gpx|kml)$/i.test(file.name)) { setError(tr('Choose a GPX or KML route file.', '请选择 GPX 或 KML 路线文件。')); return; }
    if (file.size > 20 * 1024 * 1024) { setError(tr('The file limit is 20 MB. Choose a smaller file.', '文件大小上限为 20 MB，请选择更小的文件。')); return; }
    fileBusy.current = true; setBusy(tr('Reading your route…', '正在读取路线…'));
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
    setBusy(tr('Rebuilding distance and station order…', '正在重建里程与站点顺序…')); setError('');
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
    setDialog({ title: tr('Rebuild this route?', '重新建立路线？'), body: tr('Distances and station positions will be recalculated. Station edits will reset to the imported landmarks. You can undo this change.', '里程与站点位置将重新计算，站点编辑将重置为导入的地标。可以通过撤销恢复。'), run: () => { void rebuild(sourceIndex, reverse, startIndex); } });
  }
  function addStation() {
    if (!editor) return;
    const s = Math.max(0, Math.min(totalM, cursorS ?? totalM / 2)), point = positionAt(editor.reference, s);
    const id = Math.max(...editor.stations.map(s => s.id)) + 1;
    edit(e => ({ ...e, stations: [...e.stations, { id, name: tr('New checkpoint', '新检查点'), shortLabel: 'CP' + id, kind: 2, stageBoundary: true, s, lat: point.lat, lon: point.lon, confirmed: true, candidates: [] }] }));
    setSelectedStationId(id);
  }
  function restoreDraft() {
    if (!draft) return;
    setEditor(draft.editor); setLedger(draft.ledger ?? {}); setHistory([]); setDraft(null); setConfirmedRoute(false); setCursorS(0); send({ type: 'ROUTE' });
  }
  async function exportRoute() {
    if (!editor || !route || !ready || fileBusy.current) return;
    fileBusy.current = true;
    setError(''); setBusy(tr('Encoding and checking every section…', '正在编码并校验每个数据段…'));
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
      setNotice(persisted ? tr('Your validated route file is ready.', '已生成并校验路线文件。') : tr('Local storage is unavailable. Exported with a new route identity.', '本地存储不可用，本次已使用新的路线标识导出。'));
    } catch (e) { if (!aborted(e)) setError(errorText(e)); }
    finally { setBusy(''); cancelTask.current = null; fileBusy.current = false; }
  }
  function exportReport() {
    if (!editor) return;
    const report = { name: editor.name, source: editor.file.fileName, routeId: exported?.routeId ?? hex(editor.routeId), revision: exported?.revision ?? currentRevision, parameters: editor.options, totalDistanceM: totalM, issues, stationCount: editor.stations.length, inputSha256: hex(editor.inputSha256) };
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
        <span className="local-badge"><span className="status-dot" />{tr('Local-first workspace', '本地路线工作台')}</span>
        <button className="language-button" onClick={() => setLanguage(language === 'en' ? 'zh' : 'en')} aria-label={tr('切换中文', 'Switch to English')}><Globe2 size={16} />{language === 'en' ? 'EN' : '中文'}</button>
        <span className="version-badge">V1.0</span>
      </div>
    </header>
    <main className="main-shell">
      <section className="title-row">
        <div><p className="eyebrow"><span className="tiny-line" />{tr('FROM FILE TO FINISH LINE', '从路线文件，到下一次出发')}</p><h1>{editor && step !== 'import' ? editor.name : tr('A better route starts here.', '下一段好路线，从这里开始。')}</h1><p className="page-description">{editor && step !== 'import' ? tr('Refine the details. Keep the adventure.', '确认每一处细节，专注接下来的旅程。') : tr('Turn your GPX or KML into a trail-ready route. One thoughtful step at a time.', '导入 GPX 或 KML，逐步确认细节，生成可以安心使用的路线。')}</p></div>
        {editor && <div className="document-actions"><span className="save-status">{saved === 'saved' ? <Check size={14} /> : saved === 'saving' ? <LoaderCircle size={14} className="spin" /> : <Circle size={12} />}{saved === 'saved' ? tr('Saved on this device', '已保存在此设备') : saved === 'failed' ? tr('Local save unavailable', '本地保存不可用') : tr('Saving…', '保存中…')}</span><button className="button button-ghost" disabled={!history.length || !!busy} onClick={() => { const previous = history.at(-1); if (previous) { setEditor(previous); setHistory(history.slice(0,-1)); setConfirmedRoute(false); } }}><Undo2 size={16} />{tr('Undo', '撤销')}</button></div>}
      </section>
      <nav className="stepper" aria-label={tr('Route preparation steps', '路线处理步骤')}>
        {STEPS.map((item, index) => <button key={item} className={'step ' + (step === item ? 'active' : '') + (index < stepIndex ? ' visited' : '')} disabled={(!editor && index > 0) || !!busy} onClick={() => go(item)} aria-current={step === item ? 'step' : undefined}><span className="step-number">{index < stepIndex ? <Check size={14} /> : String(index + 1).padStart(2, '0')}</span><span>{stepLabels[language][index]}</span>{index < 5 && <span className="step-connector" />}</button>)}
      </nav>
      {error && <div className="alert error" role="alert"><TriangleAlert size={18} /><span>{error}</span><button aria-label={tr('Dismiss error', '关闭错误')} onClick={() => setError('')}><X size={16} /></button></div>}
      {busy && <div className="busy-banner" role="status"><LoaderCircle size={18} className="spin" /><span>{busy}</span><button className="text-button" onClick={() => cancelTask.current?.()}>{tr('Cancel', '取消')}</button></div>}
      <input className="visually-hidden" ref={fileInput} type="file" accept=".gpx,.kml,application/gpx+xml,application/vnd.google-earth.kml+xml" onChange={handleFile} aria-label={tr('Choose route file', '选择路线文件')} />
      {step === 'import' ? <ImportLanding
        language={language}
        busy={!!busy}
        draftName={draft?.editor.name ?? null}
        onChooseFile={() => fileInput.current?.click()}
        onFileDrop={file => { void importFile(file); }}
        onRestoreDraft={restoreDraft}
      /> : editor && <section className="editor-layout">
        <aside className="editor-panel">
          <div className="panel-heading"><span className="panel-kicker">{String(stepIndex + 1).padStart(2,'0')} / {tr('PREPARE YOUR ROUTE', '准备你的路线')}</span><h2>{stepLabels[language][stepIndex]}</h2><p className="muted">{stepDescriptions[language][stepIndex]}</p></div>
          <fieldset className="panel-body" disabled={!!busy}>
            {step === 'route' && <>
              <label className="field"><span>{tr('Route name', '路线名称')}</span><input value={editor.name} onChange={e => edit(p => ({...p,name:e.target.value}))} /></label>
              <div className="source-file"><FileUp size={17} /><span>{editor.file.fileName}<small>{editor.file.routes[editor.sourceIndex].points.length.toLocaleString()} {tr('source points', '原始点')}</small></span></div>
              {editor.file.routes.length > 1 && <label className="field"><span>{tr('Continuous route segment', '连续路线段')}</span><select value={editor.sourceIndex} onChange={e => confirmRebuild(Number(e.target.value),false,0)}>{editor.file.routes.map((r,i)=><option key={r.id} value={i}>{r.name} · {r.points.length} pts</option>)}</select><small>{tr('Segments are never joined automatically.', '不会自动连接不连续的路线段。')}</small></label>}
              <div className="section-label">{tr('TRAVEL DIRECTION', '前进方向')}</div><div className="direction-card"><Flag size={18} /><span>{editor.reverse ? tr('Reversed from source', '与源文件方向相反') : tr('As recorded in source', '使用源文件方向')}<small>{km(totalM)} km · {editor.reference.isClosed ? tr('closed loop', '闭合环线') : tr('open route', '开放路线')}</small></span><button className="icon-button" aria-label={tr('Reverse route', '反转路线')} onClick={() => confirmRebuild(editor.sourceIndex,!editor.reverse,editor.startIndex)}><RotateCcw size={19} /></button></div>
              {editor.reference.isClosed && <button className="button button-secondary full-width" disabled={cursorS === null} onClick={() => { const point=editor.reference.points.reduce((a,b)=>Math.abs(a.s-(cursorS??0))<Math.abs(b.s-(cursorS??0))?a:b); confirmRebuild(editor.sourceIndex,editor.reverse,point.sourceIndex??0); }}><Flag size={16} />{tr('Set cursor position as start', '将游标位置设为起点')}</button>}
              <details className="advanced"><summary><SlidersHorizontal size={15}/>{tr('Geometry settings', '几何设置')}<ChevronDown size={14}/></summary><label className="field"><span>{tr('Simplification tolerance (m)', '简化容差（米）')}</span><input type="number" min="0" max="50" step="0.5" value={editor.options.geometryToleranceM} onChange={e=>editOptions({geometryToleranceM:Number(e.target.value)})}/><small>{tr('Reference distances stay unchanged.', '基准里程保持不变。')}</small></label></details>
              <label className="check-field"><input type="checkbox" checked={confirmedRoute} onChange={e=>setConfirmedRoute(e.target.checked)}/><span>{tr('I have checked the route and direction on the map.', '我已在地图上检查路线与方向。')}</span></label>
              {editor.file.warnings.map((warning,i)=><div className="inline-note" key={i}><TriangleAlert size={15}/>{warning}</div>)}
            </>}
            {step === 'stations' && <>
              <div className="section-toolbar"><span>{sortedStations.length} {tr('stations along the route', '个沿线站点')}</span><button className="button button-small" onClick={addStation}><Plus size={15}/>{tr('Add', '添加')}</button></div>
              <p className="small muted">{tr('Tap the map or profile to place the cursor. Select a station to edit its visit.', '轻点地图或剖面移动游标，选择站点编辑经过位置。')}</p>
              {unresolved > 0 && <div className="inline-note warning"><TriangleAlert size={15}/>{unresolved} {tr('station positions need your confirmation.', '个站点的位置需要确认。')}</div>}
              <div className="station-list">{sortedStations.map((station,i)=><button key={station.id} className={'station-row '+(selectedStationId===station.id?'selected':'')} onClick={()=>{setSelectedStationId(station.id);setCursorS(station.s);}}><span className={'station-pin '+(station.kind<2?'endpoint':'')}>{station.kind<2?<Flag size={12}/>:i}</span><span className="station-label"><strong>{station.name}</strong><small>{km(station.s)} km {station.stageBoundary?'· '+tr('stage boundary','阶段边界'):''}</small></span>{!station.confirmed?<TriangleAlert size={15} className="warning-text"/>:<Check size={14} className="muted"/>}</button>)}</div>
              {selected && <div className="station-editor"><div className="section-toolbar"><strong>{tr('Edit station', '编辑站点')}</strong>{selected.kind>1&&<button className="icon-button danger" aria-label={tr('Delete station', '删除站点')} onClick={()=>{edit(e=>({...e,stations:e.stations.filter(s=>s.id!==selected.id)}));setSelectedStationId(null);}}><Trash2 size={15}/></button>}</div>
                <label className="field"><span>{tr('Name', '名称')}</span><input value={selected.name} onChange={e=>editStation({name:e.target.value})}/></label>
                <div className="field-pair"><label className="field"><span>{tr('Short label', '短标签')}</span><input value={selected.shortLabel} onChange={e=>editStation({shortLabel:e.target.value})}/></label><label className="field"><span>{tr('Type', '类型')}</span><select value={selected.kind} disabled={selected.kind<2} onChange={e=>editStation({kind:Number(e.target.value) as DraftStation['kind']})}>{selected.kind<2?<option value={selected.kind}>{selected.kind===0?tr('Start','起点'):tr('Finish','终点')}</option>:<><option value={2}>{tr('Checkpoint','检查点')}</option><option value={3}>{tr('Water','补水点')}</option><option value={4}>{tr('Point of interest','兴趣点')}</option></>}</select></label></div>
                <label className="field"><span>{tr('Along-route distance (m)', '沿线里程（米）')}</span><input type="number" min="0" max={totalM} step="0.1" disabled={selected.kind<2} value={Number(selected.s.toFixed(1))} onChange={e=>editStation({s:Math.min(totalM,Math.max(0,Number(e.target.value))),confirmed:false})}/></label>
                {selected.kind>1&&<button className="text-button" disabled={cursorS===null} onClick={()=>editStation({s:Math.min(totalM,Math.max(0,cursorS??selected.s)),confirmed:true})}>{tr('Use cursor position', '使用游标位置')} {cursorS===null?'':km(cursorS)+' km'}<ArrowRight size={14}/></button>}
                {selected.candidates.length>1&&<div className="candidate-list"><p className="section-label">{tr('POSSIBLE VISITS', '可能的经过位置')}</p>{selected.candidates.map((candidate,i)=><button key={i} className={'candidate '+(Math.abs(candidate.s-selected.s)<1?'chosen':'')} onClick={()=>{editStation({s:candidate.s,confirmed:true});setCursorS(candidate.s);}}><span>{km(candidate.s)} km</span><small>{candidate.distanceM.toFixed(0)} m {tr('from landmark','距地标')}</small></button>)}</div>}
                <label className="check-field"><input type="checkbox" disabled={selected.kind<2} checked={selected.stageBoundary} onChange={e=>editStation({stageBoundary:e.target.checked})}/><span>{tr('Split stages at this station', '在此站点划分阶段')}</span></label>
                {selected.kind>1&&!selected.confirmed&&<button className="button button-primary full-width" onClick={()=>editStation({confirmed:true})}><Check size={16}/>{tr('Confirm this visit', '确认此次经过')}</button>}
                <details className="advanced"><summary>{tr('Landmark coordinates', '地标实际坐标')}<ChevronDown size={14}/></summary><p className="small muted">{tr('The physical landmark may be beside the route.', '地标可以位于路线旁，与沿线位置分别保存。')}</p><div className="field-pair"><label className="field"><span>{tr('Latitude','纬度')}</span><input type="number" step="0.0000001" value={selected.lat} onChange={e=>editStation({lat:Number(e.target.value)})}/></label><label className="field"><span>{tr('Longitude','经度')}</span><input type="number" step="0.0000001" value={selected.lon} onChange={e=>editStation({lon:Number(e.target.value)})}/></label></div></details>
              </div>}
            </>}
            {step === 'elevation' && <>
              <div className="inline-note"><Mountain size={18}/><span>{editor.reference.points.filter(p=>p.elevation===null).length} {tr('reference points have unknown elevation.', '个基准点缺少可用高程。')}</span></div>
              <fieldset className="radio-cards"><legend>{tr('Elevation in the exported route', '导出文件中的高程')}</legend>{(['omit','source','interpolate'] as const).map((mode,i)=><label className={'radio-card '+(editor.options.elevationMode===mode?'selected':'')} key={mode}><input type="radio" name="elevation" value={mode} checked={editor.options.elevationMode===mode} onChange={()=>editOptions({elevationMode:mode})}/><span><strong>{[tr('Route geometry only','仅路线几何'),tr('Use source elevation','使用源文件高程'),tr('Fill short interior gaps','补全内部短缺口')][i]}</strong><small>{[tr('Export without elevation or climb statistics.','导出不含高程及爬升统计的路线。'),tr('Requires a complete, usable profile.','需要完整、可用的高程剖面。'),tr('Interpolate gaps up to 100 m. No endpoint extrapolation.','插值补全不超过 100 米的缺口，不外推端点。')][i]}</small></span></label>)}</fieldset>
              {editor.reference.elevationUncertain&&editor.options.elevationMode!=='omit'&&<label className="check-field caution"><input type="checkbox" checked={editor.options.acceptUncertainElevation} onChange={e=>editOptions({acceptUncertainElevation:e.target.checked})}/><span>{tr('I accept the source’s uncertain elevation reference. It will be recorded as unknown.', '我接受源文件高程基准不确定，导出时会记录为未知。')}</span></label>}
              {editor.options.elevationMode!=='omit'&&<><label className="field"><span>{tr('Sampling interval (m)', '采样间隔（米）')}</span><select value={editor.options.elevationIntervalM} onChange={e=>editOptions({elevationIntervalM:Number(e.target.value)})}>{[5,10,20,50].map(n=><option key={n} value={n}>{n} m</option>)}</select></label><label className="field"><span>{tr('Smoothing window (m)', '平滑窗口（米）')}</span><select value={editor.options.smoothingWindowM} onChange={e=>editOptions({smoothingWindowM:Number(e.target.value)})}><option value={0}>{tr('Off · preserve source shape','关闭 · 保留源剖面形状')}</option>{[10,30,50].map(n=><option key={n} value={n}>{n} m</option>)}</select><small>{tr('Smoothing changes calculated ascent and descent. Compare the profile before exporting.', '平滑会改变累计升降，请对比剖面后再导出。')}</small></label></>}
              {route?.elev&&<label className="check-field"><input type="checkbox" checked={compareSource} onChange={e=>setCompareSource(e.target.checked)}/><span>{tr('Compare original elevation','对比原始高程')}</span></label>}<div className="info-card"><ShieldCheck size={18}/><p>{tr('No elevation is better than invented elevation. Unknown sections are never exported as flat terrain.', '缺少高程也能使用路线。未知区间不会被当作平地写入文件。')}</p></div>
            </>}
            {step === 'preview' && <>
              <div className="review-summary"><span className="summary-icon"><Route size={24}/></span><h3>{editor.name}</h3><p>{km(totalM)} km · {editor.stations.length} {tr('stations','个站点')}</p></div>
              <p className="small muted">{tr('Move the distance cursor to inspect the same position on the map and elevation profile.', '移动里程游标，在地图与高程图上查看同一位置。')}</p>
              <label className="field"><span>{tr('Distance cursor', '里程游标')}<strong>{km(cursorS??0)} km</strong></span><input type="range" min="0" max={totalM} step="1" value={cursorS??0} onChange={e=>setCursorS(Number(e.target.value))}/></label>
              <StageList stations={sortedStations} route={route} language={language} onSelectDistance={setCursorS} />
              <button className="button button-secondary full-width" onClick={exportReport}><ArrowDownToLine size={16}/>{tr('Download quality report','下载质量报告')}</button>
            </>}
            {step === 'export' && <>
              <div className={'export-status '+(ready?'valid':'')}><span>{ready?<ShieldCheck size={30}/>:<TriangleAlert size={30}/>}</span><h3>{ready?tr('Ready for the trail.', '可以出发了。'):tr('A few details to resolve.', '还有细节需要处理。')}</h3><p>{ready?tr('Your route is ready for final encoding and validation.', '路线已准备好，可以进行最终编码与校验。'):tr('Resolve the issues below before downloading your route.', '处理下方问题后即可下载路线。')}</p></div>
              {!confirmedRoute&&<button className="button button-secondary full-width" onClick={()=>go('route')}>{tr('Confirm route and direction first','先确认路线与方向')}<ArrowRight size={15}/></button>}<dl className="export-details"><div><dt>{tr('Format','格式')}</dt><dd>TRL-X Route 1.0</dd></div><div><dt>{tr('Revision','版本')}</dt><dd>{currentRevision}</dd></div><div><dt>{tr('Geometry nodes','几何节点')}</dt><dd>{route?.geom.length.toLocaleString()??'—'}</dd></div><div><dt>{tr('Elevation nodes','高程节点')}</dt><dd>{route?.elev?.length.toLocaleString()??tr('Not included','不包含')}</dd></div><div><dt>{tr('Estimated size','预估大小')}</dt><dd>{route?'~ '+size(estimateBytes):'—'}</dd></div></dl>
              <button className="button button-primary full-width export-button" disabled={!ready} onClick={()=>void exportRoute()}><ArrowDownToLine size={18}/>{tr('Download .rte','下载 .rte')}</button>
              {exported&&<div className="success-card"><CheckCircle2 size={20}/><span><strong>{exported.filename}</strong><small>{size(exported.bytes)} · revision {exported.revision} · {tr('validated','校验通过')}</small></span></div>}
              <button className="text-button full-width" onClick={exportReport}>{tr('Download processing report','下载处理报告')}<ArrowDownToLine size={14}/></button>
              <p className="small muted">{tr('The file is decoded and fully validated before download. Repeated exports preserve its identity; changes receive a new revision.', '下载前会重新读取文件并完成校验。重复导出保留身份，内容变化生成新版本。')}</p>
            </>}
            <IssuesList issues={issues} language={language} onLocate={s => { setCursorS(s); setMobileView('map'); }} />
          </fieldset>
          <div className="panel-footer"><button className="button button-ghost" disabled={!!busy} onClick={()=>go(STEPS[Math.max(0,stepIndex-1)])}><ArrowLeft size={16}/>{tr('Back','上一步')}</button>{stepIndex<5&&<button className="button button-primary" disabled={!!busy||(step==='route'&&!confirmedRoute)} onClick={()=>go(STEPS[stepIndex+1])}>{tr('Continue','继续')}<ArrowRight size={16}/></button>}</div>
        </aside>
        <div className={'visual-workspace mobile-'+mobileView}>
          <div className="workspace-toolbar"><div className="view-switch"><button className={mobileView==='map'?'active':''} onClick={()=>setMobileView('map')}><MapPinned size={15}/>{tr('Map','地图')}</button><button className={mobileView==='profile'?'active':''} onClick={()=>setMobileView('profile')}><Mountain size={15}/>{tr('Profile','剖面')}</button></div><span className="processing-label">{processing?<><LoaderCircle size={13} className="spin"/>{tr('Updating…','更新中…')}</>:<><span className="status-dot"/>{tr('Linked preview','联动预览')}</>}</span><button className={'button button-small basemap-toggle '+(basemap?'on':'')} onClick={()=>setBasemap(!basemap)} aria-pressed={basemap}><Layers size={15}/>{tr('Basemap','底图')}</button></div>
          <div className="map-panel"><Suspense fallback={<div className="map-loading"><LoaderCircle className="spin"/>{tr('Loading map…','加载地图…')}</div>}><RouteMap reference={editor.reference} stations={editor.stations} selectedStationId={selectedStationId} cursorS={cursorS} onCursorChange={setCursorS} onStationSelect={selectStation} onRouteClick={setCursorS} language={language} basemap={basemap}/></Suspense></div>
          <div className="stats-strip"><div><span>{tr('DISTANCE','距离')}</span><strong>{km(totalM)}<small> km</small></strong></div><div><span>{tr('ASCENT','累计上升')}</span><strong>{lastElev?Math.round(lastElev.upDm/10).toLocaleString():'—'}<small>{lastElev?' m':''}</small></strong></div><div><span>{tr('DESCENT','累计下降')}</span><strong>{lastElev?Math.round(lastElev.downDm/10).toLocaleString():'—'}<small>{lastElev?' m':''}</small></strong></div><div><span>{tr('STATIONS','站点')}</span><strong>{editor.stations.length.toString().padStart(2,'0')}</strong></div></div>
          <div className="profile-panel"><ElevationChart reference={editor.reference} route={route} stations={editor.stations} cursorS={cursorS} onCursorChange={setCursorS} onStationSelect={selectStation} language={language} compareSource={compareSource}/></div>
        </div>
      </section>}
      <footer className="page-footer"><span>TRL-X ROUTE STUDIO <span>·</span> {tr('Made for the miles ahead.','为前方的每一公里。')}</span><span><ShieldCheck size={13}/>{tr('On-device processing','设备本地处理')}<span> / </span>GPX + KML → RTE</span></footer>
    </main>
    {notice&&<div className="toast" role="status"><CheckCircle2 size={18}/>{notice}</div>}
    <Dialog.Root open={!!dialog} onOpenChange={open=>{if(!open)setDialog(null);}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="dialog-content"><Dialog.Title>{dialog?.title}</Dialog.Title><Dialog.Description>{dialog?.body}</Dialog.Description><div className="dialog-actions"><Dialog.Close asChild><button className="button button-secondary">{tr('Keep editing','继续编辑')}</button></Dialog.Close><button className="button button-primary" onClick={()=>{const run=dialog?.run;setDialog(null);run?.();}}>{tr('Rebuild route','重新建立')}</button></div><Dialog.Close className="dialog-close" aria-label={tr('Close','关闭')}><X size={18}/></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
