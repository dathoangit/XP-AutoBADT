import type { AuthPayload } from '../auth/types';
import type {
  ExportMode,
  ExportTarget,
  KskPaperKind
} from '../core/export-target';
import type { AuthResponse, RuntimeMessage } from '../config/messages';
import {
  assignKskFileNames,
  readKskRoster,
  type KskRosterRow
} from '../excel/ksk-roster-reader';
import { readMaHoSoList } from '../excel/ma-ho-so-reader';
import type { ReportRow } from '../excel/report-writer';
import { base64ToBytes } from '../utils/download';

const authBadge = document.getElementById('auth-badge') as HTMLSpanElement;
const authDetail = document.getElementById(
  'auth-detail'
) as HTMLParagraphElement;
const manualInput = document.getElementById(
  'manual-input'
) as HTMLTextAreaElement;
const manualSummary = document.getElementById(
  'manual-summary'
) as HTMLParagraphElement;
const kindBlock = document.getElementById('ksk-kind-block') as HTMLElement;
const prefixInput = document.getElementById('prefix-input') as HTMLInputElement;
const excelLabel = document.getElementById('excel-label') as HTMLLabelElement;
const excelInput = document.getElementById('excel-input') as HTMLInputElement;
const excelSummary = document.getElementById(
  'excel-summary'
) as HTMLParagraphElement;
const folderSummary = document.getElementById(
  'folder-summary'
) as HTMLParagraphElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const progressEl = document.getElementById('progress') as HTMLParagraphElement;
const logEl = document.getElementById('log') as HTMLUListElement;
const modeInputs = document.querySelectorAll<HTMLInputElement>(
  'input[name="export-mode"]'
);
const kindInputs = document.querySelectorAll<HTMLInputElement>(
  'input[name="ksk-kind"]'
);

let auth: AuthPayload | null = null;
let mode: ExportMode = 'cls';
let excelList: string[] = [];
let kskRows: KskRosterRow[] = [];
let excelBuffer: ArrayBuffer | null = null;
let excelFileName = '';
let excelReadError = '';
let running = false;
let directoryHandle: FileSystemDirectoryHandle | null = null;

/**
 * Parse codes from textarea: split by newline / comma / semicolon.
 */
function parseManualList(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const part of raw.split(/[\n,;]+/)) {
    const value = part.trim();
    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

function selectedPaperKind(): KskPaperKind {
  for (const input of kindInputs) {
    if (input.checked && input.value === 'so-dinh-ky') {
      return 'so-dinh-ky';
    }
  }

  return 'giay-06-18';
}

function selectedMode(): ExportMode {
  for (const input of modeInputs) {
    if (input.checked && input.value === 'ksk') {
      return 'ksk';
    }
  }

  return 'cls';
}

function clsTargets(codes: string[]): ExportTarget[] {
  return codes.map((maHoSo) => ({
    maHoSo,
    fileName: `${maHoSo}.pdf`
  }));
}

function rosterTargets(): ExportTarget[] {
  const named = assignKskFileNames(prefixInput.value.trim(), kskRows);
  return named.map((row) => ({
    maHoSo: row.maHoSo,
    fileName: row.fileName,
    maNhanVien: row.maNhanVien,
    tenNb: row.tenNb,
    cccd: row.cccd
  }));
}

/**
 * Prefer manual input when it has codes; otherwise use Excel.
 * Roster rows (KSK, or full CLS with name columns) use the optional file-name prefix.
 * Manual / code-only lists save as `{maHoSo}.pdf`.
 */
function resolveInput(): {
  targets: ExportTarget[];
  sourceFileName: string;
} | null {
  const manualList = parseManualList(manualInput.value);
  if (manualList.length > 0) {
    return { targets: clsTargets(manualList), sourceFileName: 'nhap-tay.xlsx' };
  }

  if (kskRows.length > 0 && !excelReadError) {
    try {
      return {
        targets: rosterTargets(),
        sourceFileName: excelFileName || 'excel.xlsx'
      };
    } catch {
      return null;
    }
  }

  if (excelList.length > 0 && !excelReadError) {
    return {
      targets: clsTargets(excelList),
      sourceFileName: excelFileName || 'excel.xlsx'
    };
  }

  return null;
}

function setAuthUi(next: AuthPayload | null): void {
  auth = next;
  if (next?.access_token) {
    authBadge.textContent = `OK · ${next.username ?? 'user'}`;
    authBadge.className = 'badge badge-on';
    authDetail.textContent = 'Token đã lấy từ phiên đăng nhập HIS.';
  } else {
    authBadge.textContent = 'Chưa có token';
    authBadge.className = 'badge badge-off';
    authDetail.innerHTML =
      'Mở tab <code>172.16.16.17:2382</code> và đăng nhập. Extension sẽ tự lấy token.';
  }

  refreshExportEnabled();
}

function refreshManualSummary(): void {
  const count = parseManualList(manualInput.value).length;
  if (count > 0) {
    manualSummary.textContent = `${count} mã (ưu tiên hơn Excel khi xuất)`;
  } else {
    manualSummary.textContent = 'Hoặc dùng file Excel bên dưới';
  }
}

function refreshExportEnabled(): void {
  const resolved = resolveInput();
  exportBtn.disabled = running || !auth?.access_token || resolved === null;
  stopBtn.disabled = !running;
  stopBtn.hidden = !running;
}

function applyModeUi(): void {
  mode = selectedMode();
  kindBlock.hidden = mode !== 'ksk';
  excelLabel.textContent =
    'File Excel .xlsx / .xls (Mã hồ sơ; thêm Mã nhân viên, Tên NB, CCCD để đặt tên file)';
}

function appendLog(text: string, kind: 'ok' | 'err' | '' = ''): void {
  const li = document.createElement('li');
  if (kind) {
    li.className = kind;
  }
  li.textContent = text;
  logEl.prepend(li);
}

async function refreshAuth(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: 'GET_AUTH'
  })) as AuthResponse;
  setAuthUi(response?.auth ?? null);
}

async function ensureDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
  if (typeof window.showDirectoryPicker !== 'function') {
    throw new Error(
      'Trình duyệt không hỗ trợ chọn thư mục. Dùng Chrome mới hơn.'
    );
  }

  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  directoryHandle = handle;
  folderSummary.textContent = `Thư mục lưu: ${handle.name} (giữ panel mở khi xuất)`;
  appendLog(`Đã chọn thư mục: ${handle.name}`);
  return handle;
}

async function writeFileToFolder(
  fileName: string,
  base64: string
): Promise<void> {
  if (!directoryHandle) {
    throw new Error('Chưa chọn thư mục lưu');
  }

  const fileHandle = await directoryHandle.getFileHandle(fileName, {
    create: true
  });
  const writable = await fileHandle.createWritable();
  try {
    const bytes = base64ToBytes(base64);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await writable.write(new Blob([copy]));
  } finally {
    await writable.close();
  }
}

/**
 * PDF stems already saved in the folder.
 * Zero-byte PDFs are ignored so a failed write can be retried.
 */
async function listExistingPdfStems(
  handle: FileSystemDirectoryHandle
): Promise<Set<string>> {
  const existing = new Set<string>();

  for await (const [name, entry] of handle.entries()) {
    if (entry.kind !== 'file') {
      continue;
    }

    const lower = name.toLowerCase();
    if (!lower.endsWith('.pdf')) {
      continue;
    }

    const fileHandle = entry as FileSystemFileHandle;
    const file = await fileHandle.getFile();
    if (file.size <= 0) {
      continue;
    }

    existing.add(name.slice(0, -'.pdf'.length));
  }

  return existing;
}

function splitByExistingPdfs(
  list: ExportTarget[],
  existing: Set<string>
): { toScan: ExportTarget[]; skipped: ExportTarget[] } {
  const toScan: ExportTarget[] = [];
  const skipped: ExportTarget[] = [];

  for (const item of list) {
    const stem = item.fileName.replace(/\.pdf$/i, '');
    if (existing.has(stem)) {
      skipped.push(item);
    } else {
      toScan.push(item);
    }
  }

  return { toScan, skipped };
}

function cancelReasonLabel(reason: string): string {
  switch (reason) {
    case 'stopped_by_user':
      return 'đã dừng';
    case 'session_expired':
      return 'hết phiên đăng nhập';
    case 'network':
      return 'mất mạng';
    case 'timeout':
      return 'timeout';
    default:
      return reason;
  }
}

async function parseExcelBuffer(fileName: string): Promise<void> {
  if (!excelBuffer) {
    excelList = [];
    kskRows = [];
    excelFileName = '';
    excelReadError = '';
    excelSummary.textContent = 'Chưa chọn file';
    return;
  }

  const buffer = excelBuffer.slice(0);
  excelFileName = fileName;

  try {
    kskRows = await readKskRoster(buffer);
    excelList = [];
    excelReadError = '';
    excelSummary.textContent = `${kskRows.length} hồ sơ từ ${fileName}`;
    appendLog(
      mode === 'ksk'
        ? `Đã đọc ${kskRows.length} hồ sơ KSK từ Excel`
        : `Đã đọc ${kskRows.length} hồ sơ từ Excel (tên file theo mã NV, tên, CCCD)`
    );
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('Không tìm thấy cột:')) {
      throw error;
    }
  }

  excelList = await readMaHoSoList(buffer);
  kskRows = [];
  excelReadError = '';
  excelSummary.textContent = `${excelList.length} mã hồ sơ từ ${fileName}`;
  appendLog(`Đã đọc ${excelList.length} mã hồ sơ từ Excel`);
}

manualInput.addEventListener('input', () => {
  refreshManualSummary();
  refreshExportEnabled();
});

prefixInput.addEventListener('input', () => {
  refreshExportEnabled();
});

for (const input of modeInputs) {
  input.addEventListener('change', () => {
    applyModeUi();
    if (!excelBuffer || !excelFileName) {
      refreshExportEnabled();
      return;
    }

    void (async () => {
      try {
        await parseExcelBuffer(excelFileName);
      } catch (error) {
        excelList = [];
        kskRows = [];
        excelReadError = error instanceof Error ? error.message : String(error);
        excelSummary.textContent = `Lỗi đọc Excel: ${excelReadError}`;
        appendLog(excelReadError, 'err');
      }

      refreshExportEnabled();
    })();
  });
}

excelInput.addEventListener('change', () => {
  void (async () => {
    const file = excelInput.files?.[0];
    if (!file) {
      excelBuffer = null;
      excelList = [];
      kskRows = [];
      excelFileName = '';
      excelReadError = '';
      excelSummary.textContent = 'Chưa chọn file';
      refreshExportEnabled();
      return;
    }

    try {
      excelBuffer = await file.arrayBuffer();
      await parseExcelBuffer(file.name);
    } catch (error) {
      excelList = [];
      kskRows = [];
      excelReadError = error instanceof Error ? error.message : String(error);
      excelSummary.textContent = `Lỗi đọc Excel: ${excelReadError}`;
      appendLog(excelReadError, 'err');
    }

    refreshExportEnabled();
  })();
});

exportBtn.addEventListener('click', () => {
  void (async () => {
    const resolved = resolveInput();
    if (running || !auth || !resolved) {
      return;
    }

    let saveDir: FileSystemDirectoryHandle;
    try {
      saveDir = await ensureDirectoryHandle();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/abort/i.test(message)) {
        appendLog('Đã hủy chọn thư mục', 'err');
        return;
      }

      appendLog(`Không chọn được thư mục: ${message}`, 'err');
      return;
    }

    const { targets, sourceFileName } = resolved;
    const fromManual = parseManualList(manualInput.value).length > 0;
    const modeLabel = mode === 'ksk' ? 'phiếu KSK' : 'CLS';
    const sourceLabel = fromManual ? 'nhập tay' : 'Excel';

    running = true;
    refreshExportEnabled();
    progressEl.textContent = 'Đang bắt đầu…';
    logEl.innerHTML = '';
    appendLog(
      `Đã chọn ${targets.length} hồ sơ (${modeLabel} · ${sourceLabel})`
    );

    let toScan = targets;
    try {
      const existing = await listExistingPdfStems(saveDir);
      const split = splitByExistingPdfs(targets, existing);
      toScan = split.toScan;

      if (split.skipped.length > 0) {
        appendLog(
          `Bỏ qua ${split.skipped.length} hồ sơ đã có PDF. Sẽ quét ${toScan.length} hồ sơ.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog(`Không đọc được thư mục lưu: ${message}`, 'err');
      running = false;
      refreshExportEnabled();
      return;
    }

    if (toScan.length === 0) {
      progressEl.textContent = 'Không còn hồ sơ cần quét';
      appendLog(
        'Tất cả hồ sơ trong danh sách đã có PDF — không gọi HIS.',
        'ok'
      );
      running = false;
      refreshExportEnabled();
      return;
    }

    appendLog(`Bắt đầu xuất ${toScan.length} hồ sơ`);

    const message: RuntimeMessage = {
      type: 'START_EXPORT',
      mode,
      targets: toScan,
      sourceFileName,
      ...(mode === 'ksk' ? { kskPaperKind: selectedPaperKind() } : {})
    };
    void chrome.runtime.sendMessage(message);
  })();
});

stopBtn.addEventListener('click', () => {
  if (!running) {
    return;
  }

  appendLog('Đang gửi lệnh dừng…');
  void chrome.runtime.sendMessage({ type: 'STOP_EXPORT' });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
  if (message.type === 'AUTH_UPDATED') {
    setAuthUi(message.auth);
    return;
  }

  if (message.type === 'SAVE_PDF') {
    void (async () => {
      try {
        await writeFileToFolder(message.fileName, message.base64);
        await chrome.runtime.sendMessage({
          type: 'SAVE_PDF_DONE',
          requestId: message.requestId,
          ok: true
        } satisfies RuntimeMessage);
      } catch (error) {
        const errMessage =
          error instanceof Error ? error.message : String(error);
        appendLog(`Lưu ${message.fileName} thất bại: ${errMessage}`, 'err');
        await chrome.runtime.sendMessage({
          type: 'SAVE_PDF_DONE',
          requestId: message.requestId,
          ok: false,
          error: errMessage
        } satisfies RuntimeMessage);
      }
    })();
    return;
  }

  if (message.type === 'EXPORT_PROGRESS') {
    progressEl.textContent = `[${message.current}/${message.total}] ${message.maHoSo}`;
    return;
  }

  if (message.type === 'EXPORT_LOG') {
    appendLog(message.message);
    return;
  }

  if (message.type === 'EXPORT_ITEM_DONE') {
    const row = message.row as ReportRow;
    if (row.status === 'success') {
      const mismatch =
        row.apiItemCount !== row.fileCount || row.skippedCount > 0
          ? ` · API ${row.apiItemCount}→desc ${row.fileCount} (bỏ ${row.skippedCount})`
          : '';
      appendLog(
        `${row.maHoSo}: OK · ${row.pageCount} trang · PDF parts=${row.obtainedCount}${mismatch}`,
        mismatch ? 'err' : 'ok'
      );
      if (row.issuesSummary) {
        appendLog(`${row.maHoSo}: ${row.issuesSummary}`, 'err');
      }
    } else if (row.status === 'empty') {
      appendLog(
        `${row.maHoSo}: trống · API ${row.apiItemCount} · ${row.issuesSummary || row.error}`,
        ''
      );
    } else if (row.status === 'cancelled') {
      appendLog(
        `${row.maHoSo}: bỏ qua (${cancelReasonLabel(row.error)})`,
        'err'
      );
    } else {
      appendLog(`${row.maHoSo}: ${row.error}`, 'err');
    }
    return;
  }

  if (message.type === 'EXPORT_DONE') {
    running = false;
    refreshExportEnabled();
    const ok = message.rows.filter((r) => r.status === 'success').length;
    const empty = message.rows.filter((r) => r.status === 'empty').length;
    const failed = message.rows.filter((r) => r.status === 'error').length;
    const cancelled = message.rows.filter(
      (r) => r.status === 'cancelled'
    ).length;
    const summary = `success=${ok} empty=${empty} error=${failed} cancelled=${cancelled}`;
    progressEl.textContent = `Xong · ${summary}`;
    appendLog(`Hoàn tất · ${summary}`, 'ok');

    if (message.reportFileName && message.reportBase64) {
      void (async () => {
        try {
          await writeFileToFolder(message.reportFileName, message.reportBase64);
          appendLog(`Đã lưu báo cáo ${message.reportFileName}`, 'ok');
        } catch (error) {
          const errMessage =
            error instanceof Error ? error.message : String(error);
          appendLog(`Lưu báo cáo thất bại: ${errMessage}`, 'err');
        }
      })();
    }

    if (message.remainingFileName && message.remainingBase64) {
      const remainingCount =
        message.remainingCount ??
        message.rows.filter(
          (r) => r.status === 'cancelled' || r.status === 'error'
        ).length;
      void (async () => {
        try {
          await writeFileToFolder(
            message.remainingFileName!,
            message.remainingBase64!
          );
          appendLog(
            `Đã lưu ${remainingCount} mã còn lại → ${message.remainingFileName}`,
            'ok'
          );
        } catch (error) {
          const errMessage =
            error instanceof Error ? error.message : String(error);
          appendLog(`Lưu Excel còn lại thất bại: ${errMessage}`, 'err');
        }
      })();
    }
    return;
  }

  if (message.type === 'EXPORT_ERROR') {
    running = false;
    refreshExportEnabled();
    progressEl.textContent = 'Lỗi';
    appendLog(message.message, 'err');
  }
});

applyModeUi();
void refreshAuth();
