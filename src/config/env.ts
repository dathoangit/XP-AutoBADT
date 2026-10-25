export const HIS_HOST = 'http://172.16.16.17:2301';
export const PDF_HOST = 'http://172.16.16.17:2201';
export const APP_HOST = 'http://172.16.16.17:2382';

export const DEFAULT_DELAY_MS = 1500;
export const DEFAULT_CONCURRENCY = 3;

export const CLS_API_PATH = '/api/file/v1/nb-ket-qua-cls';
export const SIGNER_API_PATH = '/api/signer/v1/ky';
export const SIGNER_FILES_PREFIX = '/api/signer/v1/files/';
export const XN_FORM_CODE = 'EMR_BA074.1';

export const AUTH_STORAGE_KEY = 'xpAutobadtAuth';

/**
 * When true: only open preview + log URLs (no PDF save).
 * When false: capture react-pdf canvas / images → merge PDF.
 */
export const PREVIEW_ONLY = false;

/**
 * Google Apps Script web-app webhook for shared run logging.
 * Leave empty to skip cloud logging (local Excel report still works).
 * Fill after deploying docs/google-sheet-logger.gs.
 */
export const GOOGLE_SHEETS_WEBHOOK_URL =
  'https://script.google.com/macros/s/AKfycbzinL42m-x7HRSLI01K8BwM6TgRzDvz14kA1TGuAO73VJjW7yErS410-hNd2c-VBgIuDA/exec';
export const GOOGLE_SHEETS_SECRET = 'my_secret_key_123';
