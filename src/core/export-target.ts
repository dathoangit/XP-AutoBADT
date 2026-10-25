export type ExportMode = 'cls' | 'ksk';

/** Which signed health form the KSK flow keeps. */
export type KskPaperKind = 'giay-06-18' | 'so-dinh-ky';

export interface ExportTarget {
  maHoSo: string;
  /** PDF file name including `.pdf`. */
  fileName: string;
  /** Original employee-code cell. Kept so a remaining workbook can rebuild the PDF name. */
  maNhanVien?: string;
  tenNb?: string;
  cccd?: string;
}
