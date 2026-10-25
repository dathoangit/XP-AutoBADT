import * as XLSX from 'xlsx';

export interface KskRosterRow {
  maHoSo: string;
  /** Original cell value, including any prefix before "-". */
  maNhanVien: string;
  tenNb: string;
  cccd: string;
}

const HEADER_SCAN_ROWS = 20;
const ILLEGAL_FILE_CHARS = /[\\/:*?"<>|]/g;

function collapseWhitespace(text: string): string {
  return text
    .replaceAll(/\r\n|\n|\r/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function stripDiacritics(text: string): string {
  return text.normalize('NFD').replaceAll(/\p{M}/gu, '');
}

function cellToText(raw: unknown): string {
  if (raw === null || raw === undefined) {
    return '';
  }

  if (
    typeof raw === 'string' ||
    typeof raw === 'number' ||
    typeof raw === 'boolean'
  ) {
    return collapseWhitespace(String(raw));
  }

  if (raw instanceof Date) {
    return collapseWhitespace(raw.toISOString());
  }

  return collapseWhitespace(String(raw));
}

function normalizeHeader(value: unknown): string {
  return stripDiacritics(cellToText(value)).toLowerCase();
}

function isMaHoSoHeader(label: string): boolean {
  return (
    label.includes('ma ho so') ||
    label === 'mahoso' ||
    label === 'ma hs' ||
    label === 'mahs'
  );
}

function isMaNhanVienHeader(label: string): boolean {
  return label === 'ma nhan vien';
}

function isTenNbHeader(label: string): boolean {
  return label === 'ten nb';
}

function findCccdColumn(row: unknown[]): number {
  let contains = -1;
  for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
    const label = normalizeHeader(row[colIndex]);
    if (label === 'cccd') {
      return colIndex;
    }
    if (contains < 0 && label.includes('cccd')) {
      contains = colIndex;
    }
  }

  return contains;
}

function findColumn(
  row: unknown[],
  matches: (label: string) => boolean
): number {
  for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
    if (matches(normalizeHeader(row[colIndex]))) {
      return colIndex;
    }
  }

  return -1;
}

/**
 * Employee code used in the PDF name: the segment after the last "-",
 * then drop the word "lớp" ("lớp 9A" → "9A").
 */
export function employeeCodeForFile(maNhanVien: string): string {
  const trimmed = maNhanVien.trim();
  const dash = trimmed.lastIndexOf('-');
  const segment = dash >= 0 ? trimmed.slice(dash + 1).trim() : trimmed;

  return segment
    .replace(/lớp/giu, '')
    .replace(/lop/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeFilePart(value: string): string {
  return value
    .replaceAll(ILLEGAL_FILE_CHARS, '_')
    .replace(/[.\s]+$/u, '')
    .trim();
}

function joinFileStem(parts: string[]): string {
  return parts.filter(Boolean).join('_');
}

/**
 * `{prefix}_{employeeCode}_{patientName}_{cccd}.pdf`.
 * An empty prefix or employee code is omitted.
 * A repeated name in the same batch inserts `_{maHoSo}` before CCCD.
 */
export function assignKskFileNames(
  prefix: string,
  rows: KskRosterRow[]
): Array<KskRosterRow & { fileName: string }> {
  const safePrefix = sanitizeFilePart(prefix);
  const used = new Set<string>();

  return rows.map((row, index) => {
    const code = sanitizeFilePart(employeeCodeForFile(row.maNhanVien));
    const name = sanitizeFilePart(row.tenNb);
    const cccd = sanitizeFilePart(row.cccd);
    if (!name) {
      throw new Error(`Hồ sơ ${row.maHoSo} thiếu tên để đặt tên file`);
    }

    let stem = joinFileStem([safePrefix, code, name, cccd]);
    let fileName = `${stem}.pdf`;
    if (used.has(fileName.toLowerCase())) {
      const safeCode = sanitizeFilePart(row.maHoSo) || String(index + 1);
      stem = joinFileStem([safePrefix, code, name, safeCode, cccd]);
      fileName = `${stem}.pdf`;
    }

    if (used.has(fileName.toLowerCase())) {
      stem = joinFileStem([safePrefix, code, name, String(index + 1), cccd]);
      fileName = `${stem}.pdf`;
    }

    used.add(fileName.toLowerCase());
    return { ...row, fileName };
  });
}

/**
 * Read the KSK roster from the first worksheet.
 * Columns are matched by header name on the same row, not by position.
 */
export async function readKskRoster(
  buffer: ArrayBuffer
): Promise<KskRosterRow[]> {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const firstName = workbook.SheetNames[0];
  if (!firstName) {
    throw new Error('Workbook has no worksheets');
  }

  const sheet = workbook.Sheets[firstName];
  const rows = XLSX.utils.sheet_to_json<
    (string | number | boolean | Date | null)[]
  >(sheet, {
    header: 1,
    defval: '',
    blankrows: true,
    raw: false
  });

  const maxScanRows = Math.min(rows.length, HEADER_SCAN_ROWS);
  let headerRowIndex = -1;
  let maHoSoCol = -1;

  for (let rowIndex = 0; rowIndex < maxScanRows; rowIndex += 1) {
    const col = findColumn(rows[rowIndex] ?? [], isMaHoSoHeader);
    if (col >= 0) {
      headerRowIndex = rowIndex;
      maHoSoCol = col;
      break;
    }
  }

  const headerRow = headerRowIndex >= 0 ? (rows[headerRowIndex] ?? []) : [];
  const maNhanVienCol =
    headerRowIndex >= 0 ? findColumn(headerRow, isMaNhanVienHeader) : -1;
  const tenNbCol =
    headerRowIndex >= 0 ? findColumn(headerRow, isTenNbHeader) : -1;
  const cccdCol = headerRowIndex >= 0 ? findCccdColumn(headerRow) : -1;

  const missing: string[] = [];
  if (maHoSoCol < 0) {
    missing.push('Mã hồ sơ');
  }
  if (tenNbCol < 0) {
    missing.push('Tên NB');
  }

  if (missing.length > 0) {
    throw new Error(`Không tìm thấy cột: ${missing.join(', ')}`);
  }

  const seen = new Set<string>();
  const result: KskRosterRow[] = [];

  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex < rows.length;
    rowIndex += 1
  ) {
    const row = rows[rowIndex] ?? [];
    const maHoSo = cellToText(row[maHoSoCol]);
    if (!maHoSo || seen.has(maHoSo)) {
      continue;
    }

    const maNhanVien = maNhanVienCol >= 0 ? cellToText(row[maNhanVienCol]) : '';
    const tenNb = cellToText(row[tenNbCol]);
    const cccd = cccdCol >= 0 ? cellToText(row[cccdCol]) : '';
    const missingFields: string[] = [];
    if (!tenNb) {
      missingFields.push('Tên NB');
    }

    if (missingFields.length > 0) {
      throw new Error(
        `Dòng ${rowIndex + 1} (mã hồ sơ ${maHoSo}) thiếu ${missingFields.join(', ')}`
      );
    }

    seen.add(maHoSo);
    result.push({ maHoSo, maNhanVien, tenNb, cccd });
  }

  return result;
}
