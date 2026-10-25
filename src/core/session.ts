/** Match session markers inside API body / payload fields (may include status codes). */
const SESSION_TEXT_RE =
  /\b401\b|\b403\b|unauthorized|unauthorised|unauthenticated|forbidden|invalid token|token expired|jwt expired|access denied|hết hạn|het han|hết phiên|hết hiệu lực|phiên đăng nhập|phiên làm việc|token không hợp lệ|chưa đăng nhập|vui lòng đăng nhập/i;

/**
 * Match auth keywords in Error.message only — omit bare 401/403 so a URL or
 * body snippet embedded in the message is not misclassified as session expiry.
 */
const SESSION_MESSAGE_RE =
  /unauthorized|unauthorised|unauthenticated|forbidden|invalid token|token expired|jwt expired|access denied|hết hạn|het han|hết phiên|hết hiệu lực|phiên đăng nhập|phiên làm việc|token không hợp lệ|chưa đăng nhập|vui lòng đăng nhập|session expired/i;

const AUTH_CODE_KEYS = [
  'status',
  'code',
  'errorCode',
  'httpStatus',
  'statusCode'
] as const;

const AUTH_MESSAGE_KEYS = [
  'message',
  'msg',
  'error',
  'errorMessage',
  'detail',
  'thongBao'
] as const;

export function looksLikeSessionExpiredText(text: string): boolean {
  return SESSION_TEXT_RE.test(text);
}

export function looksLikeSessionExpiredMessage(text: string): boolean {
  return SESSION_MESSAGE_RE.test(text);
}

export function looksLikeHtml(text: string): boolean {
  const trimmed = text.trimStart().slice(0, 32).toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

export function isHtmlContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes('text/html');
}

function asAuthStatusCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && /^(401|403)$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

export function looksLikeSessionExpiredPayload(body: unknown): boolean {
  if (typeof body === 'string') {
    return looksLikeSessionExpiredText(body) || looksLikeHtml(body);
  }

  if (body === null || typeof body !== 'object') {
    return false;
  }

  const record = body as Record<string, unknown>;
  for (const key of AUTH_CODE_KEYS) {
    const code = asAuthStatusCode(record[key]);
    if (code === 401 || code === 403) {
      return true;
    }
  }

  for (const key of AUTH_MESSAGE_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && looksLikeSessionExpiredText(value)) {
      return true;
    }
  }

  return false;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      '='
    );
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function formatJwtTime(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '?';
  }

  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toLocaleTimeString('vi-VN', { hour12: false });
}

/**
 * Safe token fingerprint for logs: last 6 chars + iat/exp, never the full JWT.
 */
export function describeToken(token: string): string {
  const tail = token.length >= 6 ? token.slice(-6) : token || '(empty)';
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return `…${tail} · (không parse được JWT)`;
  }

  const iat = formatJwtTime(payload.iat);
  const exp = formatJwtTime(payload.exp);
  let remaining = '';
  if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
    const expMs = payload.exp > 1e12 ? payload.exp : payload.exp * 1000;
    const secs = Math.round((expMs - Date.now()) / 1000);
    remaining = secs >= 0 ? `còn ${secs}s` : `quá hạn ${Math.abs(secs)}s`;
  }

  const remPart = remaining ? ` (${remaining})` : '';
  return `…${tail} · iat ${iat} · exp ${exp}${remPart}`;
}

export function isJwtExpired(token: string, skewMs = 5000): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return false;
  }

  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return false;
  }

  const expMs = exp > 1e12 ? exp : exp * 1000;
  return expMs <= Date.now() + skewMs;
}

export function isLikelyLoginUrl(url: string): boolean {
  try {
    const { pathname, hash } = new URL(url);
    const haystack = `${pathname} ${hash}`.toLowerCase();
    return /\/login\b|\/dang-nhap\b|\/signin\b|\/sign-in\b|\/logout\b/.test(
      haystack
    );
  } catch {
    return false;
  }
}
