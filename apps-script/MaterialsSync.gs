// ===== 教材同步：Drive「一位學生一個資料夾」裡的 PDF → 學生頁「學習 → 教材」=====
// 做什麼：定時掃描 Drive 的學生資料夾，把每位學生資料夾裡的 PDF（名稱、連結、日期）寫到
//         Firestore  portal/{老師uid}/materials/{學生代號}；學生在自己的頁面點一下就能打開或下載。
// 學生看不到別人的：規則只讓「電子郵件已驗證、而且是這位學生」的人讀自己那一份（見學生頁 repo 的規則檔，第七批）。
//
// 使用方式（在 Apps Script 編輯器裡，跟 Code.gs 放在同一個專案，會用到 getAccessToken、fsValueToJs）：
//   1. 「專案設定 → 指令碼屬性」新增：
//        MATERIALS_ROOT_FOLDER_ID ＝ 放「所有學生資料夾」的那個大資料夾的 ID（網址 folders/ 後面那一串）
//        PORTAL_TID（選填）＝ 老師代號；不填就用 MONEYBOOK_UID（跟日誌發佈學生頁用的是同一個）
//        MATERIALS_ALIASES（選填）＝ 資料夾名字跟日誌名字對不起來時的對照，JSON 格式，例如 {"Alberto墨西哥":"Alberto(MX)","Liz&Juan":["Liz","Juan"]}
//        MATERIALS_AUTO_SHARE（選填）＝ 填 false 就不會自動改檔案的分享設定；沒填＝會
//   2. 先執行一次 previewMaterials()：只看不寫，記錄裡會列出每個資料夾對到哪位學生、有幾個 PDF、哪些資料夾對不到。
//   3. 沒問題就執行 syncMaterials()，再執行一次 installMaterialsTrigger()：之後每 30 分鐘自動更新。
//   4. 取消：執行 removeMaterialsTrigger()。
//
// 資料夾名稱跟日誌的學生名字一樣最好（大小寫、空白不影響）；名字後面多了字也會對到（例如「Mirna米娜」對「Mirna」），只要不會對到兩位以上。
// 其他對不起來的，用 MATERIALS_ALIASES 手動對照。對不到的資料夾會列在記錄裡，不會亂猜。
// 分享設定：學生不用寄信邀請，檔案要設成「知道連結的人都能檢視」，連結才打得開。
//   預設會自動把掃到的 PDF 設成這樣（只開檢視，不能編輯）；連結很長、猜不到，而且只有那位學生的頁面會出現，
//   但學生如果轉傳連結，別人也打得開。不想讓程式改分享設定，就設 MATERIALS_AUTO_SHARE ＝ false，自己在 Drive 設。
// 本檔案前半段是「純計算」，不碰 Google 服務，可以在電腦上用假資料測試。

// ---------- 純計算 ----------
// 名字比對：去掉前後空白與中間空白、轉小寫、全形英數轉半角
function msNormName(s) {
  return String(s == null ? '' : s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[\s　]+/g, '').toLowerCase();
}

// folders: [{id, name}]、students: { 學生代號: 名字 }、aliases（選填）: { 資料夾名字: 學生名字 或 [學生名字, ...] }
// 回傳 { matched:[{folder, sid}], unmatched:[folder 名字], ambiguous:[folder 名字] }
// 對的順序：1) 名字完全一樣  2) 你在 MATERIALS_ALIASES 寫的對照  3) 資料夾名字「以某位學生的名字開頭」，而且只有一位（例如「Mirna米娜」對「Mirna」）。
// 還是不確定（同名、或開頭對到兩位以上）就不猜，放進 ambiguous。一個資料夾可以對到多位學生（例如兩人共用一個資料夾，用對照寫兩個名字）。
function msMatchFolders(folders, students, aliases) {
  var byName = {}, names = [];
  Object.keys(students || {}).forEach(function (sid) {
    var k = msNormName(students[sid]);
    if (!k) return;
    if (!byName[k]) { byName[k] = []; names.push(k); }
    byName[k].push(sid);
  });
  var al = {};
  Object.keys(aliases || {}).forEach(function (fn) { al[msNormName(fn)] = [].concat(aliases[fn]); });
  var out = { matched: [], unmatched: [], ambiguous: [] };
  (folders || []).forEach(function (f) {
    var fk = msNormName(f.name), ids = byName[fk] || [], viaAlias = false;
    if (ids.length === 0 && al[fk]) {
      viaAlias = true;
      al[fk].forEach(function (n) { ids = ids.concat(byName[msNormName(n)] || []); });
    }
    if (ids.length === 0) {
      var pre = names.filter(function (k) { return k.length >= 2 && fk.indexOf(k) === 0; });
      if (pre.length === 1) ids = byName[pre[0]];
      else if (pre.length > 1) { out.ambiguous.push(f.name); return; }
    }
    if (ids.length === 0) out.unmatched.push(f.name);
    else if (ids.length > 1 && !viaAlias) out.ambiguous.push(f.name);
    else ids.forEach(function (sid) { out.matched.push({ folder: f, sid: sid }); });
  });
  return out;
}

// 檔案清單 → 要寫的內容。files: [{name, url, ms}]；只收 https 的 Google 連結；最多 300 份；新的在前
function msBuildFiles(files) {
  var list = (files || []).filter(function (f) { var u = String((f && f.url) || ''); return u.indexOf('https://drive.google.com/') === 0 || u.indexOf('https://docs.google.com/') === 0; })
    .map(function (f) { return { n: String(f.name || '').replace(/\.pdf$/i, '').slice(0, 120), u: String(f.url), t: Math.round(+f.ms) || 0 }; });
  list.sort(function (a, b) { return b.t - a.t || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0); });
  return list.slice(0, 300);
}

// 一般資料 → Firestore REST 欄位格式
function msToFs(v) {
  if (Array.isArray(v)) return { arrayValue: { values: v.map(msToFs) } };
  if (v !== null && typeof v === 'object') {
    var f = {};
    Object.keys(v).forEach(function (k) { f[k] = msToFs(v[k]); });
    return { mapValue: { fields: f } };
  }
  if (typeof v === 'number') return { integerValue: String(Math.round(v)) };
  return { stringValue: String(v) };
}
function msBuildDoc(files, nowMs) {
  return { fields: { v: msToFs(1), updatedAt: msToFs(nowMs), files: msToFs(msBuildFiles(files)) } };
}

// ---------- 以下會用到 Google 服務 ----------
function msParseAliases_(txt) {
  if (!txt) return {};
  try { var o = JSON.parse(txt); return o && typeof o === 'object' ? o : {}; }
  catch (e) { throw new Error('MATERIALS_ALIASES 不是正確的 JSON：' + e.message); }
}

function msProps_() {
  var p = PropertiesService.getScriptProperties();
  var root = p.getProperty('MATERIALS_ROOT_FOLDER_ID');
  if (!root) throw new Error('還沒設定 MATERIALS_ROOT_FOLDER_ID（指令碼屬性）');
  var tid = p.getProperty('PORTAL_TID') || p.getProperty('MONEYBOOK_UID');
  if (!tid) throw new Error('找不到老師代號：請設定 PORTAL_TID 或 MONEYBOOK_UID');
  return { root: root, tid: tid, project: p.getProperty('FIREBASE_PROJECT_ID'), autoShare: p.getProperty('MATERIALS_AUTO_SHARE') !== 'false', aliases: msParseAliases_(p.getProperty('MATERIALS_ALIASES')) };
}

// 讀 portal/{tid}/students 全部（日誌發佈的），回傳 { 學生代號: 名字 }（略過已停課的）
function msLoadStudents_(P, token) {
  var base = 'https://firestore.googleapis.com/v1/projects/' + P.project + '/databases/(default)/documents/portal/' + P.tid + '/students';
  var out = {}, pageToken = '';
  do {
    var res = UrlFetchApp.fetch(base + '?pageSize=100' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), { headers: { Authorization: 'Bearer ' + token } });
    var j = JSON.parse(res.getContentText());
    (j.documents || []).forEach(function (d) {
      var sid = d.name.split('/').pop();
      var f = d.fields || {};
      if (f.archived && f.archived.booleanValue) return;
      var name = f.name && f.name.stringValue;
      if (name) out[sid] = name;
    });
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

function msScan_(P, write) {
  var token = write ? getAccessToken() : null;
  var students = msLoadStudents_(P, token || getAccessToken());
  var folders = [], it = DriveApp.getFolderById(P.root).getFolders();
  while (it.hasNext()) { var fo = it.next(); folders.push({ id: fo.getId(), name: fo.getName() }); }
  var m = msMatchFolders(folders, students, P.aliases);
  var now = Date.now();
  m.matched.forEach(function (x) {
    var files = [], shared = 0, fit = DriveApp.getFolderById(x.folder.id).getFilesByType(MimeType.PDF);
    while (fit.hasNext()) {
      var f = fit.next();
      if (P.autoShare && write && f.getSharingAccess() !== DriveApp.Access.ANYONE_WITH_LINK && f.getSharingAccess() !== DriveApp.Access.ANYONE) {
        f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); shared++;
      }
      files.push({ name: f.getName(), url: f.getUrl(), ms: f.getDateCreated().getTime() });
    }
    Logger.log((write ? '寫入：' : '預覽：') + x.folder.name + ' → ' + students[x.sid] + '（' + files.length + ' 個 PDF' + (shared ? '，新設成連結可檢視 ' + shared + ' 個' : '') + '）');
    if (write) {
      var url = 'https://firestore.googleapis.com/v1/projects/' + P.project + '/databases/(default)/documents/portal/' + P.tid + '/materials/' + x.sid;
      UrlFetchApp.fetch(url, { method: 'patch', contentType: 'application/json', headers: { Authorization: 'Bearer ' + token }, payload: JSON.stringify(msBuildDoc(files, now)) });
    }
  });
  if (m.unmatched.length) Logger.log('對不到學生的資料夾（名字要跟日誌一樣）：' + m.unmatched.join('、'));
  if (m.ambiguous.length) Logger.log('有兩位以上學生同名，沒有處理：' + m.ambiguous.join('、'));
  var matchedSids = {}; m.matched.forEach(function (x) { matchedSids[x.sid] = 1; });
  var noFolder = Object.keys(students).filter(function (s) { return !matchedSids[s]; }).map(function (s) { return students[s]; });
  if (noFolder.length) Logger.log('沒有對到資料夾的學生：' + noFolder.join('、'));
}

function previewMaterials() { msScan_(msProps_(), false); }
function syncMaterials() { msScan_(msProps_(), true); }
function installMaterialsTrigger() {
  removeMaterialsTrigger();
  ScriptApp.newTrigger('syncMaterials').timeBased().everyMinutes(30).create();
}
function removeMaterialsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'syncMaterials') ScriptApp.deleteTrigger(t); });
}
