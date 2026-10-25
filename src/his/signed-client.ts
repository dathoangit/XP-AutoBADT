import { HIS_HOST, SIGNER_API_PATH, SIGNER_FILES_PREFIX } from '../config/env';
import type { AuthPayload } from '../auth/types';
import { HttpError, type SessionSignal } from '../core/errors';
import {
  isHtmlContentType,
  isLikelyLoginUrl,
  looksLikeHtml,
  looksLikeSessionExpiredPayload
} from '../core/session';

export interface SignedPaper {
  id: string;
  maBieuMau: string;
  tenBieuMau: string;
  soPhieu: string;
  fileSauKy: string;
}

interface SignedListResponse {
  code?: number;
  data?: unknown;
  message?: string;
}

function throwSessionExpired(
  maHoSo: string,
  preview: string,
  url: string,
  signal: SessionSignal
): never {
  throw new HttpError(
    401,
    `Signer API session expired for maHoSo=${maHoSo}`,
    preview,
    { url, signal }
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return value === undefined || value === null ? '' : String(value).trim();
}

export interface SignedFetchResult {
  papers: SignedPaper[];
  /** Signer rows whose fileSauKy is not a PDF (for example Hồ sơ XML). */
  skippedNonPdf: SignedPaper[];
}

function isPdfPath(fileSauKy: string): boolean {
  const path = fileSauKy.split('?')[0].split('#')[0].toLowerCase();
  return path.endsWith('.pdf');
}

/**
 * Signed health papers (giấy KSK) from `/api/signer/v1/ky`.
 * Only PDF `fileSauKy` values are exported. XML and other files are returned
 * in `skippedNonPdf` so the batch can continue. Order matches HIS preview (id desc).
 */
export async function fetchSignedPapers(
  maHoSo: string,
  auth: AuthPayload,
  signal?: AbortSignal
): Promise<SignedFetchResult> {
  const params = new URLSearchParams({
    maHoSo,
    page: '0',
    size: '9999',
    sort: 'id,desc',
    phieuMoiNhat: 'true'
  });
  const url = `${HIS_HOST}${SIGNER_API_PATH}?${params.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${auth.access_token}`
    },
    signal
  });

  const body = await response.text().catch(() => '');
  const preview = body.slice(0, 200);
  const contentType = response.headers.get('content-type') || '';
  const effectiveUrl = response.url || url;

  if (!response.ok) {
    throw new HttpError(
      response.status,
      `Signer API HTTP ${response.status} for maHoSo=${maHoSo}: ${preview}`,
      preview,
      {
        url: effectiveUrl,
        signal:
          response.status === 401 || response.status === 403
            ? 'http_status'
            : undefined
      }
    );
  }

  if (isLikelyLoginUrl(effectiveUrl)) {
    throwSessionExpired(maHoSo, preview, effectiveUrl, 'login_url');
  }

  if (isHtmlContentType(contentType)) {
    throwSessionExpired(maHoSo, preview, effectiveUrl, 'html_content_type');
  }

  if (looksLikeHtml(body)) {
    throwSessionExpired(maHoSo, preview, effectiveUrl, 'html_body');
  }

  let json: SignedListResponse;
  try {
    json = JSON.parse(body) as SignedListResponse;
  } catch {
    throw new Error(
      `Unexpected signer API shape for maHoSo=${maHoSo}: response is not JSON`
    );
  }

  if (looksLikeSessionExpiredPayload(json)) {
    throwSessionExpired(maHoSo, preview, effectiveUrl, 'payload_field');
  }

  const rows = Array.isArray(json.data) ? json.data : [];
  const papers: SignedPaper[] = [];
  const skippedNonPdf: SignedPaper[] = [];

  for (const row of rows) {
    const record = asRecord(row);
    if (!record || record.active === false) {
      continue;
    }

    const fileSauKy = textField(record, 'fileSauKy');
    const id = textField(record, 'id');
    const maBieuMau = textField(record, 'maBieuMau');
    if (!fileSauKy || !id || !maBieuMau) {
      continue;
    }

    const paper: SignedPaper = {
      id,
      maBieuMau,
      tenBieuMau: textField(record, 'tenBieuMau'),
      soPhieu: textField(record, 'soPhieu'),
      fileSauKy
    };

    if (!isPdfPath(fileSauKy)) {
      skippedNonPdf.push(paper);
      continue;
    }

    papers.push(paper);
  }

  return { papers, skippedNonPdf };
}

export function signedPaperUrl(fileSauKy: string): string {
  if (/^https?:\/\//i.test(fileSauKy)) {
    return fileSauKy;
  }

  const path = fileSauKy.replace(/^\/+/, '');
  return `${HIS_HOST}${SIGNER_FILES_PREFIX}${path}`;
}
