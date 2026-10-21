import { useEffect, useRef, useState } from 'react';
import { Bluetooth, CheckCircle2, LoaderCircle, Upload } from 'lucide-react';
import type { PreparedExport } from '../../app/route-files';
import { isCancelled } from '../../app/route-files';
import {
  connectBluetoothDevice,
  isBluetoothSupported,
  type BluetoothConnection,
} from '../../device/bluetooth';
import { SmpDeviceError } from '../../device/smp';
import { useLocale } from '../../i18n/useLocale';
import { DEFAULT_TARGET_DIRECTORY, TARGET_DIRECTORY_STORAGE_KEY, uploadPath } from './upload-path';

interface Props {
  ready: boolean;
  disabled: boolean;
  filename: string;
  prepareExport: (signal: AbortSignal) => Promise<PreparedExport | undefined>;
  onBusyChange: (busy: boolean) => void;
}

function savedDirectory() {
  try {
    return localStorage.getItem(TARGET_DIRECTORY_STORAGE_KEY) ?? DEFAULT_TARGET_DIRECTORY;
  } catch {
    return DEFAULT_TARGET_DIRECTORY;
  }
}

export default function BluetoothUpload({
  ready,
  disabled,
  filename,
  prepareExport,
  onBusyChange,
}: Props) {
  const { t, number, uiText } = useLocale();
  const supported = isBluetoothSupported();
  const [directory, setDirectory] = useState(savedDirectory);
  const [deviceName, setDeviceName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ sent: 0, total: 0 });
  const [error, setError] = useState<string | { code: number; group: number | null }>('');
  const [status, setStatus] = useState('');
  const [uploadedPath, setUploadedPath] = useState('');
  const connection = useRef<BluetoothConnection | null>(null);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const choosing = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      connection.current?.disconnect();
      onBusyChange(false);
    };
  }, [onBusyChange]);

  useEffect(() => {
    try {
      localStorage.setItem(TARGET_DIRECTORY_STORAGE_KEY, directory);
    } catch {
      // Preferences remain usable for this session when storage is unavailable.
    }
  }, [directory]);

  useEffect(() => {
    setUploadedPath('');
  }, [filename]);

  let path = '';
  let pathError = '';
  try {
    if (filename) path = uploadPath(directory, filename);
  } catch (error) {
    pathError = (error as Error).message;
  }

  async function connect() {
    if (choosing.current || connection.current || disabled) return;
    choosing.current = true;
    setConnecting(true);
    setError('');
    setStatus('');
    try {
      let selected: BluetoothConnection | null = null;
      // Call in the click handler before any await to retain user activation.
      const next = await connectBluetoothDevice({
        onDisconnected: () => {
          if (!selected || connection.current !== selected) return;
          connection.current = null;
          if (!mounted.current) return;
          setDeviceName('');
          setStatus('bluetooth.disconnected');
        },
      });
      selected = next;
      if (!mounted.current) {
        next.disconnect();
        return;
      }
      connection.current = next;
      setDeviceName(next.name);
      setStatus('');
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : 'bluetooth.connectionFailed');
    } finally {
      choosing.current = false;
      if (mounted.current) setConnecting(false);
    }
  }

  function disconnect() {
    const device = connection.current;
    connection.current = null;
    device?.disconnect();
    setDeviceName('');
    setStatus('bluetooth.disconnected');
  }

  async function upload() {
    const device = connection.current;
    if (!ready || disabled || !device || operation.current || !path) return;
    const controller = new AbortController();
    operation.current = controller;
    setUploading(true);
    onBusyChange(true);
    setError('');
    setStatus('');
    setUploadedPath('');
    setProgress({ sent: 0, total: 0 });
    try {
      const output = await prepareExport(controller.signal);
      controller.signal.throwIfAborted();
      if (!output) return;
      const target = uploadPath(directory, output.exported.filename);
      await device.upload(output.bytes, target, {
        signal: controller.signal,
        onProgress: (sent, total) => {
          if (mounted.current && !controller.signal.aborted) setProgress({ sent, total });
        },
      });
      controller.signal.throwIfAborted();
      if (mounted.current) {
        setUploadedPath(target);
        setStatus('');
      }
    } catch (error) {
      // Stop any remaining fragments and discard late ACKs before another attempt.
      connection.current = null;
      device.disconnect();
      if (!mounted.current) return;
      setDeviceName('');
      if (isCancelled(error)) setStatus('bluetooth.cancelled');
      else {
        setStatus('');
        setError(
          error instanceof SmpDeviceError
            ? { code: error.code, group: error.group }
            : error instanceof Error
              ? error.message
              : 'bluetooth.transferFailed',
        );
      }
    } finally {
      operation.current = null;
      if (mounted.current) {
        setUploading(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <section className="bluetooth-upload" aria-labelledby="bluetooth-upload-title">
      <h3 id="bluetooth-upload-title">
        <Bluetooth size={18} />
        {t('bluetooth.title')}
      </h3>
      {!supported ? (
        <p className="small muted">{t('bluetooth.unsupported')}</p>
      ) : (
        <>
          <p className="small muted">{t('bluetooth.help')}</p>
          <label className="field">
            <span>{t('bluetooth.targetDirectory')}</span>
            <input
              aria-label={t('bluetooth.targetDirectory')}
              value={directory}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              disabled={uploading || disabled}
              onChange={(event) => {
                setDirectory(event.target.value);
                setUploadedPath('');
                setError('');
              }}
              aria-describedby="bluetooth-target-help"
              aria-invalid={!!pathError}
            />
            <small id="bluetooth-target-help">
              {pathError ? uiText(pathError) : path ? t('bluetooth.targetPath', { path }) : null}
            </small>
          </label>
          <p className="small muted">{t('bluetooth.overwriteHelp')}</p>
          {deviceName ? (
            <div className="bluetooth-upload__device">
              <span>{t('bluetooth.connected', { name: deviceName })}</span>
              <button className="text-button" onClick={disconnect} disabled={uploading || disabled}>
                {t('bluetooth.disconnect')}
              </button>
            </div>
          ) : (
            <button
              className="button button-secondary full-width"
              onClick={() => void connect()}
              disabled={connecting || uploading || disabled}
            >
              {connecting ? <LoaderCircle size={16} className="spin" /> : <Bluetooth size={16} />}
              {t(connecting ? 'bluetooth.connecting' : 'bluetooth.connect')}
            </button>
          )}
          <button
            className="button button-primary full-width"
            onClick={() => void upload()}
            disabled={!ready || !deviceName || uploading || disabled || !path}
          >
            <Upload size={16} />
            {t('bluetooth.upload')}
          </button>
          {uploading && (
            <div className="bluetooth-upload__progress">
              <progress
                aria-label={t('bluetooth.progress')}
                value={progress.sent}
                max={progress.total || 1}
              />
              <span className="small" role="status">
                {progress.total
                  ? t('bluetooth.progressText', {
                      percent: number(Math.floor((progress.sent / progress.total) * 100)),
                      sent: number(progress.sent),
                      total: number(progress.total),
                    })
                  : t('app.exportingRoute')}
              </span>
              <button className="text-button" onClick={() => operation.current?.abort()}>
                {t('bluetooth.cancel')}
              </button>
            </div>
          )}
          {uploadedPath && (
            <p className="bluetooth-upload__success small" role="status">
              <CheckCircle2 size={16} />
              {t('bluetooth.success', { path: uploadedPath })}
            </p>
          )}
          {status && (
            <p className="small muted" role="status">
              {uiText(status)}
            </p>
          )}
          {error && (
            <p className="bluetooth-upload__error small" role="alert">
              {typeof error === 'string'
                ? uiText(error)
                : t('bluetooth.deviceErrorDetails', {
                    code: number(error.code),
                    group: error.group === null ? 'SMP' : number(error.group),
                  })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
