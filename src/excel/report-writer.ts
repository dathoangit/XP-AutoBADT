import ExcelJS from 'exceljs';

export type ReportStatus = 'success' | 'empty' | 'error' | 'cancelled';

export interface ReportIssue {
  maHoSo: string;
  index: number;
  maBieuMau: string;
  id: string;
  soPhieu: string;
  tenBieuMau: string;
  apiPath: string;
  kind: string;
  detail: string;
}

export interface ReportRow {
  maHoSo: string;
  status: ReportStatus;
  /** Raw CLS API item count */
  apiItemCount: number;
  /** Descriptors that entered preview/PDF URL (legacy alias: fileCount) */
  fileCount: number;
  /** Items skipped when building descriptors */
  skippedCount: number;
  /** PDF parts actually used in the final merged file */
  obtainedCount: number;
  pageCount: number;
  directPdfCount: number;
  htmlRenderCount: number;
  outputPath: string;
  error: string;
  /** Short human summary for the summary sheet */
  issuesSummary: string;
  /** Per-item problems for the detail sheet */
  issues: ReportIssue[];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

function emptyReportFields(): Pick<
  ReportRow,
  | 'apiItemCount'
  | 'fileCount'
  | 'skippedCount'
  | 'obtainedCount'
  | 'pageCount'
  | 'directPdfCount'
  | 'htmlRenderCount'
  | 'outputPath'
  | 'error'
  | 'issuesSummary'
  | 'issues'
> {
  return {
    apiItemCount: 0,
    fileCount: 0,
    skippedCount: 0,
    obtainedCount: 0,
    pageCount: 0,
    directPdfCount: 0,
    htmlRenderCount: 0,
    outputPath: '',
    error: '',
    issuesSummary: '',
    issues: []
  };
}

export function createReportRow(
  partial: Partial<ReportRow> & Pick<ReportRow, 'maHoSo' | 'status'>
): ReportRow {
  return {
    ...emptyReportFields(),
    ...partial,
    issues: partial.issues ?? []
  };
}

function mismatchFlag(row: ReportRow): string {
  if (row.apiItemCount === 0 && row.fileCount === 0) {
    return '';
  }

  const parts: string[] = [];
  if (row.apiItemCount !== row.fileCount) {
    parts.push(`API ${row.apiItemCount} ≠ descriptor ${row.fileCount}`);
  }

  if (
    row.fileCount > 0 &&
    row.obtainedCount > 0 &&
    row.obtainedCount !== row.fileCount &&
    row.htmlRenderCount === 0
  ) {
    parts.push(
      `descriptor ${row.fileCount} ≠ PDF lấy được ${row.obtainedCount}`
    );
  }

  if (row.skippedCount > 0) {
    parts.push(`bỏ ${row.skippedCount}`);
  }

  return parts.join(' · ');
}

export async function buildReportWorkbook(
  rows: ReportRow[],
  sourceFileName: string
): Promise<{ fileName: string; base64: string }> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Ket qua');

  sheet.columns = [
    { header: 'Mã hồ sơ', key: 'maHoSo', width: 18 },
    { header: 'Trạng thái', key: 'status', width: 12 },
    { header: 'API phiếu', key: 'apiItemCount', width: 10 },
    { header: 'Descriptor', key: 'fileCount', width: 11 },
    { header: 'Bỏ qua', key: 'skippedCount', width: 9 },
    { header: 'PDF lấy được', key: 'obtainedCount', width: 13 },
    { header: 'Lệch?', key: 'mismatch', width: 40 },
    { header: 'Số trang', key: 'pageCount', width: 10 },
    { header: 'PDF gốc', key: 'directPdfCount', width: 10 },
    { header: 'Canvas fallback', key: 'htmlRenderCount', width: 14 },
    { header: 'File output', key: 'outputPath', width: 28 },
    { header: 'Lỗi', key: 'error', width: 40 },
    { header: 'Tóm tắt vấn đề', key: 'issuesSummary', width: 50 }
  ];

  for (const row of rows) {
    sheet.addRow({
      maHoSo: row.maHoSo,
      status: row.status,
      apiItemCount: row.apiItemCount,
      fileCount: row.fileCount,
      skippedCount: row.skippedCount,
      obtainedCount: row.obtainedCount,
      mismatch: mismatchFlag(row),
      pageCount: row.pageCount,
      directPdfCount: row.directPdfCount,
      htmlRenderCount: row.htmlRenderCount,
      outputPath: row.outputPath,
      error: row.error,
      issuesSummary: row.issuesSummary
    });
  }

  const detail = workbook.addWorksheet('Chi tiet van de');
  detail.columns = [
    { header: 'Mã hồ sơ', key: 'maHoSo', width: 18 },
    { header: 'STT API', key: 'index', width: 9 },
    { header: 'Loại vấn đề', key: 'kind', width: 16 },
    { header: 'maBieuMau', key: 'maBieuMau', width: 14 },
    { header: 'id', key: 'id', width: 14 },
    { header: 'soPhieu', key: 'soPhieu', width: 14 },
    { header: 'tenBieuMau', key: 'tenBieuMau', width: 28 },
    { header: 'api/path', key: 'apiPath', width: 40 },
    { header: 'Chi tiết', key: 'detail', width: 60 }
  ];

  for (const row of rows) {
    for (const issue of row.issues) {
      detail.addRow(issue);
    }
  }

  if (detail.rowCount <= 1) {
    detail.addRow({
      maHoSo: '',
      index: '',
      kind: '',
      maBieuMau: '',
      id: '',
      soPhieu: '',
      tenBieuMau: '',
      apiPath: '',
      detail:
        '(Không có vấn đề chi tiết — mọi phiếu API đều map được và không ghi skip)'
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer as ArrayBuffer);
  const base = sourceFileName.replace(/\.xlsx?$/i, '') || 'ket-qua';

  return {
    fileName: `${base}-ket-qua.xlsx`,
    base64: bytesToBase64(bytes)
  };
}
