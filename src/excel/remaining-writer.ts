import ExcelJS from 'exceljs';
import type { ExportTarget } from '../core/export-target';
import { bytesToBase64 } from '../utils/download';

/**
 * Strip .xlsx/.xls and trailing -con-lai so re-runs stay `{base}-con-lai.xlsx`.
 */
function remainingBaseName(sourceFileName: string): string {
  const withoutExt = sourceFileName.replace(/\.xlsx?$/i, '') || 'excel';
  return withoutExt.replace(/-con-lai$/i, '') || 'excel';
}

/**
 * Build an input workbook for rows still to process.
 * Roster rows keep name columns so the next run can rebuild the same PDF names.
 * A code-only list keeps a single "Mã hồ sơ" column.
 */
export async function buildRemainingWorkbook(
  rows: Array<Pick<ExportTarget, 'maHoSo' | 'maNhanVien' | 'tenNb' | 'cccd'>>,
  sourceFileName: string
): Promise<{ fileName: string; base64: string } | null> {
  if (rows.length === 0) {
    return null;
  }

  // Roster columns only when the interrupted batch actually had name fields.
  // Manual / code-only lists (CLS or KSK) stay a single "Mã hồ sơ" column.
  const keepRoster = rows.some(
    (row) => row.maNhanVien || row.tenNb || row.cccd
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.columns = keepRoster
    ? [
        { header: 'Mã hồ sơ', key: 'maHoSo', width: 18 },
        { header: 'Mã nhân viên', key: 'maNhanVien', width: 18 },
        { header: 'Tên NB', key: 'tenNb', width: 28 },
        { header: 'CCCD', key: 'cccd', width: 18 }
      ]
    : [{ header: 'Mã hồ sơ', key: 'maHoSo', width: 18 }];

  for (const row of rows) {
    sheet.addRow({
      maHoSo: row.maHoSo,
      maNhanVien: row.maNhanVien ?? '',
      tenNb: row.tenNb ?? '',
      cccd: row.cccd ?? ''
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer as ArrayBuffer);
  const base = remainingBaseName(sourceFileName);

  return {
    fileName: `${base}-con-lai.xlsx`,
    base64: bytesToBase64(bytes)
  };
}
