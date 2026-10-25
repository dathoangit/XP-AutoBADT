import { APP_HOST } from '../config/env';
import type { FileDescriptor } from './types';

/**
 * Build preview URL:
 *   {APP_HOST}/app/preview-files/{maHoSo}?files={encodeURIComponent(joined)}
 */
export function buildPreviewUrl(
  maHoSo: string,
  descriptors: FileDescriptor[]
): string {
  const joined = descriptors.map((d) => d.raw).join('||');
  const encoded = encodeURIComponent(joined);
  return `${APP_HOST}/app/preview-files/${encodeURIComponent(maHoSo)}?files=${encoded}`;
}
