import { availableLanguages } from './i18n';
import { useLocale } from './i18n/useLocale';
import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import type { ChangeEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  FileUp,
  Flag,
  Globe2,
  LoaderCircle,
  MapPinned,
  Maximize2,
  Minimize2,
  Mountain,
  Plus,
  RotateCcw,
  Route,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';
import { STEPS, type Step } from './app/flow';
import type { Editor } from './app/editor';
import { downloadQualityReport } from './app/route-files';
import { useEditorSession } from './app/useEditorSession';
import { useRouteFiles } from './app/useRouteFiles';
import { useRouteProcessing } from './app/useRouteProcessing';
import { positionAt } from './core/process';
import { utcToday } from './core/declination';
import { PROCESSING_CHOICES, PROCESSING_CONTROLS } from './core/policy';
import type { DraftStation, ProcessingIssue, ProcessingOptions } from './core/types';
import ElevationChart from './components/ElevationChart';
import ImportLanding from './features/import/ImportLanding';
import IssuesList from './features/review/IssuesList';
import { issueStage, issuesForStep } from './features/review/issue-visibility';
import StageList from './features/review/StageList';
import MagneticDeclinationFields from './components/MagneticDeclinationFields';

const RouteMap = lazy(() => import('./components/RouteMap'));

export default function App() {
  const { t, language, changeLanguage, number, km, message, uiText } = useLocale();
  const size = (bytes: number) =>
    number(bytes / (bytes >= 1048576 ? 1048576 : 1024), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }) + (bytes >= 1048576 ? ' MB' : ' KB');
  const session = useEditorSession();
  const { editor, saved, draft, canUndo, currentRevision } = session;
  const {
    result,
    processing,
    currentResult,
    declinationMode,
    declinationDate,
    declinationStatus,
    retryDeclination,
  } = useRouteProcessing(editor, session.setEditor, currentRevision);
  const files = useRouteFiles(session);
  const { busy, notice, exported } = files;
  const error = files.error || session.loadError;
  const clearError = () => {
    files.clearError();
    session.clearLoadError();
  };
  const [step, setStep] = useState<Step>('import');
  const stepIndex = STEPS.indexOf(step);
  const [selectedStationId, setSelectedStationId] = useState<number | null>(null);
  const [cursorS, setCursorS] = useState<number | null>(null);
  const [unlockedStep, setUnlockedStep] = useState(1);
  const [compareSource, setCompareSource] = useState(true);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [stackedPreview, setStackedPreview] = useState(false);
  const [activeView, setActiveView] = useState<'map' | 'profile'>('map');
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const showView = (view: 'map' | 'profile') => {
    setActiveView(view);
    setPreviewCollapsed(false);
  };
  const [confirmedRoute, setConfirmedRoute] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; body: string; run: () => void } | null>(
    null,
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const route = result?.route ?? null;
  const ready =
    declinationStatus !== 'loading' && !!route && currentResult && !busy && confirmedRoute;
  const sortedStations = editor
    ? [...editor.stations].sort((a, b) => a.s - b.s || a.id - b.id)
    : [];
  const selected = editor?.stations.find((station) => station.id === selectedStationId);
  const unresolved = editor?.stations.filter((station) => !station.confirmed).length ?? 0;
  const issues = result?.issues ?? editor?.reference.issues ?? [];
  const importIssues: ProcessingIssue[] = (editor?.file.warnings ?? []).map((warning) => ({
    ...warning,
    severity: 'warning',
  }));
  const totalM = editor?.reference.totalM ?? 0;
  const visibleIssues = editor
    ? issuesForStep([...issues, ...importIssues], step, editor.options)
    : [];
  const errors = issues.filter((issue) => issue.severity === 'error');
  const routeComplete =
    !!editor &&
    currentResult &&
    confirmedRoute &&
    !errors.some((issue) => !['stations', 'elevation'].includes(issueStage(issue, editor.options)));
  const stationsComplete =
    routeComplete &&
    unresolved === 0 &&
    !errors.some((issue) => issueStage(issue, editor?.options) === 'stations');
  const elevationComplete = stationsComplete && !!route && currentResult;
  const complete = [
    !!editor,
    routeComplete,
    stationsComplete,
    elevationComplete,
    elevationComplete,
    ready,
  ];
  const canGo = (next: Step) => {
    if (busy) return false;
    const target = STEPS.indexOf(next);
    if (target === 0) return true;
    if (!editor) return false;
    if (target <= stepIndex) return true;
    if (target > unlockedStep && target !== stepIndex + 1) return false;
    return complete.slice(0, target).every(Boolean);
  };
  const go = (next: Step) => {
    if (!canGo(next)) return;
    setUnlockedStep((previous) => Math.max(previous, STEPS.indexOf(next)));
    setStep(next);
    clearError();
  };

  useEffect(() => {
    setCursorS((previous) =>
      previous === null || !editor
        ? null
        : Math.min(editor.reference.totalM, Math.max(0, previous)),
    );
  }, [editor?.reference]);

  // Stack the map and profile only when the preview pane has room for both.
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const observer = new ResizeObserver(([entry]) =>
      setStackedPreview(entry.contentRect.height >= 600),
    );
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [!!editor, step]);

  function edit(update: (previous: Editor) => Editor) {
    if (files.isBusy()) return;
    const change = session.edit(update);
    if (!change) return;
    const { previous, next } = change;
    if (
      next.name !== previous.name ||
      next.reference !== previous.reference ||
      next.magneticDeclination !== previous.magneticDeclination ||
      next.declinationMode !== previous.declinationMode ||
      next.declinationQueryDate !== previous.declinationQueryDate ||
      next.options.geometryToleranceM !== previous.options.geometryToleranceM
    ) {
      setConfirmedRoute(false);
      setUnlockedStep(1);
    } else if (next.stations !== previous.stations) {
      setUnlockedStep((value) => Math.min(value, 2));
    } else if (next.options !== previous.options) {
      setUnlockedStep((value) => Math.min(value, 3));
    }
    clearError();
  }
  const editStation = (patch: Partial<DraftStation>) =>
    edit((previous) => ({
      ...previous,
      stations: previous.stations.map((station) =>
        station.id === selectedStationId ? { ...station, ...patch } : station,
      ),
    }));
  const editOptions = (patch: Partial<ProcessingOptions>) =>
    edit((previous) => ({ ...previous, options: { ...previous.options, ...patch } }));

  function resetEditorView() {
    setCursorS(0);
    setSelectedStationId(null);
    setConfirmedRoute(false);
    setUnlockedStep(1);
    setStep('route');
  }
  async function importFile(file: File) {
    if (await files.importFile(file)) resetEditorView();
  }
  function restoreDraft() {
    if (!files.isBusy() && session.restoreDraft()) resetEditorView();
  }
  function confirmRebuild(sourceIndex: number, reverse: boolean, startIndex: number) {
    setDialog({
      title: 'app.confirmRebuild',
      body: 'app.rebuildWarning',
      run: () => {
        void files.rebuild(sourceIndex, reverse, startIndex).then((changed) => {
          if (changed) resetEditorView();
        });
      },
    });
  }
  function addStation() {
    if (!editor) return;
    const s = Math.max(0, Math.min(totalM, cursorS ?? totalM / 2));
    const point = positionAt(editor.reference, s);
    const id = Math.max(...editor.stations.map((station) => station.id)) + 1;
    edit((previous) => ({
      ...previous,
      stations: [
        ...previous.stations,
        {
          id,
          name: t('app.newCheckpoint'),
          shortLabel: 'CP' + id,
          kind: 2,
          stageBoundary: true,
          s,
          lat: point.lat,
          lon: point.lon,
          confirmed: true,
          candidates: [],
        },
      ],
    }));
    setSelectedStationId(id);
  }
  const exportRoute = () => files.exportRoute(route, ready);
  const exportReport = () => {
    if (editor)
      downloadQualityReport(
        editor,
        exported,
        currentRevision,
        language,
        [...issues, ...importIssues],
        message,
      );
  };
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void importFile(file);
    event.target.value = '';
  };
  const lastElev = route?.elev.at(-1);
  const estimateBytes = route
    ? 64 +
      96 +
      route.geom.length * 12 +
      route.elev.length * 16 +
      Math.ceil((route.geom.length - 1) / 128) * 32 +
      route.stations.length * 80 +
      256
    : 0;
  const selectStation = (id: number) => {
    setSelectedStationId(id);
    const station = editor?.stations.find((item) => item.id === id);
    if (station) setCursorS(station.s);
    go('stations');
  };

  return (
    <div className={'studio' + (editor && step !== 'import' ? ' studio--editing' : '')}>
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            go('import');
          }}
          aria-label="TRL-X Route Studio"
        >
          <span className="brand-mark">
            <Mountain size={23} strokeWidth={1.8} />
          </span>
          <span>
            TRL-X <span className="brand-light">/ ROUTE STUDIO</span>
          </span>
        </a>
        <div className="top-actions">
          {editor && step !== 'import' && (
            <div className="document-actions">
              <span
                className="save-status"
                role="status"
                aria-label={
                  saved === 'saved'
                    ? t('app.savedOnThisDevice')
                    : saved === 'failed'
                      ? t('app.localSaveUnavailable')
                      : t('app.saving')
                }
                title={
                  saved === 'saved'
                    ? t('app.savedOnThisDevice')
                    : saved === 'failed'
                      ? t('app.localSaveUnavailable')
                      : t('app.saving')
                }
              >
                {saved === 'saved' ? (
                  <Check size={14} />
                ) : saved === 'saving' ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Circle size={12} />
                )}
                <span className="save-status-text">
                  {saved === 'saved'
                    ? t('app.savedOnThisDevice')
                    : saved === 'failed'
                      ? t('app.localSaveUnavailable')
                      : t('app.saving')}
                </span>
              </span>
              <button
                className="icon-button"
                aria-label={t('app.undo')}
                title={t('app.undo')}
                disabled={!canUndo || !!busy}
                onClick={() => {
                  if (session.undo()) {
                    setConfirmedRoute(false);
                    setUnlockedStep(1);
                  }
                }}
              >
                <Undo2 size={16} />
              </button>
            </div>
          )}

          <label className="language-button">
            <Globe2 size={16} />
            <select
              aria-label={t('app.language')}
              value={language}
              onChange={(event) => void changeLanguage(event.target.value)}
            >
              {availableLanguages.map((locale) => (
                <option key={locale.code} value={locale.code} lang={locale.code}>
                  {locale.label}
                </option>
              ))}
            </select>
          </label>
          <span className="version-badge">V1.0</span>
        </div>
      </header>
      <main className="main-shell">
        <nav className="stepper" aria-label={t('app.routePreparationSteps')}>
          {STEPS.map((item, index) => (
            <button
              key={item}
              className={
                'step ' + (step === item ? 'active' : '') + (index < stepIndex ? ' visited' : '')
              }
              disabled={!canGo(item)}
              title={!canGo(item) && !busy ? t('app.completePreviousStep') : undefined}
              onClick={() => go(item)}
              aria-current={step === item ? 'step' : undefined}
            >
              <span className="step-number">
                {index < stepIndex ? <Check size={14} /> : String(index + 1).padStart(2, '0')}
              </span>
              <span>{t(`steps.${item}.label`)}</span>
              {index < 5 && <span className="step-connector" />}
            </button>
          ))}
        </nav>
        {error && (
          <div className="alert error" role="alert">
            <TriangleAlert size={18} />
            <span>{uiText(error)}</span>
            <button aria-label={t('app.dismissError')} onClick={clearError}>
              <X size={16} />
            </button>
          </div>
        )}
        {busy && (
          <div className="busy-banner" role="status">
            <LoaderCircle size={18} className="spin" />
            <span>{uiText(busy)}</span>
            <button className="text-button" onClick={files.cancel}>
              {t('app.cancel')}
            </button>
          </div>
        )}
        <input
          className="visually-hidden"
          ref={fileInput}
          type="file"
          accept=".gpx,.kml,application/gpx+xml,application/vnd.google-earth.kml+xml"
          onChange={handleFile}
          aria-label={t('app.chooseRouteFile')}
        />
        {step === 'import' ? (
          <ImportLanding
            busy={!!busy}
            draftName={draft?.editor.name ?? null}
            onChooseFile={() => fileInput.current?.click()}
            onFileDrop={(file) => {
              void importFile(file);
            }}
            onRestoreDraft={restoreDraft}
          />
        ) : (
          editor && (
            <section
              className={
                'editor-layout' + (previewCollapsed ? ' editor-layout--preview-collapsed' : '')
              }
            >
              <aside className="editor-panel">
                <div className="panel-heading">
                  <h2 id="editor-step-title">{t(`steps.${step}.label`)}</h2>
                  <p className="muted">{t(`steps.${step}.description`)}</p>
                </div>
                <div
                  className="panel-body"
                  role="region"
                  aria-labelledby="editor-step-title"
                  tabIndex={0}
                >
                  <fieldset className="panel-fields" disabled={!!busy}>
                    {step === 'route' && (
                      <>
                        <label className="field">
                          <span>{t('app.routeName')}</span>
                          <input
                            value={editor.name}
                            onChange={(e) => edit((p) => ({ ...p, name: e.target.value }))}
                          />
                        </label>
                        <div className="source-file">
                          <FileUp size={17} />
                          <span>
                            {editor.file.fileName}
                            <small>
                              {t('app.sourcePointCount', {
                                count: editor.file.routes[editor.sourceIndex].points.length,
                              })}
                            </small>
                          </span>
                        </div>
                        {editor.file.routes.length > 1 && (
                          <label className="field">
                            <span>{t('app.continuousRouteSegment')}</span>
                            <select
                              value={editor.sourceIndex}
                              onChange={(e) => confirmRebuild(Number(e.target.value), false, 0)}
                            >
                              {editor.file.routes.map((r, i) => (
                                <option key={r.id} value={i}>
                                  {t('app.segmentOption', { name: r.name, count: r.points.length })}
                                </option>
                              ))}
                            </select>
                            <small>{t('app.segmentHelp')}</small>
                          </label>
                        )}
                        <div className="section-label">{t('app.travelDirection')}</div>
                        <div className="direction-card">
                          <Flag size={18} />
                          <span>
                            {editor.reverse
                              ? t('app.reversedFromSource')
                              : t('app.asRecordedInSource')}
                            <small>
                              {km(totalM)} km ·{' '}
                              {editor.reference.isClosed ? t('app.closedLoop') : t('app.openRoute')}
                            </small>
                          </span>
                          <button
                            className="icon-button"
                            aria-label={t('app.reverseRoute')}
                            onClick={() =>
                              confirmRebuild(editor.sourceIndex, !editor.reverse, editor.startIndex)
                            }
                          >
                            <RotateCcw size={19} />
                          </button>
                        </div>
                        {editor.reference.isClosed && (
                          <button
                            className="button button-secondary full-width"
                            disabled={cursorS === null}
                            onClick={() => {
                              const point = editor.reference.points.reduce((a, b) =>
                                Math.abs(a.s - (cursorS ?? 0)) < Math.abs(b.s - (cursorS ?? 0))
                                  ? a
                                  : b,
                              );
                              confirmRebuild(
                                editor.sourceIndex,
                                editor.reverse,
                                point.sourceIndex ?? 0,
                              );
                            }}
                          >
                            <Flag size={16} />
                            {t('app.setCursorPositionAsStart')}
                          </button>
                        )}
                        <details className="advanced">
                          <summary>
                            <SlidersHorizontal size={15} />
                            {t('app.geometrySettings')}
                            <ChevronDown size={14} />
                          </summary>
                          <label className="field">
                            <span>{t('app.simplificationToleranceM')}</span>
                            <input
                              type="number"
                              min={PROCESSING_CONTROLS.geometryToleranceM.min}
                              max={PROCESSING_CONTROLS.geometryToleranceM.max}
                              step={PROCESSING_CONTROLS.geometryToleranceM.step}
                              value={editor.options.geometryToleranceM}
                              onChange={(e) =>
                                editOptions({ geometryToleranceM: Number(e.target.value) })
                              }
                            />
                            <small>{t('app.simplificationHelp')}</small>
                          </label>
                        </details>
                        <MagneticDeclinationFields
                          value={editor.magneticDeclination}
                          reference={editor.reference.points[0]}
                          mode={declinationMode}
                          queryDate={declinationDate}
                          status={declinationStatus}
                          onModeChange={(mode) =>
                            edit((e) => ({
                              ...e,
                              declinationMode: mode,
                              declinationQueryDate: e.declinationQueryDate || utcToday(),
                              magneticDeclination:
                                mode === 'manual' ? e.magneticDeclination : undefined,
                            }))
                          }
                          onDateChange={(date) =>
                            edit((e) => ({
                              ...e,
                              declinationQueryDate: date,
                              magneticDeclination: undefined,
                            }))
                          }
                          onRetry={retryDeclination}
                          onChange={(value) => edit((e) => ({ ...e, magneticDeclination: value }))}
                        />
                      </>
                    )}
                    {step === 'stations' && (
                      <>
                        <div className="section-toolbar">
                          <span>{t('app.alongRouteCount', { count: sortedStations.length })}</span>
                          <button className="button button-small" onClick={addStation}>
                            <Plus size={15} />
                            {t('app.add')}
                          </button>
                        </div>
                        <p className="small muted">{t('app.stationPlacementHelp')}</p>
                        {unresolved > 0 && (
                          <div className="inline-note warning">
                            <TriangleAlert size={15} />
                            {t('app.unconfirmedCount', { count: unresolved })}
                          </div>
                        )}
                        <div className="station-list">
                          {sortedStations.map((station, i) => (
                            <button
                              key={station.id}
                              className={
                                'station-row ' +
                                (selectedStationId === station.id ? 'selected' : '')
                              }
                              onClick={() => {
                                setSelectedStationId(station.id);
                                setCursorS(station.s);
                              }}
                            >
                              <span
                                className={'station-pin ' + (station.kind < 2 ? 'endpoint' : '')}
                              >
                                {station.kind < 2 ? <Flag size={12} /> : i}
                              </span>
                              <span className="station-label">
                                <strong>{station.name}</strong>
                                <small>
                                  {km(station.s)} km{' '}
                                  {station.stageBoundary ? '· ' + t('app.stageBoundary') : ''}
                                </small>
                              </span>
                              {!station.confirmed ? (
                                <TriangleAlert size={15} className="warning-text" />
                              ) : (
                                <Check size={14} className="muted" />
                              )}
                            </button>
                          ))}
                        </div>
                        {selected && (
                          <div className="station-editor">
                            <div className="section-toolbar">
                              <strong>{t('app.editStation')}</strong>
                              {selected.kind > 1 && (
                                <button
                                  className="icon-button danger"
                                  aria-label={t('app.deleteStation')}
                                  onClick={() => {
                                    edit((e) => ({
                                      ...e,
                                      stations: e.stations.filter((s) => s.id !== selected.id),
                                    }));
                                    setSelectedStationId(null);
                                  }}
                                >
                                  <Trash2 size={15} />
                                </button>
                              )}
                            </div>
                            <label className="field">
                              <span>{t('app.name')}</span>
                              <input
                                value={selected.name}
                                onChange={(e) => editStation({ name: e.target.value })}
                              />
                            </label>
                            <div className="field-pair">
                              <label className="field">
                                <span>{t('app.shortLabel')}</span>
                                <input
                                  value={selected.shortLabel}
                                  onChange={(e) => editStation({ shortLabel: e.target.value })}
                                />
                              </label>
                              <label className="field">
                                <span>{t('app.type')}</span>
                                <select
                                  value={selected.kind}
                                  disabled={selected.kind < 2}
                                  onChange={(e) =>
                                    editStation({
                                      kind: Number(e.target.value) as DraftStation['kind'],
                                    })
                                  }
                                >
                                  {selected.kind < 2 ? (
                                    <option value={selected.kind}>
                                      {selected.kind === 0 ? t('app.start') : t('app.finish')}
                                    </option>
                                  ) : (
                                    <>
                                      <option value={2}>{t('app.checkpoint')}</option>
                                      <option value={3}>{t('app.water')}</option>
                                      <option value={4}>{t('app.pointOfInterest')}</option>
                                    </>
                                  )}
                                </select>
                              </label>
                            </div>
                            <label className="field">
                              <span>{t('app.alongRouteDistanceM')}</span>
                              <input
                                type="number"
                                min="0"
                                max={totalM}
                                step="0.1"
                                disabled={selected.kind < 2}
                                value={Number(selected.s.toFixed(1))}
                                onChange={(e) =>
                                  editStation({
                                    s: Math.min(totalM, Math.max(0, Number(e.target.value))),
                                    confirmed: false,
                                  })
                                }
                              />
                            </label>
                            {selected.kind > 1 && (
                              <button
                                className="text-button"
                                disabled={cursorS === null}
                                onClick={() =>
                                  editStation({
                                    s: Math.min(totalM, Math.max(0, cursorS ?? selected.s)),
                                    confirmed: true,
                                  })
                                }
                              >
                                {t('app.useCursorPosition')}{' '}
                                {cursorS === null ? '' : km(cursorS) + ' km'}
                                <ArrowRight size={14} />
                              </button>
                            )}
                            {selected.candidates.length > 1 && (
                              <div className="candidate-list">
                                <p className="section-label">{t('app.possibleVisits')}</p>
                                {selected.candidates.map((candidate, i) => (
                                  <button
                                    key={i}
                                    className={
                                      'candidate ' +
                                      (Math.abs(candidate.s - selected.s) < 1 ? 'chosen' : '')
                                    }
                                    onClick={() => {
                                      editStation({ s: candidate.s, confirmed: true });
                                      setCursorS(candidate.s);
                                    }}
                                  >
                                    <span>{km(candidate.s)} km</span>
                                    <small>
                                      {t('app.landmarkOffset', {
                                        distance: number(Math.round(candidate.distanceM)),
                                      })}
                                    </small>
                                  </button>
                                ))}
                              </div>
                            )}
                            <label className="check-field">
                              <input
                                type="checkbox"
                                disabled={selected.kind < 2}
                                checked={selected.stageBoundary}
                                onChange={(e) => editStation({ stageBoundary: e.target.checked })}
                              />
                              <span>{t('app.splitStagesAtThisStation')}</span>
                            </label>
                            {selected.kind > 1 && !selected.confirmed && (
                              <button
                                className="button button-primary full-width"
                                onClick={() => editStation({ confirmed: true })}
                              >
                                <Check size={16} />
                                {t('app.confirmThisVisit')}
                              </button>
                            )}
                            <details className="advanced">
                              <summary>
                                {t('app.landmarkCoordinates')}
                                <ChevronDown size={14} />
                              </summary>
                              <p className="small muted">{t('app.landmarkPositionHelp')}</p>
                              <div className="field-pair">
                                <label className="field">
                                  <span>{t('app.latitude')}</span>
                                  <input
                                    type="number"
                                    step="0.0000001"
                                    value={selected.lat}
                                    onChange={(e) => editStation({ lat: Number(e.target.value) })}
                                  />
                                </label>
                                <label className="field">
                                  <span>{t('app.longitude')}</span>
                                  <input
                                    type="number"
                                    step="0.0000001"
                                    value={selected.lon}
                                    onChange={(e) => editStation({ lon: Number(e.target.value) })}
                                  />
                                </label>
                              </div>
                            </details>
                          </div>
                        )}
                      </>
                    )}
                    {step === 'elevation' && (
                      <>
                        {editor.reference.points.some((p) => p.elevation === null) && (
                          <div className="inline-note">
                            <Mountain size={18} />
                            <span>
                              {t('app.missingElevationCount', {
                                count: editor.reference.points.filter((p) => p.elevation === null)
                                  .length,
                              })}
                            </span>
                          </div>
                        )}
                        <fieldset className="radio-cards">
                          <legend>{t('app.elevationSettings')}</legend>
                          {(['source', 'interpolate'] as const).map((mode, i) => (
                            <label
                              className={
                                'radio-card ' +
                                (editor.options.elevationMode === mode ? 'selected' : '')
                              }
                              key={mode}
                            >
                              <input
                                type="radio"
                                name="elevation"
                                value={mode}
                                checked={editor.options.elevationMode === mode}
                                onChange={() => editOptions({ elevationMode: mode })}
                              />
                              <span>
                                <strong>
                                  {[t('app.useSourceElevation'), t('app.fillElevationGaps')][i]}
                                </strong>
                                <small>
                                  {
                                    [
                                      t('app.sourceElevationHelp'),
                                      t('app.interpolateElevationGapsDescription'),
                                    ][i]
                                  }
                                </small>
                              </span>
                            </label>
                          ))}
                        </fieldset>
                        {editor.reference.elevationUncertain && (
                          <label className="check-field caution">
                            <input
                              type="checkbox"
                              checked={editor.options.acceptUncertainElevation}
                              onChange={(e) =>
                                editOptions({ acceptUncertainElevation: e.target.checked })
                              }
                            />
                            <span>{t('app.confirmUncertainElevation')}</span>
                          </label>
                        )}
                        <label className="field">
                          <span>{t('app.samplingIntervalM')}</span>
                          <select
                            value={editor.options.elevationIntervalM}
                            onChange={(e) =>
                              editOptions({ elevationIntervalM: Number(e.target.value) })
                            }
                          >
                            {PROCESSING_CHOICES.elevationIntervalM.map((n) => (
                              <option key={n} value={n}>
                                {n} m
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          <span>{t('app.smoothingWindowM')}</span>
                          <select
                            value={editor.options.smoothingWindowM}
                            onChange={(e) =>
                              editOptions({ smoothingWindowM: Number(e.target.value) })
                            }
                          >
                            {PROCESSING_CHOICES.smoothingWindowM.map((n) => (
                              <option key={n} value={n}>
                                {n === 0 ? t('app.smoothingOff') : `${n} m`}
                              </option>
                            ))}
                          </select>
                          <small>{t('app.smoothingHelp')}</small>
                        </label>
                        {route && (
                          <label className="check-field">
                            <input
                              type="checkbox"
                              checked={compareSource}
                              onChange={(e) => setCompareSource(e.target.checked)}
                            />
                            <span>{t('app.compareOriginalElevation')}</span>
                          </label>
                        )}
                        <div className="info-card">
                          <ShieldCheck size={18} />
                          <p>{t('app.completeElevationRequired')}</p>
                        </div>
                      </>
                    )}
                    {step === 'preview' && (
                      <>
                        <div className="review-summary">
                          <span className="summary-icon">
                            <Route size={24} />
                          </span>
                          <h3>{editor.name}</h3>
                          <p>
                            {km(totalM)} km ·{' '}
                            {t('common.stationCount', { count: editor.stations.length })}
                          </p>
                        </div>
                        <p className="small muted">{t('app.reviewHelp')}</p>
                        <StageList
                          stations={sortedStations}
                          route={route}
                          onSelectDistance={setCursorS}
                        />
                        <button
                          className="button button-secondary full-width"
                          onClick={exportReport}
                        >
                          <ArrowDownToLine size={16} />
                          {t('app.downloadProcessingReport')}
                        </button>
                      </>
                    )}
                    {step === 'export' && (
                      <>
                        <div className={'export-status ' + (ready ? 'valid' : '')}>
                          <span>
                            {ready ? <ShieldCheck size={30} /> : <TriangleAlert size={30} />}
                          </span>
                          <h3>{ready ? t('app.readyToExport') : t('app.exportUnavailable')}</h3>
                          <p>
                            {ready
                              ? t('app.exportHelp')
                              : t(
                                  declinationStatus === 'loading'
                                    ? 'app.declinationLoading'
                                    : processing
                                      ? 'app.waitForProcessing'
                                      : !confirmedRoute
                                        ? 'app.routeConfirmationRequired'
                                        : 'app.resolveExportErrors',
                                )}
                          </p>
                        </div>
                        {!confirmedRoute && (
                          <button
                            className="button button-secondary full-width"
                            onClick={() => go('route')}
                          >
                            {t('app.confirmRouteAndDirectionFirst')}
                            <ArrowRight size={15} />
                          </button>
                        )}
                        <dl className="export-details">
                          <div>
                            <dt>{t('app.format')}</dt>
                            <dd>TRL-X Route 1.0</dd>
                          </div>
                          <div>
                            <dt>{t('app.revision')}</dt>
                            <dd>{currentRevision}</dd>
                          </div>
                          <div>
                            <dt>{t('app.geometryNodes')}</dt>
                            <dd>{route ? number(route.geom.length) : '—'}</dd>
                          </div>
                          <div>
                            <dt>{t('app.elevationNodes')}</dt>
                            <dd>{route ? number(route.elev.length) : '—'}</dd>
                          </div>
                          <div>
                            <dt>{t('app.estimatedSize')}</dt>
                            <dd>{route ? '~ ' + size(estimateBytes) : '—'}</dd>
                          </div>
                        </dl>
                        <button
                          className="button button-primary full-width export-button"
                          disabled={!ready}
                          onClick={() => void exportRoute()}
                        >
                          <ArrowDownToLine size={18} />
                          {t('app.downloadRte')}
                        </button>
                        {exported && (
                          <div className="success-card">
                            <CheckCircle2 size={20} />
                            <span>
                              <strong>{exported.filename}</strong>
                              <small>
                                {t('app.exportDetails', {
                                  size: size(exported.bytes),
                                  revision: number(exported.revision),
                                })}
                              </small>
                            </span>
                          </div>
                        )}
                        <button className="text-button full-width" onClick={exportReport}>
                          {t('app.downloadProcessingReport')}
                          <ArrowDownToLine size={14} />
                        </button>
                        <p className="small muted">{t('app.revisionHelp')}</p>
                      </>
                    )}
                    <IssuesList
                      issues={visibleIssues}
                      onLocate={(s) => {
                        setCursorS(s);
                        showView('map');
                      }}
                    />
                    {step === 'route' && (
                      <label className="check-field">
                        <input
                          type="checkbox"
                          checked={confirmedRoute}
                          onChange={(e) => {
                            setConfirmedRoute(e.target.checked);
                            if (!e.target.checked) setUnlockedStep(1);
                          }}
                        />
                        <span>{t('app.confirmRouteDirection')}</span>
                      </label>
                    )}
                  </fieldset>
                </div>
                <div className="panel-footer">
                  <button
                    className="button button-ghost"
                    disabled={!!busy}
                    onClick={() => go(STEPS[Math.max(0, stepIndex - 1)])}
                  >
                    <ArrowLeft size={16} />
                    {t('app.back')}
                  </button>
                  {stepIndex < 5 && (
                    <button
                      className="button button-primary"
                      disabled={!canGo(STEPS[stepIndex + 1])}
                      onClick={() => go(STEPS[stepIndex + 1])}
                    >
                      {t('app.continue')}
                      <ArrowRight size={16} />
                    </button>
                  )}
                </div>
              </aside>
              <div
                ref={workspaceRef}
                aria-busy={processing || !currentResult}
                className={
                  'visual-workspace' + (stackedPreview ? ' visual-workspace--stacked' : '')
                }
              >
                {!stackedPreview && (
                  <div className="workspace-toolbar">
                    <div className="view-switch">
                      <button
                        aria-pressed={activeView === 'map'}
                        aria-controls="route-map-panel"
                        className={activeView === 'map' ? 'active' : ''}
                        onClick={() => showView('map')}
                      >
                        <MapPinned size={15} />
                        {t('app.map')}
                      </button>
                      <button
                        aria-pressed={activeView === 'profile'}
                        aria-controls="route-profile-panel"
                        className={activeView === 'profile' ? 'active' : ''}
                        onClick={() => showView('profile')}
                      >
                        <Mountain size={15} />
                        {t('app.profile')}
                      </button>
                    </div>
                    <button
                      className="icon-button preview-toggle"
                      aria-expanded={!previewCollapsed}
                      aria-controls="route-map-panel route-profile-panel"
                      aria-label={t(previewCollapsed ? 'app.expandPreview' : 'app.collapsePreview')}
                      title={t(previewCollapsed ? 'app.expandPreview' : 'app.collapsePreview')}
                      onClick={() => setPreviewCollapsed((value) => !value)}
                    >
                      {previewCollapsed ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
                    </button>
                  </div>
                )}
                <div
                  className="map-panel"
                  id="route-map-panel"
                  hidden={!stackedPreview && activeView !== 'map'}
                >
                  <Suspense
                    fallback={
                      <div className="map-loading">
                        <LoaderCircle className="spin" />
                        {t('app.loadingMap')}
                      </div>
                    }
                  >
                    <RouteMap
                      reference={editor.reference}
                      stations={editor.stations}
                      selectedStationId={selectedStationId}
                      cursorS={cursorS}
                      onCursorChange={setCursorS}
                      onStationSelect={selectStation}
                    />
                  </Suspense>
                </div>
                <div
                  className="profile-panel"
                  id="route-profile-panel"
                  hidden={!stackedPreview && activeView !== 'profile'}
                >
                  <ElevationChart
                    reference={editor.reference}
                    route={route}
                    stations={editor.stations}
                    cursorS={cursorS}
                    onCursorChange={setCursorS}
                    onStationSelect={selectStation}
                    compareSource={compareSource}
                  />
                </div>
                <div className="route-progress">
                  <label htmlFor="route-progress">{t('profile.routeProgress')}</label>
                  <input
                    id="route-progress"
                    type="range"
                    min="0"
                    max={Math.max(1, totalM)}
                    step="1"
                    value={cursorS ?? 0}
                    onChange={(event) => setCursorS(Number(event.target.value))}
                    aria-valuetext={km(cursorS ?? 0) + ' km'}
                  />
                  <output htmlFor="route-progress">{km(cursorS ?? 0)} km</output>
                </div>
                <div className="stats-strip">
                  <div>
                    <span>{t('app.distance')}</span>
                    <strong>
                      {km(totalM)}
                      <small> km</small>
                    </strong>
                  </div>
                  <div>
                    <span>{t('app.ascent')}</span>
                    <strong>
                      {lastElev ? number(Math.round(lastElev.upDm / 10)) : '—'}
                      <small>{lastElev ? ' m' : ''}</small>
                    </strong>
                  </div>
                  <div>
                    <span>{t('app.descent')}</span>
                    <strong>
                      {lastElev ? number(Math.round(lastElev.downDm / 10)) : '—'}
                      <small>{lastElev ? ' m' : ''}</small>
                    </strong>
                  </div>
                  <div>
                    <span>{t('app.stationsLabel')}</span>
                    <strong>{number(editor.stations.length)}</strong>
                  </div>
                </div>
              </div>
            </section>
          )
        )}
      </main>
      {notice && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {uiText(notice)}
        </div>
      )}
      <Dialog.Root
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>{dialog && uiText(dialog.title)}</Dialog.Title>
            <Dialog.Description>{dialog && uiText(dialog.body)}</Dialog.Description>
            <div className="dialog-actions">
              <Dialog.Close asChild>
                <button className="button button-secondary">{t('app.keepEditing')}</button>
              </Dialog.Close>
              <button
                className="button button-primary"
                onClick={() => {
                  const run = dialog?.run;
                  setDialog(null);
                  run?.();
                }}
              >
                {t('app.rebuildRoute')}
              </button>
            </div>
            <Dialog.Close className="dialog-close" aria-label={t('app.close')}>
              <X size={18} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
