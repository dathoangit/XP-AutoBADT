import type { AuthPayload } from '../auth/types';
import {
  CLS_API_PATH,
  DEFAULT_CONCURRENCY,
  DEFAULT_DELAY_MS,
  HIS_HOST,
  PREVIEW_ONLY
} from '../config/env';
import { buildRemainingWorkbook } from '../excel/remaining-writer';
import {
  buildReportWorkbook,
  createReportRow,
  type ReportIssue,
  type ReportRow
} from '../excel/report-writer';
import { fetchClsResults } from '../his/cls-client';
import {
  buildFileDescriptors,
  type DescriptorSkip
} from '../his/file-descriptor';
import {
  matchesKskPaper,
  selectSignedPapersForFullCls,
  KSK_PAPER_LABEL
} from '../his/ksk-paper';
import { buildPreviewUrl } from '../his/preview-url';
import {
  fetchSignedPapers,
  signedPaperUrl,
  type SignedPaper
} from '../his/signed-client';
import type { ClsItem } from '../his/types';
import { closeTabSafe, openPreviewAndCapture } from '../pdf/extract-images';
import { imagesToPdf } from '../pdf/images-to-pdf';
import { mergePdfs } from '../pdf/merger';
import {
  fetchPdfBytes,
  resolvePdfUrl,
  tryFetchDirectPdf
} from '../pdf/pdf-fetcher';
import { bytesToBase64, sleep } from '../utils/download';
import {
  classifyError,
  errorMessage,
  ExportHaltError,
  HttpError,
  isAbortError,
  throwIfAborted
} from './errors';
import type { ExportMode, ExportTarget, KskPaperKind } from './export-target';
import { describeToken } from './session';

const NETWORK_RETRY_DELAYS_MS = [2000, 5000] as const;
const AUTH_RETRY_DELAYS_MS = [10_000, 15_000, 20_000] as const;
const AUTH_RETRY_MAX = AUTH_RETRY_DELAYS_MS.length;

export interface ExportHandlers {
  onProgress: (current: number, total: number, maHoSo: string) => void;
  onItemDone: (row: ReportRow) => void;
  onLog: (message: string) => void;
  loadAuth: (options?: {
    forceRefresh?: boolean;
  }) => Promise<AuthPayload | null>;
  savePdf: (fileName: string, base64: string) => Promise<void>;
  signal: AbortSignal;
}

function buildClsApiUrl(maHoSo: string): string {
  const params = new URLSearchParams({
    maHoSo,
    page: '0',
    sort: 'createdAt,desc',
    phieuMoiNhat: 'true',
    manHinhHienThi: '20',
    size: '999'
  });
  return `${HIS_HOST}${CLS_API_PATH}?${params.toString()}`;
}

function itemField(item: ClsItem, key: keyof ClsItem | string): string {
  const value = item[key as keyof ClsItem];
  return value === undefined || value === null ? '' : String(value);
}

function issueFromSkip(maHoSo: string, skip: DescriptorSkip): ReportIssue {
  return {
    maHoSo,
    index: skip.index,
    maBieuMau: itemField(skip.item, 'maBieuMau'),
    id: itemField(skip.item, 'id'),
    soPhieu: itemField(skip.item, 'soPhieu'),
    tenBieuMau: itemField(skip.item, 'tenBieuMau'),
    apiPath: itemField(skip.item, 'api') || itemField(skip.item, 'duongDan'),
    kind: 'skip',
    detail: skip.reason
  };
}

function summarizeIssues(
  issues: ReportIssue[],
  apiCount: number,
  descCount: number
): string {
  const parts: string[] = [];
  if (apiCount !== descCount) {
    parts.push(`API ${apiCount} → descriptor ${descCount}`);
  }

  const skips = issues.filter((i) => i.kind === 'skip').length;
  if (skips > 0) {
    parts.push(`${skips} phiếu thiếu field`);
  }

  const noUrl = issues.filter((i) => i.kind === 'no_direct_url').length;
  if (noUrl > 0) {
    parts.push(`${noUrl} thiếu path PDF gốc`);
  }

  const other = issues.filter(
    (i) => i.kind !== 'skip' && i.kind !== 'no_direct_url'
  );
  for (const issue of other.slice(0, 3)) {
    parts.push(issue.detail);
  }

  if (other.length > 3) {
    parts.push(`…+${other.length - 3}`);
  }

  return parts.join(' · ');
}

function cancelledRow(
  maHoSo: string,
  reason: string,
  issuesSummary?: string
): ReportRow {
  return createReportRow({
    maHoSo,
    status: 'cancelled',
    error: reason,
    issuesSummary: issuesSummary ?? reason
  });
}

function logAuthDebug(
  onLog: (message: string) => void,
  maHoSo: string,
  attempt: number,
  error: unknown,
  token: string | undefined
): void {
  const http = error instanceof HttpError ? error : null;
  const status = http?.status ?? '?';
  const url = http?.url || '(no url)';
  const signal = http?.signal || '(none)';
  const body = http?.bodyPreview ? JSON.stringify(http.bodyPreview) : '""';

  onLog(
    `[AUTH-DEBUG] ${maHoSo} lần ${attempt}/${AUTH_RETRY_MAX} · HTTP ${status} · GET ${url}`
  );
  onLog(
    `[AUTH-DEBUG] token ${token ? describeToken(token) : '(không có token)'}`
  );
  onLog(`[AUTH-DEBUG] signal=${signal} · body=${body}`);
}

function errorRow(maHoSo: string, message: string): ReportRow {
  return createReportRow({
    maHoSo,
    status: 'error',
    error: message,
    issuesSummary: message
  });
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function runWorker(): Promise<void> {
    while (next < items.length) {
      throwIfAborted(signal);
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => runWorker()
  );
  await Promise.all(runners);
  return results;
}

async function withNetworkRetry<T>(
  label: string,
  onLog: (message: string) => void,
  signal: AbortSignal,
  fn: () => Promise<T>
): Promise<T> {
  let lastError: unknown;

  for (
    let attempt = 0;
    attempt <= NETWORK_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const kind = classifyError(error);

      if (kind === 'aborted') {
        throw error;
      }

      // Do not convert session_expired here — runExportBatch retries auth.
      if (kind !== 'network' || attempt >= NETWORK_RETRY_DELAYS_MS.length) {
        throw error;
      }

      const delayMs = NETWORK_RETRY_DELAYS_MS[attempt];
      onLog(
        `[Mạng] ${label}: mất kết nối — thử lại sau ${delayMs / 1000}s (lần ${attempt + 1}/${NETWORK_RETRY_DELAYS_MS.length})`
      );
      await sleep(delayMs, signal);
    }
  }

  throw lastError;
}

async function processMaHoSoPreviewOnly(
  maHoSo: string,
  auth: AuthPayload,
  onLog: (message: string) => void,
  signal: AbortSignal
): Promise<ReportRow> {
  const apiUrl = buildClsApiUrl(maHoSo);
  onLog(`[API] GET ${apiUrl}`);
  const items = await withNetworkRetry('API CLS', onLog, signal, () =>
    fetchClsResults(maHoSo, auth, signal)
  );
  onLog(`[API] Response: ${items.length} phiếu`);
  const { descriptors, skipped } = buildFileDescriptors(items);
  const issues = skipped.map((skip) => issueFromSkip(maHoSo, skip));
  onLog(
    `[PREVIEW] descriptors=${descriptors.length}/${items.length} skipped=${skipped.length}`
  );

  if (descriptors.length === 0) {
    onLog(`[PREVIEW] ${maHoSo}: trống — bỏ qua mở URL`);
    return createReportRow({
      maHoSo,
      status: 'empty',
      apiItemCount: items.length,
      fileCount: 0,
      skippedCount: skipped.length,
      obtainedCount: 0,
      error:
        items.length > 0 ? 'No descriptors (thiếu field)' : 'No descriptors',
      issues,
      issuesSummary: summarizeIssues(issues, items.length, 0)
    });
  }

  const previewUrl = buildPreviewUrl(maHoSo, descriptors);
  onLog(`[PREVIEW] ${previewUrl}`);
  throwIfAborted(signal);
  await chrome.tabs.create({ url: previewUrl, active: true });
  return createReportRow({
    maHoSo,
    status: 'success',
    apiItemCount: items.length,
    fileCount: descriptors.length,
    skippedCount: skipped.length,
    obtainedCount: 0,
    outputPath: previewUrl,
    error: 'PREVIEW_ONLY',
    issues,
    issuesSummary: summarizeIssues(issues, items.length, descriptors.length)
  });
}

async function downloadSignedParts(
  maHoSo: string,
  papers: SignedPaper[],
  auth: AuthPayload,
  onLog: (message: string) => void,
  signal: AbortSignal
): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];

  for (const [index, paper] of papers.entries()) {
    const url = signedPaperUrl(paper.fileSauKy);
    onLog(
      `[KSK ${index + 1}] signed<>${paper.maBieuMau}<>${paper.id} ${paper.tenBieuMau}`
    );
    onLog(`[KSK ${index + 1}] ${url}`);
    const bytes = await withNetworkRetry(
      `KSK ${paper.maBieuMau}`,
      onLog,
      signal,
      () => fetchPdfBytes(url, auth, signal)
    );
    parts.push(bytes);
  }

  if (papers.length > 0) {
    onLog(`[KSK] ${maHoSo}: ${papers.length} giấy đã ký`);
  }

  return parts;
}

/**
 * Prefer direct PDF bytes; else capture react-pdf canvases / images → PDF.
 * Under-18 signed health papers from the signer API are placed before CLS
 * parts; periodic ("định kỳ") papers are skipped.
 */
async function processMaHoSoExport(
  target: ExportTarget,
  auth: AuthPayload,
  onLog: (message: string) => void,
  savePdf: (fileName: string, base64: string) => Promise<void>,
  signal: AbortSignal
): Promise<ReportRow> {
  const { maHoSo, fileName } = target;
  const apiUrl = buildClsApiUrl(maHoSo);
  onLog(`[API] GET ${apiUrl}`);

  const items = await withNetworkRetry('API CLS', onLog, signal, () =>
    fetchClsResults(maHoSo, auth, signal)
  );
  onLog(`[API] Response: ${items.length} phiếu`);

  for (const [index, item] of items.entries()) {
    onLog(
      `[ITEM ${index + 1}] maBieuMau=${String(item.maBieuMau ?? '')} id=${String(item.id ?? '')} soPhieu=${String(item.soPhieu ?? '')} api=${String(item.api ?? '')}`
    );
  }

  const { descriptors, skipped } = buildFileDescriptors(items);
  const issues: ReportIssue[] = skipped.map((skip) =>
    issueFromSkip(maHoSo, skip)
  );

  if (skipped.length > 0) {
    onLog(
      `[WARN] ${maHoSo}: API ${items.length} phiếu nhưng chỉ tạo được ${descriptors.length} descriptor (bỏ ${skipped.length})`
    );
    for (const skip of skipped) {
      onLog(`[SKIP ${skip.index}] ${skip.reason}`);
    }
  }

  const signed = await withNetworkRetry('API KSK', onLog, signal, () =>
    fetchSignedPapers(maHoSo, auth, signal)
  );
  const apiPaperNames =
    signed.papers
      .map((paper) => paper.tenBieuMau)
      .filter(Boolean)
      .join('; ') || '(rỗng)';
  onLog(`[KSK] API PDF: ${apiPaperNames}`);

  // Drop periodic form; keep under-18 (or non-periodic variants if name differs).
  const signedPapers = selectSignedPapersForFullCls(signed.papers);
  for (const paper of signed.skippedNonPdf) {
    onLog(
      `[KSK] bỏ qua signed<>${paper.maBieuMau}<>${paper.id} ${paper.tenBieuMau} — không phải PDF (${paper.fileSauKy})`
    );
  }
  for (const paper of signed.papers) {
    if (signedPapers.includes(paper)) {
      continue;
    }
    const reason = matchesKskPaper(paper.tenBieuMau, 'so-dinh-ky')
      ? KSK_PAPER_LABEL['so-dinh-ky']
      : `không phải ${KSK_PAPER_LABEL['giay-06-18']}`;
    onLog(`[KSK] bỏ qua ${paper.tenBieuMau || paper.maBieuMau} — ${reason}`);
  }
  if (signedPapers.length > 0) {
    onLog(
      `[KSK] giữ: ${signedPapers.map((paper) => paper.tenBieuMau).join('; ')}`
    );
  }
  const signedSkippedCount =
    signed.skippedNonPdf.length + (signed.papers.length - signedPapers.length);

  if (descriptors.length === 0 && signedPapers.length === 0) {
    return createReportRow({
      maHoSo,
      status: 'empty',
      apiItemCount: items.length,
      fileCount: 0,
      skippedCount: skipped.length + signedSkippedCount,
      obtainedCount: 0,
      error:
        items.length > 0 ? 'No descriptors (thiếu field)' : 'No descriptors',
      issues,
      issuesSummary: summarizeIssues(issues, items.length, 0)
    });
  }

  if (descriptors.length === 0) {
    const signedParts = await downloadSignedParts(
      maHoSo,
      signedPapers,
      auth,
      onLog,
      signal
    );
    const { bytes, pageCount } = await mergePdfs(signedParts);
    await savePdf(fileName, bytesToBase64(bytes));
    onLog(
      `[SAVE] ${fileName} · ${pageCount} trang · chỉ giấy KSK ${signedParts.length}`
    );

    return createReportRow({
      maHoSo,
      status: 'success',
      apiItemCount: items.length,
      fileCount: signedParts.length,
      skippedCount: skipped.length + signedSkippedCount,
      obtainedCount: signedParts.length,
      pageCount,
      directPdfCount: signedParts.length,
      outputPath: fileName,
      issues,
      issuesSummary: summarizeIssues(issues, items.length, 0)
    });
  }

  const directResults = await mapPool(
    descriptors,
    DEFAULT_CONCURRENCY,
    async (descriptor, index) => {
      const url = resolvePdfUrl(descriptor);
      onLog(`[PDF ${index + 1}] ${url ?? '(none)'}`);
      if (!url) {
        issues.push({
          maHoSo,
          index: index + 1,
          maBieuMau: descriptor.maBieuMau,
          id:
            descriptor.kind === 'cls'
              ? descriptor.key
              : itemField(descriptor.source, 'id'),
          soPhieu:
            descriptor.kind === 'xnlis'
              ? descriptor.key
              : itemField(descriptor.source, 'soPhieu'),
          tenBieuMau: itemField(descriptor.source, 'tenBieuMau'),
          apiPath: '',
          kind: 'no_direct_url',
          detail: `Descriptor ${descriptor.raw} — không có api/duongDan/fileUrl để tải PDF gốc`
        });
      }

      return tryFetchDirectPdf(descriptor, auth, signal);
    },
    signal
  );

  let parts = directResults.filter((b): b is Uint8Array => b !== null);
  let directPdfCount = parts.length;
  let htmlRenderCount = 0;
  let captureMode: 'direct' | 'network_pdf' | 'canvas' = 'direct';

  if (parts.length < descriptors.length) {
    onLog(
      `[capture] Direct PDF thiếu (${parts.length}/${descriptors.length}) — bắt PDF mạng / canvas đã vẽ`
    );

    const previewUrl = buildPreviewUrl(maHoSo, descriptors);
    onLog(`[PREVIEW] ${previewUrl}`);

    const { tabId, pdfParts, imageBytes } = await openPreviewAndCapture(
      previewUrl,
      onLog,
      signal
    );

    try {
      if (pdfParts.length > 0) {
        parts = pdfParts;
        htmlRenderCount = 0;
        directPdfCount = pdfParts.length;
        captureMode = 'network_pdf';
        onLog(`[capture] Using ${pdfParts.length} intercepted PDF(s)`);
        if (pdfParts.length !== descriptors.length) {
          issues.push({
            maHoSo,
            index: 0,
            maBieuMau: '',
            id: '',
            soPhieu: '',
            tenBieuMau: '',
            apiPath: previewUrl,
            kind: 'count_mismatch',
            detail: `Preview bắt được ${pdfParts.length} PDF nhưng descriptor kỳ vọng ${descriptors.length}`
          });
        }
      } else if (imageBytes.length > 0) {
        const { bytes, pageCount } = await imagesToPdf(imageBytes);
        onLog(`[capture] Built PDF from ${pageCount} non-blank canvas page(s)`);
        parts = [bytes];
        htmlRenderCount = pageCount;
        directPdfCount = 0;
        captureMode = 'canvas';
        issues.push({
          maHoSo,
          index: 0,
          maBieuMau: '',
          id: '',
          soPhieu: '',
          tenBieuMau: '',
          apiPath: previewUrl,
          kind: 'canvas_fallback',
          detail: `Dùng canvas fallback (${pageCount} trang) — không so khớp 1-1 với ${descriptors.length} descriptor`
        });
      } else {
        return createReportRow({
          maHoSo,
          status: 'error',
          apiItemCount: items.length,
          fileCount: descriptors.length,
          skippedCount: skipped.length + signedSkippedCount,
          obtainedCount: 0,
          directPdfCount,
          htmlRenderCount,
          error: 'Không bắt được PDF mạng và cũng không có canvas đã vẽ',
          issues,
          issuesSummary: summarizeIssues(
            issues,
            items.length,
            descriptors.length
          )
        });
      }
    } finally {
      await closeTabSafe(tabId);
    }
  }

  throwIfAborted(signal);

  if (parts.length === 0) {
    return createReportRow({
      maHoSo,
      status: 'error',
      apiItemCount: items.length,
      fileCount: descriptors.length,
      skippedCount: skipped.length + signedSkippedCount,
      obtainedCount: 0,
      directPdfCount,
      htmlRenderCount,
      error: 'No PDF parts produced',
      issues,
      issuesSummary: summarizeIssues(issues, items.length, descriptors.length)
    });
  }

  const signedParts = await downloadSignedParts(
    maHoSo,
    signedPapers,
    auth,
    onLog,
    signal
  );
  // Health form first, then CLS results — easier to spot in the merged PDF.
  const mergedParts = [...signedParts, ...parts];
  const { bytes, pageCount } = await mergePdfs(mergedParts);
  await savePdf(fileName, bytesToBase64(bytes));
  const kskNote =
    signedParts.length > 0
      ? ` · giấy KSK ${signedParts.length} (đầu file)`
      : '';
  onLog(
    `[SAVE] ${fileName} · ${pageCount} trang · API ${items.length} → desc ${descriptors.length} → PDF parts ${parts.length} (${captureMode})${kskNote}`
  );

  return createReportRow({
    maHoSo,
    status: 'success',
    apiItemCount: items.length,
    fileCount: descriptors.length,
    skippedCount: skipped.length + signedSkippedCount,
    obtainedCount: mergedParts.length,
    pageCount,
    directPdfCount,
    htmlRenderCount,
    outputPath: fileName,
    error: '',
    issues,
    issuesSummary: summarizeIssues(issues, items.length, descriptors.length)
  });
}

/**
 * Signed health papers only. Does not call the CLS API or open a preview tab.
 */
async function processMaHoSoKskOnly(
  target: ExportTarget,
  paperKind: KskPaperKind,
  auth: AuthPayload,
  onLog: (message: string) => void,
  savePdf: (fileName: string, base64: string) => Promise<void>,
  signal: AbortSignal
): Promise<ReportRow> {
  const { maHoSo, fileName } = target;
  const paperLabel = KSK_PAPER_LABEL[paperKind];
  onLog(`[KSK] ${maHoSo} → ${fileName} · ${paperLabel}`);

  const signed = await withNetworkRetry('API KSK', onLog, signal, () =>
    fetchSignedPapers(maHoSo, auth, signal)
  );

  for (const paper of signed.skippedNonPdf) {
    onLog(
      `[KSK] bỏ qua signed<>${paper.maBieuMau}<>${paper.id} ${paper.tenBieuMau} — không phải PDF (${paper.fileSauKy})`
    );
  }

  const papers = signed.papers.filter((paper) =>
    matchesKskPaper(paper.tenBieuMau, paperKind)
  );
  for (const paper of signed.papers) {
    if (!matchesKskPaper(paper.tenBieuMau, paperKind)) {
      onLog(
        `[KSK] bỏ qua ${paper.tenBieuMau || paper.maBieuMau} — khác loại đã chọn`
      );
    }
  }

  if (papers.length === 0) {
    const found = signed.papers
      .map((paper) => paper.tenBieuMau)
      .filter(Boolean)
      .join('; ');
    const message = found
      ? `Không có "${paperLabel}". Có: ${found}`
      : `Không có "${paperLabel}"`;
    return createReportRow({
      maHoSo,
      status: 'empty',
      skippedCount: signed.skippedNonPdf.length + signed.papers.length,
      error: message,
      issuesSummary: message
    });
  }

  const signedParts = await downloadSignedParts(
    maHoSo,
    papers,
    auth,
    onLog,
    signal
  );
  const { bytes, pageCount } = await mergePdfs(signedParts);
  await savePdf(fileName, bytesToBase64(bytes));
  onLog(
    `[SAVE] ${fileName} · ${pageCount} trang · ${paperLabel} · ${signedParts.length} file`
  );

  return createReportRow({
    maHoSo,
    status: 'success',
    fileCount: signedParts.length,
    skippedCount:
      signed.skippedNonPdf.length + (signed.papers.length - papers.length),
    obtainedCount: signedParts.length,
    pageCount,
    directPdfCount: signedParts.length,
    outputPath: fileName
  });
}

function isPreviewMiss(row: ReportRow): boolean {
  const error = row.error || '';
  return (
    error.includes('Không bắt được PDF mạng') ||
    error.includes('No PDF parts produced')
  );
}

export async function runExportBatch(
  targets: ExportTarget[],
  _initialAuth: AuthPayload,
  sourceFileName: string,
  handlers: ExportHandlers,
  mode: ExportMode = 'cls',
  kskPaperKind?: KskPaperKind
): Promise<{
  rows: ReportRow[];
  reportFileName: string;
  reportBase64: string;
  remainingFileName?: string;
  remainingBase64?: string;
  remainingCount?: number;
}> {
  const rows: ReportRow[] = [];
  const { signal } = handlers;
  /** Targets whose preview missed; retried later without stopping the batch. */
  const previewMisses: ExportTarget[] = [];
  /** First index of targets that still need a run (failed current + not yet run). */
  let remainingStartIndex = targets.length;

  handlers.onLog(
    mode === 'ksk'
      ? `=== Export: ${kskPaperKind ? KSK_PAPER_LABEL[kskPaperKind] : 'phiếu khám sức khỏe'} ===`
      : PREVIEW_ONLY
        ? '=== PREVIEW_ONLY: chỉ mở tab ==='
        : '=== Export: PDF gốc hoặc capture canvas/ảnh → PDF ==='
  );

  for (let i = 0; i < targets.length; i += 1) {
    if (signal.aborted) {
      handlers.onLog('Đã dừng theo yêu cầu người dùng.');
      remainingStartIndex = i;
      const row = cancelledRow(targets[i].maHoSo, 'stopped_by_user');
      rows.push(row);
      handlers.onItemDone(row);
      break;
    }

    const target = targets[i];
    const maHoSo = target.maHoSo;
    handlers.onProgress(i + 1, targets.length, maHoSo);

    let auth = await handlers.loadAuth();
    // Do not halt on JWT exp alone — storage can lag behind HIS refresh.
    // Only stop when there is no token at all; real 401/403 still halt below.
    if (!auth?.access_token) {
      handlers.onLog(
        'Không có token. Mở tab HIS và đăng nhập lại, rồi chạy file còn lại.'
      );
      const row = cancelledRow(maHoSo, 'session_expired');
      rows.push(row);
      handlers.onItemDone(row);
      remainingStartIndex = i;
      break;
    }

    let row: ReportRow | null = null;
    let halted = false;
    let authRetryCount = 0;

    while (!halted && !row) {
      try {
        row =
          mode === 'ksk'
            ? await processMaHoSoKskOnly(
                target,
                kskPaperKind ?? 'giay-06-18',
                auth,
                handlers.onLog,
                handlers.savePdf,
                signal
              )
            : PREVIEW_ONLY
              ? await processMaHoSoPreviewOnly(
                  maHoSo,
                  auth,
                  handlers.onLog,
                  signal
                )
              : await processMaHoSoExport(
                  target,
                  auth,
                  handlers.onLog,
                  handlers.savePdf,
                  signal
                );
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          handlers.onLog(`[DỪNG] ${maHoSo}: đã hủy`);
          row = cancelledRow(maHoSo, 'stopped_by_user');
          halted = true;
          break;
        }

        if (error instanceof ExportHaltError) {
          handlers.onLog(`[DỪNG] ${error.message}`);
          row = cancelledRow(maHoSo, error.reason);
          halted = true;
          break;
        }

        const kind = classifyError(error);
        const message = errorMessage(error);

        if (kind === 'session_expired' && authRetryCount < AUTH_RETRY_MAX) {
          authRetryCount += 1;
          logAuthDebug(
            handlers.onLog,
            maHoSo,
            authRetryCount,
            error,
            auth.access_token
          );

          const delayMs = AUTH_RETRY_DELAYS_MS[authRetryCount - 1] ?? 0;
          if (delayMs > 0) {
            handlers.onLog(
              `[Auth] ${maHoSo}: chờ ${delayMs / 1000}s rồi refresh token (lần ${authRetryCount}/${AUTH_RETRY_MAX})…`
            );
            try {
              await sleep(delayMs, signal);
            } catch {
              handlers.onLog(`[DỪNG] ${maHoSo}: đã hủy`);
              row = cancelledRow(maHoSo, 'stopped_by_user');
              halted = true;
              break;
            }
          } else {
            handlers.onLog(
              `[Auth] ${maHoSo}: API báo hết phiên — thử lấy token mới từ tab HIS (lần ${authRetryCount}/${AUTH_RETRY_MAX})…`
            );
          }

          const previousToken = auth.access_token;
          const refreshed = await handlers.loadAuth({ forceRefresh: true });
          if (refreshed?.access_token) {
            const changed = refreshed.access_token !== previousToken;
            handlers.onLog(
              `[AUTH-DEBUG] refresh: token ${describeToken(previousToken)} → ${describeToken(refreshed.access_token)} (${changed ? 'đã đổi' : 'không đổi'})`
            );
            auth = refreshed;
            continue;
          }

          handlers.onLog(
            `[AUTH-DEBUG] refresh: không lấy được token từ tab HIS (giữ token cũ)`
          );
          continue;
        }

        if (kind === 'session_expired') {
          const http = error instanceof HttpError ? error : null;
          const detail = [
            http ? `HTTP ${http.status}` : message,
            http?.url ? `GET ${http.url}` : '',
            `đã refresh token ${AUTH_RETRY_MAX} lần`
          ]
            .filter(Boolean)
            .join(' — ');

          handlers.onLog(
            `[DỪNG] Phiên hết hạn tại ${maHoSo} sau ${AUTH_RETRY_MAX} lần refresh. Đăng nhập lại trên tab HIS.`
          );
          handlers.onLog(`[AUTH-DEBUG] ${detail}`);
          row = cancelledRow(maHoSo, 'session_expired', detail);
          halted = true;
          break;
        }

        if (kind === 'timeout') {
          handlers.onLog(`[DỪNG] ${maHoSo}: timeout — ${message}`);
          row = errorRow(maHoSo, `timeout: ${message}`);
          halted = true;
          break;
        }

        if (kind === 'network') {
          handlers.onLog(`[DỪNG] ${maHoSo}: mất mạng — ${message}`);
          row = errorRow(maHoSo, `network: ${message}`);
          halted = true;
          break;
        }

        handlers.onLog(`[DỪNG] ${maHoSo}: ${message}`);
        row = errorRow(maHoSo, message);
        halted = true;
        break;
      }
    }

    if (!row) {
      break;
    }

    rows.push(row);
    handlers.onItemDone(row);

    if (!halted && row.status === 'error' && isPreviewMiss(row)) {
      previewMisses.push(target);
      handlers.onLog(
        `[BỎ QUA] ${maHoSo}: không bắt được PDF preview — ghi vào file còn lại, chạy mã tiếp`
      );
      remainingStartIndex = i + 1;
    } else if (halted || row.status === 'error' || row.status === 'cancelled') {
      if (row.status === 'error') {
        handlers.onLog(`[DỪNG] ${maHoSo}: ${row.error || 'lỗi'}`);
      }
      remainingStartIndex = i;
      break;
    }

    remainingStartIndex = i + 1;

    // Skip inter-item delay when empty — no PDF/tab work, move on immediately
    if (row.status !== 'empty' && i < targets.length - 1 && !signal.aborted) {
      try {
        await sleep(DEFAULT_DELAY_MS, signal);
      } catch {
        handlers.onLog('Đã dừng theo yêu cầu người dùng.');
        remainingStartIndex = i + 1;
        break;
      }
    }
  }

  const report = await buildReportWorkbook(rows, sourceFileName);
  handlers.onLog(`[SAVE] Báo cáo ${report.fileName}`);

  const codesToRetry = [
    ...previewMisses,
    ...targets.slice(remainingStartIndex)
  ];
  const remaining = await buildRemainingWorkbook(codesToRetry, sourceFileName);
  if (remaining) {
    handlers.onLog(
      `[SAVE] Còn lại ${codesToRetry.length} mã → ${remaining.fileName}`
    );
  }

  return {
    rows,
    reportFileName: report.fileName,
    reportBase64: report.base64,
    ...(remaining
      ? {
          remainingFileName: remaining.fileName,
          remainingBase64: remaining.base64,
          remainingCount: codesToRetry.length
        }
      : {})
  };
}
