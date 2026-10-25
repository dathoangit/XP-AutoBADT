import { PDF_HOST } from '../config/env';
import type { AuthPayload } from '../auth/types';
import { classifyError, HttpError, type SessionSignal } from '../core/errors';
import {
  isHtmlContentType,
  isLikelyLoginUrl,
  looksLikeHtml,
  looksLikeSessionExpiredPayload,
  looksLikeSessionExpiredText
} from '../core/session';
import type { FileDescriptor } from '../his/types';

const PDF_MAGIC = new TextEncoder().encode('%PDF');

function isPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) {
    return false;
  }

  return (
    bytes[0] === PDF_MAGIC[0] &&
    bytes[1] === PDF_MAGIC[1] &&
    bytes[2] === PDF_MAGIC[2] &&
    bytes[3] === PDF_MAGIC[3]
  );
}

function pickRelativePath(descriptor: FileDescriptor): string | null {
  const source = descriptor.source;
  const candidates = [
    source.api,
    source.duongDan,
    source.fileUrl,
    source.url,
    source.ketQua
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }

    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }

    if (trimmed.startsWith('/')) {
      return trimmed;
    }

    if (trimmed.includes('/')) {
      return `/${trimmed}`;
    }
  }

  return null;
}

export function resolvePdfUrl(descriptor: FileDescriptor): string | null {
  const relative = pickRelativePath(descriptor);
  if (!relative) {
    return null;
  }

  if (/^https?:\/\//i.test(relative)) {
    return relative;
  }

  const path = relative.startsWith('/') ? relative : `/${relative}`;
  return `${PDF_HOST}${path}`;
}

function detectSessionSignal(
  responseUrl: string,
  contentType: string,
  preview: string,
  parsed: unknown
): SessionSignal | null {
  if (isLikelyLoginUrl(responseUrl)) {
    return 'login_url';
  }

  if (isHtmlContentType(contentType)) {
    return 'html_content_type';
  }

  if (looksLikeHtml(preview)) {
    return 'html_body';
  }

  if (looksLikeSessionExpiredPayload(parsed)) {
    return 'payload_field';
  }

  if (looksLikeSessionExpiredText(preview)) {
    return 'body_text';
  }

  return null;
}

export async function fetchPdfBytes(
  url: string,
  auth: AuthPayload,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      Accept: 'application/pdf,*/*'
    },
    signal
  });

  const effectiveUrl = response.url || url;

  if (!response.ok) {
    throw new HttpError(
      response.status,
      `PDF fetch HTTP ${response.status} for ${url}`,
      '',
      {
        url: effectiveUrl,
        signal:
          response.status === 401 || response.status === 403
            ? 'http_status'
            : undefined
      }
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (isPdfMagic(bytes)) {
    return bytes;
  }

  const preview = new TextDecoder().decode(bytes.slice(0, 400));
  const contentType = response.headers.get('content-type') || '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(preview);
  } catch {
    parsed = null;
  }

  const sessionSignal = detectSessionSignal(
    effectiveUrl,
    contentType,
    preview,
    parsed
  );
  if (sessionSignal) {
    throw new HttpError(
      401,
      `PDF fetch session expired for ${url}`,
      preview.slice(0, 200),
      { url: effectiveUrl, signal: sessionSignal }
    );
  }

  throw new Error(`Response is not a PDF (${url})`);
}

export async function tryFetchDirectPdf(
  descriptor: FileDescriptor,
  auth: AuthPayload,
  signal?: AbortSignal
): Promise<Uint8Array | null> {
  const url = resolvePdfUrl(descriptor);
  if (!url) {
    return null;
  }

  try {
    return await fetchPdfBytes(url, auth, signal);
  } catch (error) {
    const kind = classifyError(error);
    if (kind === 'session_expired' || kind === 'aborted') {
      throw error;
    }

    return null;
  }
}
