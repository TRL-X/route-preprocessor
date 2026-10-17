import { useLocale } from '../../i18n/useLocale';
import { useState } from 'react';
import { ArrowRight, FileUp, RotateCcw, ShieldCheck } from 'lucide-react';

export interface ImportLandingProps {
  busy: boolean;
  draftName: string | null;
  onChooseFile: () => void;
  onFileDrop: (file: File) => void;
  onRestoreDraft: () => void;
}

export default function ImportLanding({
  busy,
  draftName,
  onChooseFile,
  onFileDrop,
  onRestoreDraft,
}: ImportLandingProps) {
  const { t } = useLocale();
  const [dragging, setDragging] = useState(false);
  return (
    <section className="import-layout">
      <div className="import-panel">
        <h1>{t('import.title')}</h1>
        <p className="muted">{t('import.description')}</p>
        <div
          className={'dropzone ' + (dragging ? 'dragging' : '')}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) onFileDrop(file);
          }}
        >
          <div className="upload-icon">
            <FileUp size={27} strokeWidth={1.5} />
          </div>
          <h3>{t('import.dropPrompt')}</h3>
          <p>{t('import.chooseFileHint')}</p>
          <button className="button button-primary" disabled={busy} onClick={onChooseFile}>
            {t('import.chooseAFile')}
            <ArrowRight size={16} />
          </button>
          <div className="file-types">
            <span>GPX</span>
            <span>KML</span>
            <small>{t('import.fileLimit')}</small>
          </div>
        </div>
        {draftName !== null && (
          <button className="draft-card" onClick={onRestoreDraft}>
            <RotateCcw size={20} />
            <span>
              <strong>{t('import.restoreDraft')}</strong>
              <small>{draftName}</small>
            </span>
            <ArrowRight size={18} />
          </button>
        )}
        <div className="privacy-note">
          <ShieldCheck size={19} />
          <span>{t('import.privacyNote')}</span>
        </div>
      </div>
    </section>
  );
}
