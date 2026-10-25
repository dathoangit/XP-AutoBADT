import { GOOGLE_SHEETS_SECRET, GOOGLE_SHEETS_WEBHOOK_URL } from '../config/env';
import type { RunSummary } from './run-summary';

export type SheetsPostResult =
  | { ok: true; skipped: true; reason: 'not_configured' }
  | { ok: true; skipped: false }
  | { ok: false; error: string };

const SHEETS_FETCH_TIMEOUT_MS = 15_000;

/**
 * POST run summary to Google Apps Script webhook.
 * Fail-open: never throws — caller only logs the result.
 */
export async function postRunToGoogleSheet(
  summary: RunSummary
): Promise<SheetsPostResult> {
  const url = GOOGLE_SHEETS_WEBHOOK_URL.trim();
  if (!url) {
    return { ok: true, skipped: true, reason: 'not_configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHEETS_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: GOOGLE_SHEETS_SECRET,
        run: {
          startedAt: summary.startedAt,
          endedAt: summary.endedAt,
          durationSeconds: summary.durationSeconds,
          username: summary.username,
          sourceFileName: summary.sourceFileName,
          total: summary.total,
          success: summary.success,
          empty: summary.empty,
          error: summary.error,
          cancelled: summary.cancelled,
          haltReason: summary.haltReason,
          errorAnalysis: summary.errorAnalysis
        },
        errors: summary.errors.map((e) => ({
          maHoSo: e.maHoSo,
          status: e.status,
          group: e.group,
          detail: e.detail,
          issuesSummary: e.issuesSummary
        }))
      }),
      redirect: 'follow',
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        error: `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`
      };
    }

    // Apps Script often returns JSON { ok: true } or HTML after redirect
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (body.ok === false) {
        return { ok: false, error: body.error || 'Webhook rejected payload' };
      }
    }

    return { ok: true, skipped: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/abort/i.test(message)) {
      return {
        ok: false,
        error: `Timeout sau ${SHEETS_FETCH_TIMEOUT_MS / 1000}s`
      };
    }

    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}
