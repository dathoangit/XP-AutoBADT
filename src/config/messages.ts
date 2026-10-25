import type { AuthPayload } from '../auth/types';
import type {
  ExportMode,
  ExportTarget,
  KskPaperKind
} from '../core/export-target';
import type { ReportRow } from '../excel/report-writer';

export type RuntimeMessage =
  | { type: 'AUTH_UPDATED'; auth: AuthPayload | null }
  | { type: 'GET_AUTH' }
  | {
      type: 'START_EXPORT';
      mode: ExportMode;
      targets: ExportTarget[];
      sourceFileName: string;
      kskPaperKind?: KskPaperKind;
    }
  | { type: 'STOP_EXPORT' }
  | {
      type: 'SAVE_PDF';
      requestId: string;
      fileName: string;
      base64: string;
    }
  | {
      type: 'SAVE_PDF_DONE';
      requestId: string;
      ok: boolean;
      error?: string;
    }
  | { type: 'EXPORT_PROGRESS'; current: number; total: number; maHoSo: string }
  | { type: 'EXPORT_LOG'; message: string }
  | { type: 'EXPORT_ITEM_DONE'; row: ReportRow }
  | {
      type: 'EXPORT_DONE';
      rows: ReportRow[];
      reportFileName: string;
      reportBase64: string;
      remainingFileName?: string;
      remainingBase64?: string;
      remainingCount?: number;
    }
  | { type: 'EXPORT_ERROR'; message: string };

export type AuthResponse = { auth: AuthPayload | null };
