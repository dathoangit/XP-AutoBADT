import { HttpError, throwIfAborted } from '../core/errors';
import { isLikelyLoginUrl } from '../core/session';
import { sleep } from '../utils/download';

export interface PreviewCaptureResult {
  tabId: number;
  pdfParts: Uint8Array[];
  imageBytes: Uint8Array[];
}

const DETACH_TIMEOUT_MS = 3_000;

/**
 * Race a Chrome API promise against AbortSignal so Stop/timeout can exit
 * when attach / sendCommand / tabs.update hang.
 */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(
      new DOMException('The operation was aborted.', 'AbortError')
    );
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function detachDebuggerSafe(
  debuggee: chrome.debugger.Debuggee
): Promise<void> {
  try {
    await withTimeout(chrome.debugger.detach(debuggee), DETACH_TIMEOUT_MS);
  } catch {
    // already detached or hung — do not block batch exit
  }
}

async function throwIfPreviewLoggedOut(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url && isLikelyLoginUrl(tab.url)) {
    throw new HttpError(
      401,
      `Preview redirected to login: ${tab.url}`,
      tab.url
    );
  }
}

function waitForTabComplete(
  tabId: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for tab ${tabId}`));
    }, timeoutMs);

    const listener = (
      updatedTabId: number,
      info: chrome.tabs.TabChangeInfo
    ): void => {
      if (updatedTabId === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };

    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      signal?.removeEventListener('abort', onAbort);
    };

    chrome.tabs.onUpdated.addListener(listener);
    signal?.addEventListener('abort', onAbort, { once: true });

    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        cleanup();
        resolve();
      }
    });
  });
}

function looksLikePdfUrl(url: string, mimeType: string): boolean {
  const u = url.toLowerCase();
  const m = (mimeType || '').toLowerCase();
  return (
    m.includes('pdf') ||
    u.includes('.pdf') ||
    u.includes('/api/pdf') ||
    u.includes(':2201/')
  );
}

function base64ToBytes(base64: string): Uint8Array {
  // CDP may return base64 without padding quirks
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}

/**
 * Capture PDF response bodies via CDP Network (works with pdf.js workers).
 */
async function capturePdfsWithDebugger(
  tabId: number,
  previewUrl: string,
  onLog: (message: string) => void,
  signal?: AbortSignal
): Promise<Uint8Array[]> {
  throwIfAborted(signal);

  const debuggee: chrome.debugger.Debuggee = { tabId };
  const requestUrls = new Map<string, string>();
  const pdfParts: Uint8Array[] = [];
  const seenSizes = new Set<number>();

  const onEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object
  ): void => {
    if (source.tabId !== tabId || !params) {
      return;
    }

    const data = params as {
      requestId?: string;
      response?: {
        url: string;
        mimeType?: string;
        headers?: Record<string, string>;
      };
    };

    if (method === 'Network.responseReceived' && data.response) {
      const requestId = String(data.requestId);
      const mime =
        data.response.mimeType ||
        data.response.headers?.['content-type'] ||
        data.response.headers?.['Content-Type'] ||
        '';
      if (looksLikePdfUrl(data.response.url, mime)) {
        requestUrls.set(requestId, data.response.url);
      }
    }

    if (method === 'Network.loadingFinished') {
      const requestId = String(data.requestId);
      const url = requestUrls.get(requestId);
      if (!url) {
        return;
      }

      void chrome.debugger
        .sendCommand(debuggee, 'Network.getResponseBody', { requestId })
        .then((result) => {
          const body = result as { body?: string; base64Encoded?: boolean };
          if (!body?.body) {
            return;
          }

          const bytes = body.base64Encoded
            ? base64ToBytes(body.body)
            : new TextEncoder().encode(body.body);

          if (!isPdfBytes(bytes)) {
            return;
          }

          if (seenSizes.has(bytes.length)) {
            return;
          }

          seenSizes.add(bytes.length);
          pdfParts.push(bytes);
          onLog(`[CDP] PDF ${bytes.length} bytes ← ${url.slice(0, 100)}`);
        })
        .catch(() => {
          // body unavailable
        });
    }
  };

  chrome.debugger.onEvent.addListener(onEvent);

  try {
    await withAbort(chrome.debugger.attach(debuggee, '1.3'), signal);
    throwIfAborted(signal);
    await withAbort(
      chrome.debugger.sendCommand(debuggee, 'Network.enable', {}),
      signal
    );
    onLog('[CDP] Network capture attached');

    await withAbort(chrome.tabs.update(tabId, { url: previewUrl }), signal);
    await waitForTabComplete(tabId, 180_000, signal);
    await throwIfPreviewLoggedOut(tabId);

    // Allow pdf.js worker fetches + late responses to settle
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      await throwIfPreviewLoggedOut(tabId);
      if (pdfParts.length > 0) {
        // wait a bit more for additional pages/files
        await sleep(2500, signal);
        break;
      }

      onLog('[CDP] waiting for PDF network responses…');
      await sleep(1500, signal);
    }

    // Drain in-flight getResponseBody promises
    await sleep(1500, signal);
    return pdfParts;
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await detachDebuggerSafe(debuggee);
  }
}

/**
 * Scroll pages into view and export only non-blank react-pdf canvases.
 */
async function scrapeNonBlankCanvases(
  tabId: number,
  signal?: AbortSignal
): Promise<string[]> {
  throwIfAborted(signal);

  const results = await withAbort(
    chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const sleepLocal = (ms: number) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
          });

        const isBlank = (canvas: HTMLCanvasElement): boolean => {
          try {
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
              return true;
            }

            const { width, height } = canvas;
            if (width < 50 || height < 50) {
              return true;
            }

            const step = Math.max(4, Math.floor(Math.min(width, height) / 25));
            let nonWhite = 0;
            let samples = 0;

            for (let y = 0; y < height; y += step) {
              for (let x = 0; x < width; x += step) {
                const pixel = ctx.getImageData(x, y, 1, 1).data;
                samples += 1;
                if (pixel[0] < 245 || pixel[1] < 245 || pixel[2] < 245) {
                  nonWhite += 1;
                }
              }
            }

            return samples === 0 || nonWhite / samples < 0.005;
          } catch {
            return true;
          }
        };

        const pages = Array.from(
          document.querySelectorAll<HTMLElement>('.react-pdf__Page')
        );
        for (const page of pages) {
          page.scrollIntoView({ block: 'center' });
          await sleepLocal(500);
        }

        const canvases = Array.from(
          document.querySelectorAll<HTMLCanvasElement>(
            'canvas.react-pdf__Page__canvas, .react-pdf__Page canvas'
          )
        );

        const dataUrls: string[] = [];
        for (const canvas of canvases) {
          if (canvas.width < 200 || canvas.height < 200 || isBlank(canvas)) {
            continue;
          }

          try {
            dataUrls.push(canvas.toDataURL('image/png'));
          } catch {
            // tainted
          }
        }

        return dataUrls;
      }
    }),
    signal
  );

  const value = results[0]?.result;
  return Array.isArray(value) ? (value as string[]) : [];
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

export async function openPreviewAndCapture(
  previewUrl: string,
  onLog: (message: string) => void,
  signal?: AbortSignal
): Promise<PreviewCaptureResult> {
  throwIfAborted(signal);

  const tab = await withAbort(
    chrome.tabs.create({ url: 'about:blank', active: true }),
    signal
  );
  if (tab.id === undefined) {
    throw new Error('Failed to open tab');
  }

  const tabId = tab.id;

  try {
    await waitForTabComplete(tabId, 30_000, signal);

    // Primary: intercept real PDF bytes (pdf.js worker-safe)
    const pdfParts = await capturePdfsWithDebugger(
      tabId,
      previewUrl,
      onLog,
      signal
    );
    if (pdfParts.length > 0) {
      onLog(`[CDP] using ${pdfParts.length} intercepted PDF(s)`);
      return { tabId, pdfParts, imageBytes: [] };
    }

    throwIfAborted(signal);
    await throwIfPreviewLoggedOut(tabId);
    onLog('[CDP] no PDF caught — fallback non-blank canvas');
    let dataUrls: string[] = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      await throwIfPreviewLoggedOut(tabId);
      dataUrls = await scrapeNonBlankCanvases(tabId, signal);
      if (dataUrls.length > 0) {
        break;
      }

      onLog('[DOM] waiting for painted canvas…');
      await sleep(2000, signal);
    }

    onLog(`[DOM] non-blank canvases: ${dataUrls.length}`);
    const imageBytes = dataUrls.map((src) => dataUrlToBytes(src));
    return { tabId, pdfParts: [], imageBytes };
  } catch (error) {
    // Always close preview tab on failure so Stop / timeout can finish cleanly
    await closeTabSafe(tabId);
    throw error;
  }
}

export async function closeTabSafe(tabId: number): Promise<void> {
  try {
    await withTimeout(chrome.tabs.remove(tabId), DETACH_TIMEOUT_MS);
  } catch {
    // already closed or hung
  }
}
