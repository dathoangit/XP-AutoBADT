import type { ReportIssue, ReportRow } from '../excel/report-writer';

export type ErrorGroup =
  | 'empty_missing_fields'
  | 'network'
  | 'timeout'
  | 'session_expired'
  | 'no_pdf'
  | 'count_mismatch'
  | 'canvas_fallback'
  | 'skip_field'
  | 'cancelled'
  | 'other';

export interface RunErrorDetail {
  maHoSo: string;
  status: string;
  group: ErrorGroup;
  detail: string;
  issuesSummary: string;
}

export interface ErrorGroupSummary {
  group: ErrorGroup;
  count: number;
  examples: string[];
}

export interface RunSummary {
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  username: string;
  sourceFileName: string;
  total: number;
  success: number;
  empty: number;
  error: number;
  cancelled: number;
  haltReason: string;
  errorAnalysis: string;
  errors: RunErrorDetail[];
}

const MAX_EXAMPLES = 3;

function classifyIssueKind(kind: string): ErrorGroup {
  switch (kind) {
    case 'skip':
      return 'skip_field';
    case 'no_direct_url':
      return 'no_pdf';
    case 'count_mismatch':
      return 'count_mismatch';
    case 'canvas_fallback':
      return 'canvas_fallback';
    default:
      return 'other';
  }
}

function classifyRowError(row: ReportRow): ErrorGroup {
  const err = (row.error || '').toLowerCase();
  if (err.includes('timeout')) {
    return 'timeout';
  }

  if (err.includes('network')) {
    return 'network';
  }

  if (
    err.includes('session_expired') ||
    err.includes('401') ||
    err.includes('403')
  ) {
    return 'session_expired';
  }

  if (row.status === 'cancelled') {
    return 'cancelled';
  }

  if (row.status === 'empty') {
    return 'empty_missing_fields';
  }

  if (err.includes('pdf') || err.includes('không lấy được')) {
    return 'no_pdf';
  }

  return 'other';
}

function isTimeoutRow(row: ReportRow): boolean {
  return (
    row.status === 'error' &&
    (row.error || '').toLowerCase().includes('timeout')
  );
}

function emptyRowDetail(row: ReportRow): string {
  if (row.apiItemCount === 0) {
    return 'Trống: API không trả phiếu CLS nào';
  }

  if (row.skippedCount > 0 || row.fileCount === 0) {
    return (
      row.issuesSummary ||
      row.error ||
      `Trống: có ${row.apiItemCount} phiếu nhưng thiếu field, không tạo được descriptor`
    );
  }

  return row.issuesSummary || row.error || 'Trống: không có PDF để xuất';
}

function errorRowDetail(row: ReportRow): string {
  const raw = (row.error || row.issuesSummary || '').trim();
  if (!raw) {
    return 'Lỗi: không lấy được PDF';
  }

  if (raw.toLowerCase().startsWith('network:')) {
    return `Mất mạng: ${raw.slice('network:'.length).trim() || raw}`;
  }

  if (raw.toLowerCase().includes('no pdf')) {
    return `Lỗi PDF: ${raw}`;
  }

  return `Lỗi: ${raw}`;
}

function cancelledRowDetail(row: ReportRow): string {
  const reason = (row.error || '').trim();
  switch (reason) {
    case 'session_expired':
      return 'Dừng: hết phiên đăng nhập HIS';
    case 'stopped_by_user':
      return 'Dừng: người dùng bấm Dừng';
    case 'network':
      return 'Dừng: mất mạng';
    case 'timeout':
      return 'Dừng: timeout';
    default:
      return reason ? `Dừng: ${reason}` : 'Dừng giữa chừng';
  }
}

function detectHaltReason(rows: ReportRow[]): string {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.status === 'cancelled') {
      return (row.error || '').trim() || 'cancelled';
    }

    if (row.status === 'error') {
      const err = (row.error || '').toLowerCase();
      if (err.includes('timeout')) {
        return 'timeout';
      }

      if (err.includes('network')) {
        return 'network';
      }

      return 'error';
    }
  }

  return '';
}

function pushError(
  errors: RunErrorDetail[],
  row: ReportRow,
  group: ErrorGroup,
  detail: string
): void {
  errors.push({
    maHoSo: row.maHoSo,
    status: row.status,
    group,
    detail,
    issuesSummary: row.issuesSummary || detail
  });
}

function collectErrors(rows: ReportRow[]): RunErrorDetail[] {
  const errors: RunErrorDetail[] = [];

  for (const row of rows) {
    // Timeout: ghi Lan_chay (haltReason) thôi, không đẩy Chi_tiet_loi
    if (isTimeoutRow(row)) {
      continue;
    }

    if (row.status === 'empty') {
      pushError(errors, row, 'empty_missing_fields', emptyRowDetail(row));
      for (const issue of row.issues) {
        pushError(
          errors,
          row,
          classifyIssueKind(issue.kind),
          formatIssueDetail(issue)
        );
      }
      continue;
    }

    if (row.status === 'error') {
      pushError(errors, row, classifyRowError(row), errorRowDetail(row));
      for (const issue of row.issues) {
        pushError(
          errors,
          row,
          classifyIssueKind(issue.kind),
          formatIssueDetail(issue)
        );
      }
      continue;
    }

    if (row.status === 'cancelled') {
      // timeout cancel (nếu có) cũng bỏ; còn lại ghi lý do dừng rõ
      if ((row.error || '').toLowerCase().includes('timeout')) {
        continue;
      }

      pushError(errors, row, 'cancelled', cancelledRowDetail(row));
      continue;
    }

    // success with issues worth tracking (skips, mismatches, canvas fallback)
    for (const issue of row.issues) {
      const group = classifyIssueKind(issue.kind);
      if (group === 'other') {
        continue;
      }

      pushError(errors, row, group, formatIssueDetail(issue));
    }
  }

  return errors;
}

function formatIssueDetail(issue: ReportIssue): string {
  const label = issue.tenBieuMau || issue.maBieuMau || `index ${issue.index}`;
  return `${issue.kind}: ${label} — ${issue.detail}`;
}

function groupErrorAnalysis(errors: RunErrorDetail[]): string {
  const byGroup = new Map<ErrorGroup, { count: number; examples: string[] }>();

  for (const err of errors) {
    let entry = byGroup.get(err.group);
    if (!entry) {
      entry = { count: 0, examples: [] };
      byGroup.set(err.group, entry);
    }

    entry.count += 1;
    if (
      entry.examples.length < MAX_EXAMPLES &&
      !entry.examples.includes(err.maHoSo)
    ) {
      entry.examples.push(err.maHoSo);
    }
  }

  const parts: string[] = [];
  for (const [group, { count, examples }] of byGroup) {
    const sample = examples.length > 0 ? ` (${examples.join(', ')})` : '';
    parts.push(`${group}: ${count}${sample}`);
  }

  return parts.join(' · ');
}

export function buildRunSummary(input: {
  rows: ReportRow[];
  startedAt: string;
  endedAt: string;
  username: string;
  sourceFileName: string;
}): RunSummary {
  const { rows, startedAt, endedAt, username, sourceFileName } = input;
  const startedMs = Date.parse(startedAt);
  const endedMs = Date.parse(endedAt);
  const durationSeconds =
    Number.isFinite(startedMs) && Number.isFinite(endedMs)
      ? Math.max(0, Math.round((endedMs - startedMs) / 1000))
      : 0;

  const success = rows.filter((r) => r.status === 'success').length;
  const empty = rows.filter((r) => r.status === 'empty').length;
  const error = rows.filter((r) => r.status === 'error').length;
  const cancelled = rows.filter((r) => r.status === 'cancelled').length;
  const errors = collectErrors(rows);

  return {
    startedAt,
    endedAt,
    durationSeconds,
    username: username || '',
    sourceFileName: sourceFileName || '',
    total: rows.length,
    success,
    empty,
    error,
    cancelled,
    haltReason: detectHaltReason(rows),
    errorAnalysis: groupErrorAnalysis(errors),
    errors
  };
}
