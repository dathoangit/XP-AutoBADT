import type { KskPaperKind } from '../core/export-target';

export const KSK_PAPER_LABEL: Record<KskPaperKind, string> = {
  'giay-06-18': 'Khám sức khỏe người từ đủ 06 đến dưới 18 tuổi',
  'so-dinh-ky': 'Giấy khám sức khỏe định kỳ'
};

function normalizeFormName(text: string): string {
  return text
    .replaceAll('đ', 'd')
    .replaceAll('Đ', 'D')
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .replaceAll(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Match HIS `tenBieuMau`, not the title printed on the PDF.
 * Official names: "Khám sức khỏe người từ đủ 06 đến dưới 18 tuổi"
 * and "Giấy khám sức khỏe định kỳ".
 */
export function matchesKskPaper(
  tenBieuMau: string,
  kind: KskPaperKind
): boolean {
  const label = normalizeFormName(tenBieuMau);
  if (!label) {
    return false;
  }

  // Accept "06" or bare "6" in the under-18 age band.
  const hasAge6 = label.includes('06') || /(^| )6( |$)/.test(label);
  const isUnder18 =
    label.includes('kham suc khoe') && hasAge6 && label.includes('18');

  if (kind === 'giay-06-18') {
    return isUnder18;
  }

  return (
    (label.includes('giay kham suc khoe dinh ky') ||
      label.includes('so kham suc khoe dinh ky')) &&
    !isUnder18
  );
}

/**
 * Full CLS: drop the periodic form; keep under-18 when recognized.
 * If HIS uses a variant under-18 name that does not match, keep remaining
 * non-periodic PDFs so the sheet is not dropped entirely.
 */
export function selectSignedPapersForFullCls<T extends { tenBieuMau: string }>(
  papers: T[]
): T[] {
  const withoutPeriodic = papers.filter(
    (paper) => !matchesKskPaper(paper.tenBieuMau, 'so-dinh-ky')
  );
  const under18 = withoutPeriodic.filter((paper) =>
    matchesKskPaper(paper.tenBieuMau, 'giay-06-18')
  );

  return under18.length > 0 ? under18 : withoutPeriodic;
}
