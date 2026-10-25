import { CLS_API_PATH, HIS_HOST } from '../config/env';
import type { AuthPayload } from '../auth/types';
import { HttpError, type SessionSignal } from '../core/errors';
import {
  isHtmlContentType,
  isLikelyLoginUrl,
  looksLikeHtml,
  looksLikeSessionExpiredPayload
} from '../core/session';
import type { ClsItem, ClsListResponse } from './types';

function throwSessionExpired(
  maHoSo: string,
  preview: string,
  url: string,
  signal: SessionSignal
): never {
  throw new HttpError(
    401,
    `CLS API session expired for maHoSo=${maHoSo}`,
    preview,
    { url, signal }
  );
}

export async function fetchClsResults(
  maHoSo: string,
  auth: AuthPayload,
  signal?: AbortSignal
): Promise<ClsItem[]> {
  const params = new URLSearchParams({
    maHoSo,
    page: '0',
    sort: 'createdAt,desc',
    phieuMoiNhat: 'true',
    manHinhHienThi: '20',
    size: '999'
  });

  const url = `${HIS_HOST}${CLS_API_PATH}?${params.toString()}`;
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
      `CLS API HTTP ${response.status} for maHoSo=${maHoSo}: ${preview}`,
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

  let json: ClsListResponse;
  try {
    json = JSON.parse(body) as ClsListResponse;
  } catch {
    throw new Error(
      `Unexpected CLS API shape for maHoSo=${maHoSo}: response is not JSON`
    );
  }

  if (looksLikeSessionExpiredPayload(json)) {
    throwSessionExpired(maHoSo, preview, effectiveUrl, 'payload_field');
  }

  const items = json.data ?? json.content ?? [];

  if (!Array.isArray(items)) {
    throw new Error(
      `Unexpected CLS API shape for maHoSo=${maHoSo}: missing data array`
    );
  }

  return items;
}
