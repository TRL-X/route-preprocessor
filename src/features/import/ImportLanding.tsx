import { useState } from 'react';
import { ArrowRight, Compass, FileUp, MapPinned, RotateCcw, Route, ShieldCheck, SlidersHorizontal } from 'lucide-react';

export interface ImportLandingProps {
  language: 'en' | 'zh';
  busy: boolean;
  draftName: string | null;
  onChooseFile: () => void;
  onFileDrop: (file: File) => void;
  onRestoreDraft: () => void;
}

/** Import presentation only; file parsing and draft restoration stay in App. */
export default function ImportLanding({ language, busy, draftName, onChooseFile, onFileDrop, onRestoreDraft }: ImportLandingProps) {
  const [dragging, setDragging] = useState(false);
  const tr = (en: string, zh: string) => language === 'zh' ? zh : en;
  return <section className="import-layout">
        <div className="import-panel">
          <div className="panel-kicker"><span className="number-tag">01</span>{tr('YOUR NEXT ADVENTURE', '下一次冒险')}</div>
          <h2>{tr('Bring your route.', '带上你的路线。')}</h2><p className="muted">{tr('A race course, a favorite trail, or somewhere entirely new. Let’s get it ready.', '一场比赛、一条熟悉的山径，或一个全新的目的地。一起做好准备。')}</p>
          <div className={'dropzone ' + (dragging ? 'dragging' : '')} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); const file = e.dataTransfer.files[0]; if (file) onFileDrop(file); }}>
            <div className="upload-icon"><FileUp size={27} strokeWidth={1.5} /></div><h3>{tr('Drop your route file here', '将路线文件拖到这里')}</h3><p>{tr('or choose one from your device', '也可以从设备中选择文件')}</p>
            <button className="button button-primary" disabled={busy} onClick={onChooseFile}>{tr('Choose a file', '选择文件')}<ArrowRight size={16} /></button>
            <div className="file-types"><span>GPX</span><span>KML</span><small>{tr('Up to 20 MB', '最大 20 MB')}</small></div>
          </div>
          {draftName !== null && <button className="draft-card" onClick={onRestoreDraft}><RotateCcw size={20} /><span><strong>{tr('Pick up where you left off', '继续上次的编辑')}</strong><small>{draftName}</small></span><ArrowRight size={18} /></button>}
          <div className="privacy-note"><ShieldCheck size={19} /><span><strong>{tr('Your route stays yours.', '路线数据，由你掌握。')}</strong> {tr('Files are processed on your device. No account or upload needed.', '文件在设备本地处理，无需账号，无需上传。')}</span></div>
        </div>
        <div className="welcome-visual">
          <div className="visual-top"><span className="pill"><span className="status-dot" />{tr('BUILT FOR THE WAY AHEAD', '为下一段路做好准备')}</span><Compass size={31} strokeWidth={1} /></div>
          <div className="contour-art" aria-hidden="true"><svg viewBox="0 0 600 460" fill="none"><defs><pattern id="small-grid" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M 36 0 L 0 0 0 36" stroke="#c8d0be" strokeWidth=".5" /></pattern></defs><rect width="600" height="460" fill="url(#small-grid)" />{Array.from({length:10},(_,i)=><ellipse key={i} cx="375" cy="225" rx={45+i*25} ry={26+i*19} transform={'rotate(-32 375 225)'} stroke="#bdc8b4" strokeWidth=".8" />)}{Array.from({length:6},(_,i)=><ellipse key={i} cx="60" cy="360" rx={35+i*24} ry={20+i*20} transform="rotate(32 60 360)" stroke="#c3ccb9" strokeWidth=".8" />)}<path d="M94 348C130 320 104 281 161 269S244 288 242 224S292 178 321 166S326 118 382 122S449 181 492 97" stroke="#e9eddf" strokeWidth="13" strokeLinecap="round" /><path d="M94 348C130 320 104 281 161 269S244 288 242 224S292 178 321 166S326 118 382 122S449 181 492 97" stroke="#325c45" strokeWidth="3.5" strokeLinecap="round" /><circle cx="94" cy="348" r="8" fill="#315b45" stroke="#f6f7ef" strokeWidth="4" /><circle cx="242" cy="224" r="7" fill="#dce9a1" stroke="#315b45" strokeWidth="2" /><circle cx="382" cy="122" r="7" fill="#dce9a1" stroke="#315b45" strokeWidth="2" /><circle cx="492" cy="97" r="8" fill="#315b45" stroke="#f6f7ef" strokeWidth="4" /><g fill="#325040" fontFamily="system-ui" fontSize="10" letterSpacing="2"><text x="60" y="380">START</text><text x="259" y="229">CP 01</text><text x="372" y="101">CP 02</text><text x="472" y="75">FINISH</text></g></svg></div>
          <div className="visual-bottom"><span className="outline-icon"><Route size={22} /></span><div><h3>{tr('Less guesswork. More trail.', '少一点猜测，多一点笃定。')}</h3><p>{tr('A clear route. Meaningful stops. Every climb accounted for.', '路线清晰，站点有序，每一次爬升都有依据。')}</p></div></div>
        </div>
        <div className="benefit-row"><div><MapPinned size={19} /><span><strong>{tr('See the whole picture', '看清整条路线')}</strong><small>{tr('Map and elevation, connected', '地图与高程同步联动')}</small></span></div><div><SlidersHorizontal size={19} /><span><strong>{tr('Fine-tune with confidence', '有依据地调整')}</strong><small>{tr('Clear checks at every step', '每一步都有明确检查')}</small></span></div><div><ShieldCheck size={19} /><span><strong>{tr('Ready for your device', '准备好交给设备')}</strong><small>{tr('Validated TRL-X Route export', '经过校验的 TRL-X Route')}</small></span></div></div>
      </section>;
}
