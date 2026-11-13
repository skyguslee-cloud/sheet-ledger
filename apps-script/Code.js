/* =========================================================
   우리집 가계부 — 구글 시트 동기화 (Google Apps Script)

   설치 방법 (자세한 안내는 같은 폴더의 설치안내.md)
   1. 새 구글 시트를 만들고 [확장 프로그램] → [Apps Script]를 엽니다.
   2. Code.gs 내용을 모두 지우고 이 파일 내용을 붙여넣은 뒤 저장합니다.
   3. 아래 FAMILY_CODE 를 가족만 아는 비밀번호로 바꾸고, 위쪽에서 setup 을 골라 [실행]합니다.
   4. [배포] → [새 배포] → 유형: 웹 앱, 실행: 나, 액세스: 모든 사용자 → 배포.
   5. 나온 웹 앱 주소(…/exec)를 가계부 앱의 연결 화면에 넣습니다.

   시트 구성
   - entries  : 내역 한 줄 = 한 건. 지운 내역은 deleted 칸이 1 로 남습니다(다른 휴대폰에도 지워지도록).
   - settings : 사용자 이름, 예산, 고정 항목 같은 설정. value 칸은 JSON 입니다.
   시트에서 직접 고쳐도 됩니다(금액, 메모 등). 줄을 지우지 말고 deleted 칸에 1 을 넣으세요.
   ========================================================= */

var FAMILY_CODE = '여기에-가족-비밀번호';   // setup 을 실행하면 스크립트 속성에 저장됩니다

var ENTRY_COLS = ['id', 'rev', 'updated', 'dev', 'deleted', 'date', 'time', 'type', 'category', 'user',
  'method', 'memo', 'amount', 'recurring_id', 'rec_month', 'source', 'created'];
var SETTING_COLS = ['key', 'rev', 'updated', 'dev', 'value'];
var NUM_COLS = { rev: 1, updated: 1, deleted: 1, user: 1, amount: 1, created: 1 };
var MAX_ITEMS = 20000;

/* ---------- 핵심 로직 (시트·테스트용 가짜 저장소 모두 같은 코드를 씀) ----------
   store: { read(name) → 행 배열, update(name, i, row), append(name, rows), getProp(k), setProp(k, v) } */
function handleSync_(req, store) {
  var code = store.getProp('FAMILY_CODE');
  if (!code) return { ok: false, error: 'not_setup' };
  if (!req || String(req.code || '') !== code) return { ok: false, error: 'bad_code' };

  var rev = Number(store.getProp('REV')) || 0;
  var newRev = rev + 1, wrote = false;

  // 1) 받은 내역 저장 — 같은 id 는 updated 가 더 큰 쪽이 이김
  var entries = store.read('entries');
  var eIdx = {};
  for (var i = 0; i < entries.length; i++) eIdx[String(entries[i][0])] = i;
  var eAppend = [];
  var inE = Array.isArray(req.entries) ? req.entries.slice(0, MAX_ITEMS) : [];
  for (var j = 0; j < inE.length; j++) {
    var e = cleanEntry_(inE[j], req.dev);
    if (!e) continue;
    if (eIdx.hasOwnProperty(e.id)) {
      var cur = entries[eIdx[e.id]];
      if (!(e.updated > Number(cur[2] || 0))) continue;
      var row = entryRow_(e, newRev);
      entries[eIdx[e.id]] = row;
      store.update('entries', eIdx[e.id], row);
    } else {
      var nrow = entryRow_(e, newRev);
      eIdx[e.id] = entries.length + eAppend.length;
      eAppend.push(nrow);
    }
    wrote = true;
  }
  if (eAppend.length) { store.append('entries', eAppend); entries = entries.concat(eAppend); }

  // 2) 받은 설정 저장 — 키마다 updated 가 큰 쪽이 이김. rules(분류 학습)는 서로 합침
  var settings = store.read('settings');
  var sIdx = {};
  for (var k = 0; k < settings.length; k++) sIdx[String(settings[k][0])] = k;
  var sAppend = [];
  var inS = Array.isArray(req.settings) ? req.settings.slice(0, 2000) : [];
  for (var m = 0; m < inS.length; m++) {
    var s = inS[m];
    if (!s || typeof s.key !== 'string' || !s.key || s.key.length > 120) continue;
    var upd = Number(s.updated) || 0;
    var val = s.value === undefined ? null : s.value;
    if (sIdx.hasOwnProperty(s.key)) {
      var old = settings[sIdx[s.key]];
      var oldUpd = Number(old[2] || 0), oldVal = parseJson_(old[4]);
      if (s.key === 'rules') {
        val = upd > oldUpd ? mergeObj_(oldVal, val) : mergeObj_(val, oldVal);
        upd = Math.max(upd, oldUpd);
        if (JSON.stringify(val) === JSON.stringify(oldVal) && upd === oldUpd) continue;
      } else if (!(upd > oldUpd)) continue;
      var srow = [s.key, newRev, upd, String(req.dev || '').slice(0, 40), JSON.stringify(val)];
      settings[sIdx[s.key]] = srow;
      store.update('settings', sIdx[s.key], srow);
    } else {
      sIdx[s.key] = settings.length + sAppend.length;
      sAppend.push([s.key, newRev, upd, String(req.dev || '').slice(0, 40), JSON.stringify(val)]);
    }
    wrote = true;
  }
  if (sAppend.length) { store.append('settings', sAppend); settings = settings.concat(sAppend); }

  if (wrote) { store.setProp('REV', String(newRev)); rev = newRev; }

  // 3) 이 기기가 마지막으로 받은 뒤(since) 바뀐 것 돌려주기
  var since = Number(req.since) || 0;
  var full = false;
  if (since > rev) { since = 0; full = true; }   // 시트를 새로 만든 경우: 처음부터 다시
  var outE = [], outS = [];
  for (var a = 0; a < entries.length; a++) if (Number(entries[a][1] || 0) > since) outE.push(rowEntry_(entries[a]));
  for (var b = 0; b < settings.length; b++) if (Number(settings[b][1] || 0) > since)
    outS.push({ key: String(settings[b][0]), updated: Number(settings[b][2]) || 0, value: parseJson_(settings[b][4]) });
  return { ok: true, rev: rev, full: full || since === 0, entries: outE, settings: outS };
}

function cleanEntry_(x, dev) {
  if (!x || typeof x.id !== 'string' || !/^[\w-]{6,80}$/.test(x.id)) return null;
  var t = { id: x.id, updated: Number(x.updated) || 0, dev: String(x.dev || dev || '').slice(0, 40), deleted: x.deleted ? 1 : 0 };
  if (t.deleted) return t;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.date || ''))) return null;
  if (['expense', 'income', 'transfer'].indexOf(x.type) < 0) return null;
  t.date = x.date; t.time = String(x.time || '').slice(0, 5); t.type = x.type;
  t.category = String(x.category || '').slice(0, 40); t.user = Math.max(0, Math.min(9, Math.round(Number(x.user) || 0)));
  t.method = String(x.method || '').slice(0, 40); t.memo = String(x.memo || '').slice(0, 200);
  t.amount = Math.round(Number(x.amount) || 0);
  t.recurring_id = String(x.recurring_id || '').slice(0, 80); t.rec_month = String(x.rec_month || '').slice(0, 7);
  t.source = String(x.source || 'manual').slice(0, 10); t.created = Number(x.created) || t.updated;
  return t;
}
function entryRow_(e, rev) {
  return ENTRY_COLS.map(function (c) {
    if (c === 'rev') return rev;
    var v = e[c];
    if (v === undefined || v === null) return '';
    // =, +, -, @ 로 시작하는 글자는 시트가 수식으로 읽지 않게 앞에 ' 를 붙임
    if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
    return v;
  });
}
function rowEntry_(r) {
  var o = {};
  for (var i = 0; i < ENTRY_COLS.length; i++) {
    var c = ENTRY_COLS[i], v = r[i];
    if (NUM_COLS[c]) o[c] = Number(v) || 0;
    else o[c] = v === null || v === undefined ? '' : String(v).replace(/^'/, '');
  }
  if (!o.deleted) {
    delete o.deleted;
  } else {   // 지운 내역은 id 만 있으면 됨
    return { id: o.id, rev: o.rev, updated: o.updated, dev: o.dev, deleted: 1 };
  }
  return o;
}
function parseJson_(s) {
  if (s === '' || s === null || s === undefined) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch (e) { return null; }
}
function mergeObj_(a, b) {
  var o = {}, k;
  if (a && typeof a === 'object') for (k in a) o[k] = a[k];
  if (b && typeof b === 'object') for (k in b) o[k] = b[k];
  return o;
}

/* ---------- 구글 시트 연결 부분 ---------- */
function doGet() {
  return json_({ ok: true, app: 'ledger-sync', version: 1 });
}
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    var req = JSON.parse(e.postData.contents);
    return json_(handleSync_(req, sheetStore_()));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function sheetOf_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  var cols = name === 'entries' ? ENTRY_COLS : SETTING_COLS;
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // 날짜·시간·id 가 날짜/숫자로 바뀌지 않게 글자 형식으로
    for (var i = 0; i < cols.length; i++)
      if (!NUM_COLS[cols[i]]) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
  }
  return sh;
}
function sheetStore_() {
  var props = PropertiesService.getScriptProperties();
  var tz = Session.getScriptTimeZone();
  return {
    read: function (name) {
      var sh = sheetOf_(name), cols = name === 'entries' ? ENTRY_COLS : SETTING_COLS;
      var n = sh.getLastRow() - 1;
      if (n < 1) return [];
      var rows = sh.getRange(2, 1, n, cols.length).getValues();
      // 시트에서 직접 고친 날짜가 날짜 형식이 되었으면 글자로 되돌림
      for (var r = 0; r < rows.length; r++) for (var c = 0; c < cols.length; c++) {
        var v = rows[r][c];
        if (v instanceof Date) {
          rows[r][c] = Utilities.formatDate(v, tz, cols[c] === 'time' ? 'HH:mm' : cols[c] === 'rec_month' ? 'yyyy-MM' : 'yyyy-MM-dd');
        }
      }
      return rows;
    },
    update: function (name, i, row) { sheetOf_(name).getRange(i + 2, 1, 1, row.length).setValues([row]); },
    append: function (name, rows) {
      var sh = sheetOf_(name);
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    },
    getProp: function (k) { return props.getProperty(k); },
    setProp: function (k, v) { props.setProperty(k, v); }
  };
}

// 처음 한 번 실행: 가족 비밀번호 저장 + 시트 만들기
function setup() {
  if (!FAMILY_CODE || FAMILY_CODE === '여기에-가족-비밀번호' || FAMILY_CODE.length < 4)
    throw new Error('FAMILY_CODE 를 4글자 이상 가족 비밀번호로 바꾼 뒤 다시 실행하세요.');
  var props = PropertiesService.getScriptProperties();
  props.setProperty('FAMILY_CODE', FAMILY_CODE);
  if (!props.getProperty('REV')) props.setProperty('REV', '0');
  sheetOf_('entries'); sheetOf_('settings');
  Logger.log('준비 완료. 이제 [배포] → [새 배포] → 웹 앱 으로 배포하세요.');
}

// 시트에서 직접 고치면 휴대폰에도 반영되도록 rev·updated 를 새로 매김
function onEdit(e) {
  try {
    var sh = e.range.getSheet(), name = sh.getName();
    if (name !== 'entries' && name !== 'settings') return;
    var cols = name === 'entries' ? ENTRY_COLS : SETTING_COLS;
    var r0 = Math.max(2, e.range.getRow()), r1 = e.range.getLastRow();
    if (r1 < r0) return;
    var c0 = e.range.getColumn(), c1 = e.range.getLastColumn();
    if (c0 >= 2 && c1 <= 3) return;   // rev·updated 칸 자체를 고친 경우는 무시
    var props = PropertiesService.getScriptProperties();
    var rev = (Number(props.getProperty('REV')) || 0) + 1, now = Date.now();
    props.setProperty('REV', String(rev));
    var vals = [];
    for (var r = r0; r <= r1; r++) vals.push([rev, now]);
    sh.getRange(r0, 2, vals.length, 2).setValues(vals);
  } catch (err) {}
}
