import { APP_HOST, AUTH_STORAGE_KEY } from './config/env';
import type { AuthPayload } from './auth/types';
import type { AuthResponse, RuntimeMessage } from './config/messages';
import { runExportBatch } from './core/runner';
import { isJwtExpired, describeToken } from './core/session';
import { buildRunSummary } from './report/run-summary';
import { postRunToGoogleSheet } from './report/sheets-client';

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

let exportAbortController: AbortController | null = null;
let exportRunning = false;

const pendingSaves = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void }
>();

async function saveAuth(auth: AuthPayload | null): Promise<void> {
  if (!auth) {
    await chrome.storage.session.remove(AUTH_STORAGE_KEY);
    await chrome.storage.local.remove(AUTH_STORAGE_KEY);
    return;
  }

  await chrome.storage.session.set({ [AUTH_STORAGE_KEY]: auth });
  await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: auth });
}

async function loadAuth(): Promise<AuthPayload | null> {
  const session = await chrome.storage.session.get(AUTH_STORAGE_KEY);
  const fromSession = session[AUTH_STORAGE_KEY] as AuthPayload | undefined;
  if (fromSession?.access_token) {
    return fromSession;
  }

  const local = await chrome.storage.local.get(AUTH_STORAGE_KEY);
  const fromLocal = local[AUTH_STORAGE_KEY] as AuthPayload | undefined;
  return fromLocal?.access_token ? fromLocal : null;
}

/**
 * Read localStorage.auth from an open HIS app tab (source of truth).
 */
async function readAuthFromHisTabs(): Promise<AuthPayload | null> {
  const tabs = await chrome.tabs.query({ url: `${APP_HOST}/*` });
  for (const tab of tabs) {
    if (tab.id === undefined) {
      continue;
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          try {
            const raw = localStorage.getItem('auth');
            if (!raw) {
              return null;
            }

            return JSON.parse(raw) as AuthPayload;
          } catch {
            return null;
          }
        }
      });
      const auth = results[0]?.result as AuthPayload | null | undefined;
      if (auth?.access_token) {
        return auth;
      }
    } catch {
      // tab closed / restricted
    }
  }

  return null;
}

/**
 * Prefer storage token while still valid. When JWT exp looks past (or
 * forceRefresh), re-read from HIS tab — HIS may have refreshed while
 * chrome.storage is stale. Never treat JWT exp alone as hard logout.
 */
async function loadAuthForExport(options?: {
  forceRefresh?: boolean;
}): Promise<AuthPayload | null> {
  const stored = await loadAuth();
  // 60s skew: re-read from HIS before the token can expire mid-item.
  if (
    !options?.forceRefresh &&
    stored?.access_token &&
    !isJwtExpired(stored.access_token, 60_000)
  ) {
    return stored;
  }

  const hisTabs = await chrome.tabs.query({ url: `${APP_HOST}/*` });
  const fromTab = await readAuthFromHisTabs();
  if (fromTab?.access_token) {
    const changed = fromTab.access_token !== stored?.access_token;
    await saveAuth(fromTab);
    if (changed || options?.forceRefresh) {
      broadcast({ type: 'AUTH_UPDATED', auth: fromTab });
      const oldDesc = stored?.access_token
        ? describeToken(stored.access_token)
        : '(không có)';
      const newDesc = describeToken(fromTab.access_token);
      broadcast({
        type: 'EXPORT_LOG',
        message: `[AUTH-DEBUG] đọc từ ${hisTabs.length} tab HIS · token ${oldDesc} → ${newDesc} (${changed ? 'đã đổi' : 'không đổi'})`
      });
    }

    return fromTab;
  }

  if (options?.forceRefresh) {
    broadcast({
      type: 'EXPORT_LOG',
      message: `[AUTH-DEBUG] force refresh: tìm ${hisTabs.length} tab HIS nhưng không lấy được token`
    });
  }

  return stored;
}

function broadcast(message: RuntimeMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // No side panel listener yet
  });
}

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function savePdfViaSidePanel(
  fileName: string,
  base64: string,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    const requestId = createRequestId();
    const timeout = setTimeout(() => {
      pendingSaves.delete(requestId);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Timeout chờ side panel lưu PDF (giữ panel mở).'));
    }, 60_000);

    const onAbort = (): void => {
      clearTimeout(timeout);
      pendingSaves.delete(requestId);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };

    pendingSaves.set(requestId, {
      resolve: () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    });

    signal.addEventListener('abort', onAbort, { once: true });

    broadcast({
      type: 'SAVE_PDF',
      requestId,
      fileName,
      base64
    });
  });
}

async function logRunToGoogleSheet(
  rows: Awaited<ReturnType<typeof runExportBatch>>['rows'],
  sourceFileName: string,
  auth: AuthPayload,
  startedAt: string,
  endedAt: string
): Promise<void> {
  const summary = buildRunSummary({
    rows,
    startedAt,
    endedAt,
    username: auth.username || '',
    sourceFileName
  });

  const result = await postRunToGoogleSheet(summary);
  if (result.ok && result.skipped) {
    broadcast({
      type: 'EXPORT_LOG',
      message: 'Chưa cấu hình webhook Google Sheet — bỏ qua ghi cloud.'
    });
    return;
  }

  if (result.ok) {
    broadcast({
      type: 'EXPORT_LOG',
      message: 'Đã ghi Google Sheet (Lan_chay + Chi_tiet_loi).'
    });
    return;
  }

  broadcast({
    type: 'EXPORT_LOG',
    message: `Ghi Google Sheet thất bại (không ảnh hưởng xuất PDF): ${result.error}`
  });
}

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, _sender, sendResponse) => {
    if (message.type === 'AUTH_UPDATED') {
      void saveAuth(message.auth).then(() => {
        broadcast({ type: 'AUTH_UPDATED', auth: message.auth });
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.type === 'GET_AUTH') {
      void loadAuth().then((auth) => {
        const response: AuthResponse = { auth };
        sendResponse(response);
      });
      return true;
    }

    if (message.type === 'STOP_EXPORT') {
      if (exportAbortController) {
        exportAbortController.abort();
        broadcast({ type: 'EXPORT_LOG', message: 'Đang dừng xuất…' });
      }

      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'SAVE_PDF_DONE') {
      const pending = pendingSaves.get(message.requestId);
      if (pending) {
        pendingSaves.delete(message.requestId);
        if (message.ok) {
          pending.resolve();
        } else {
          pending.reject(
            new Error(message.error || 'Không lưu được PDF vào thư mục đã chọn')
          );
        }
      }

      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'START_EXPORT') {
      void (async () => {
        if (exportRunning) {
          broadcast({
            type: 'EXPORT_ERROR',
            message: 'Đang xuất rồi. Bấm Dừng nếu muốn hủy rồi chạy lại.'
          });
          return;
        }

        exportRunning = true;
        exportAbortController = new AbortController();
        const { signal } = exportAbortController;

        try {
          const auth = await loadAuthForExport();
          if (!auth?.access_token) {
            broadcast({
              type: 'EXPORT_ERROR',
              message:
                'Chưa có token. Mở tab HIS (172.16.16.17:2382) và đăng nhập.'
            });
            return;
          }

          const startedAt = new Date().toISOString();
          const result = await runExportBatch(
            message.targets,
            auth,
            message.sourceFileName,
            {
              onProgress: (current, total, maHoSo) => {
                broadcast({ type: 'EXPORT_PROGRESS', current, total, maHoSo });
              },
              onItemDone: (row) => {
                broadcast({ type: 'EXPORT_ITEM_DONE', row });
              },
              onLog: (text) => {
                broadcast({ type: 'EXPORT_LOG', message: text });
              },
              loadAuth: loadAuthForExport,
              savePdf: (fileName, base64) =>
                savePdfViaSidePanel(fileName, base64, signal),
              signal
            },
            message.mode,
            message.kskPaperKind
          );
          const endedAt = new Date().toISOString();

          broadcast({
            type: 'EXPORT_DONE',
            rows: result.rows,
            reportFileName: result.reportFileName,
            reportBase64: result.reportBase64,
            remainingFileName: result.remainingFileName,
            remainingBase64: result.remainingBase64,
            remainingCount: result.remainingCount
          });

          // After UI unlock — Sheet logging must never block EXPORT_DONE
          void logRunToGoogleSheet(
            result.rows,
            message.sourceFileName,
            auth,
            startedAt,
            endedAt
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          broadcast({ type: 'EXPORT_ERROR', message: msg });
        } finally {
          exportRunning = false;
          exportAbortController = null;
          for (const [id, pending] of pendingSaves) {
            pendingSaves.delete(id);
            pending.reject(new Error('Xuất đã kết thúc trước khi lưu xong'));
          }
        }
      })();

      sendResponse({ ok: true });
      return true;
    }

    return false;
  }
);
