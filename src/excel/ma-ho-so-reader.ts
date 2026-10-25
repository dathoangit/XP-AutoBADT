import * as XLSX from 'xlsx';

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

/**
 * Read unique maHoSo values from the first worksheet (.xlsx or .xls).
 */
export async function readMaHoSoList(buffer: ArrayBuffer): Promise<string[]> {
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
    blankrows: false,
    raw: false
  });

  if (rows.length === 0) {
    return [];
  }

  let targetCol = 0;
  let dataStartRow = 0;
  let foundHeader = false;

  const maxScanRows = Math.min(rows.length, 20);
  for (let rowIndex = 0; rowIndex < maxScanRows; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
      const label = normalizeHeader(row[colIndex]);
      if (!foundHeader && isMaHoSoHeader(label)) {
        targetCol = colIndex;
        dataStartRow = rowIndex + 1;
        foundHeader = true;
        break;
      }
    }

    if (foundHeader) {
      break;
    }
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (let rowIndex = dataStartRow; rowIndex < rows.length; rowIndex += 1) {
    const value = cellToText(rows[rowIndex]?.[targetCol]);
    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}
