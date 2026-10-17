import type {
  DraftStation,
  ImportedFile,
  MagneticDeclinationInfo,
  ProcessingOptions,
  ReferenceRoute,
} from '../core/types';

export const DRAFT_VERSION = 3;

export interface Editor {
  file: ImportedFile;
  reference: ReferenceRoute;
  stations: DraftStation[];
  options: ProcessingOptions;
  name: string;
  routeId: Uint8Array;
  inputSha256: Uint8Array;
  magneticDeclination?: MagneticDeclinationInfo;
  declinationMode?: 'auto' | 'manual' | 'omit';
  declinationQueryDate?: string;
  sourceIndex: number;
  reverse: boolean;
  startIndex: number;
}

export type Ledger = Record<string, { revision: number }>;
export interface Draft {
  version: typeof DRAFT_VERSION;
  editor: Editor;
  ledger: Ledger;
  savedAt: number;
}
