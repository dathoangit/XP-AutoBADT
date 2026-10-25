/**
 * XP-AutoBADT — Google Sheet run logger
 *
 * Setup:
 * 1. Create a Google Sheet with two tabs named exactly:
 *    - Lan_chay
 *    - Chi_tiet_loi
 * 2. Extensions → Apps Script → paste this file → Save
 * 3. Set WEBHOOK_SECRET below (same value as GOOGLE_SHEETS_SECRET in env.ts)
 * 4. Deploy → New deployment → Type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy the web-app URL into GOOGLE_SHEETS_WEBHOOK_URL in src/config/env.ts
 *
 * Optional: run ensureHeaders() once from the Apps Script editor to write column headers.
 */

var WEBHOOK_SECRET = 'CHANGE_ME';

var SHEET_RUNS = 'Lan_chay';
var SHEET_ERRORS = 'Chi_tiet_loi';

var RUN_HEADERS = [
  'Bat dau',
  'Ket thuc',
  'Thoi luong (s)',
  'Nguoi chay',
  'File nguon',
  'Tong',
  'Thanh cong',
  'Trong',
  'Loi',
  'Huy',
  'Ly do dung',
  'Phan tich loi'
];

var ERROR_HEADERS = [
  'Thoi gian lan chay',
  'Ma ho so',
  'Trang thai',
  'Nhom loi',
  'Chi tiet',
  'Tom tat van de'
];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!body || body.secret !== WEBHOOK_SECRET) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }

    var run = body.run || {};
    var errors = body.errors || [];
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var runSheet = getOrCreateSheet_(ss, SHEET_RUNS, RUN_HEADERS);
    var errSheet = getOrCreateSheet_(ss, SHEET_ERRORS, ERROR_HEADERS);

    runSheet.appendRow([
      run.startedAt || '',
      run.endedAt || '',
      run.durationSeconds != null ? run.durationSeconds : '',
      run.username || '',
      run.sourceFileName || '',
      run.total != null ? run.total : '',
      run.success != null ? run.success : '',
      run.empty != null ? run.empty : '',
      run.error != null ? run.error : '',
      run.cancelled != null ? run.cancelled : '',
      run.haltReason || '',
      run.errorAnalysis || ''
    ]);

    var runTime = run.endedAt || run.startedAt || new Date().toISOString();
    for (var i = 0; i < errors.length; i++) {
      var err = errors[i] || {};
      errSheet.appendRow([
        runTime,
        err.maHoSo || '',
        err.status || '',
        err.group || '',
        err.detail || '',
        err.issuesSummary || ''
      ]);
    }

    return jsonResponse({
      ok: true,
      appendedErrors: errors.length
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: String(error)
    });
  }
}

function doGet() {
  return jsonResponse({
    ok: true,
    service: 'XP-AutoBADT Sheet Logger'
  });
}

/** Run once from the editor to ensure header rows exist. */
function ensureHeaders() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  getOrCreateSheet_(ss, SHEET_RUNS, RUN_HEADERS);
  getOrCreateSheet_(ss, SHEET_ERRORS, ERROR_HEADERS);
}

function getOrCreateSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
