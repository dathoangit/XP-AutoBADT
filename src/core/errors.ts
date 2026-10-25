import { looksLikeSessionExpiredMessage } from './session';

export type ErrorKind =
  'session_expired' | 'network' | 'timeout' | 'aborted' | 'http' | 'other';

export type SessionSignal =
  | 'http_status'
  | 'login_url'
  | 'html_content_type'
  | 'html_body'
  | 'payload_field'
  | 'body_text';

export class HttpError extends Error {
  readonly status: number;
  readonly bodyPreview: string;
  readonly url: string;
  readonly signal: SessionSignal | '';

  constructor(
    status: number,
    message: string,
    bodyPreview = '',
    options?: { url?: string; signal?: SessionSignal }
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.bodyPreview = bodyPreview;
    this.url = options?.url ?? '';
    this.signal = options?.signal ?? '';
  }
}

export class ExportHaltError extends Error {
  readonly reason:
    'session_expired' | 'network' | 'timeout' | 'stopped_by_user';

  constructor(
    reason: 'session_expired' | 'network' | 'timeout' | 'stopped_by_user',
    message: string
  ) {
    super(message);
    this.name = 'ExportHaltError';
    this.reason = reason;
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const name = (error as { name?: string }).name;
  if (name === 'AbortError') {
    return true;
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /aborted|The user aborted a request/i.test(message);
}

export function classifyError(error: unknown): ErrorKind {
  if (isAbortError(error)) {
    return 'aborted';
  }

  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) {
      return 'session_expired';
    }

    return 'http';
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('timeout')) {
    return 'timeout';
  }

  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('network request failed') ||
    lower.includes('net::') ||
    (error instanceof TypeError && /fetch|network/i.test(message))
  ) {
    return 'network';
  }

  if (looksLikeSessionExpiredMessage(message)) {
    return 'session_expired';
  }

  return 'other';
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}
