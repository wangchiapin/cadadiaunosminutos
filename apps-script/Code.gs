// ===== 設定區 =====
const TUTORING_SHEET_ID = '11Y3E88sBr6JGkn9LVQb3po6MoJkM6O5BrAHXCym9jaY';
// ===== 總同步（依序執行所有階段）=====
function syncAllTutoring() {
  syncScheduleBasics();
  syncStudentRecords();
  syncScheduleGrid();
  syncActualRecords();
  syncDailyIncome();
  syncCourseCalendar();
}
// ===== 主要同步函式（第一階段）=====
function syncScheduleBasics() {
  const token = getAccessToken();
  const projectId = PropertiesService.getScriptProperties().getProperty('FIREBASE_PROJECT_ID');
  const uid = PropertiesService.getScriptProperties().getProperty('MONEYBOOK_UID');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/schedules/${uid}`;

  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const doc = JSON.parse(res.getContentText());
  const ss = SpreadsheetApp.openById(TUTORING_SHEET_ID);

  // ---- 學生收費設定：合併 rates + studentInfo ----
  const rates = (doc.fields.rates && doc.fields.rates.mapValue.fields) || {};
  const studentInfo = (doc.fields.studentInfo && doc.fields.studentInfo.mapValue.fields) || {};

  const feeRows = Object.keys(rates).map(name => {
    const rate = Number(rates[name].integerValue || rates[name].doubleValue || 0);
    const info = studentInfo[name] ? studentInfo[name].mapValue.fields : {};
    const nat = info.nat ? info.nat.stringValue : '';
    const origFee = info.origFee ? info.origFee.stringValue : '';
    return [name, nat, origFee, rate];
  });

  const feeSheet = ss.getSheetByName('學生收費設定');
  feeSheet.clearContents();
  feeSheet.appendRow(['學生', '國籍代碼', '原幣收費', '台幣收費']);
  if (feeRows.length > 0) {
    feeSheet.getRange(2, 1, feeRows.length, 4).setValues(feeRows);
  }

  // ---- 無緣的學生：retired ----
  const retired = (doc.fields.retired && doc.fields.retired.mapValue.fields) || {};
  const retiredRows = Object.keys(retired).map(name => {
    const f = retired[name].mapValue.fields;
    const rate = f.rate ? Number(f.rate.integerValue || f.rate.doubleValue || 0) : '';
    const retiredAt = f.retiredAt ? new Date(Number(f.retiredAt.integerValue)).toISOString().slice(0, 10) : '';
    return [name, rate, retiredAt];
  });

  const retiredSheet = ss.getSheetByName('無緣的學生');
  retiredSheet.clearContents();
  retiredSheet.appendRow(['學生', '停課前收費', '停課日期']);
  if (retiredRows.length > 0) {
    retiredSheet.getRange(2, 1, retiredRows.length, 3).setValues(retiredRows);
  }

  Logger.log('同步完成：收費設定 ' + feeRows.length + ' 位，無緣學生 ' + retiredRows.length + ' 位');
}

// ===== 取得存取權杖 =====
function getAccessToken() {
  const props = PropertiesService.getScriptProperties();
  const rawKey = props.getProperty('FIREBASE_PRIVATE_KEY');
  const privateKey = rawKey.replace(/\\n/g, '\n');

  const service = OAuth2.createService('Firestore')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setPrivateKey(privateKey)
    .setIssuer(props.getProperty('FIREBASE_CLIENT_EMAIL'))
    .setPropertyStore(props)
    .setScope('https://www.googleapis.com/auth/datastore');

  service.reset();

  if (!service.hasAccess()) {
    Logger.log('詳細錯誤：' + service.getLastError());
  }
  return service.getAccessToken();
}
// ===== 通用工具：把 Firestore 回傳的欄位格式轉成一般 JS 資料 =====
function fsValueToJs(value) {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.nullValue !== undefined) return '';
  if (value.mapValue !== undefined) {
    const obj = {};
    const fields = value.mapValue.fields || {};
    Object.keys(fields).forEach(k => obj[k] = fsValueToJs(fields[k]));
    return obj;
  }
  if (value.arrayValue !== undefined) {
    const values = value.arrayValue.values || [];
    return values.map(fsValueToJs);
  }
  return '';
}

// ===== 取得或建立分頁（若已存在則清空內容重用）=====
function getOrCreateSheet(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  } else {
    sheet.clearContents();
  }
  return sheet;
}
// ===== 主要同步函式（第二階段：學生資料）=====
function syncStudentRecords() {
  const token = getAccessToken();
  const projectId = PropertiesService.getScriptProperties().getProperty('FIREBASE_PROJECT_ID');
  const uid = PropertiesService.getScriptProperties().getProperty('MONEYBOOK_UID');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/studentRecords/${uid}`;

  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const doc = JSON.parse(res.getContentText());
  const ss = SpreadsheetApp.openById(TUTORING_SHEET_ID);

  // 整份 data 欄位一次轉成 JS 物件：{ studentId: { basic: {...}, classes: [...] } }
  const dataObj = doc.fields.data ? fsValueToJs(doc.fields.data) : {};
  const studentIds = Object.keys(dataObj);

  // ---- 學生總覽 ----
  const preferredBasicKeys = ['name', 'nationality', 'age', 'occupation', 'status', 'goal', 'hobby', 'duration', 'reason'];
  const allBasicKeys = new Set(preferredBasicKeys);
  studentIds.forEach(id => {
    const basic = dataObj[id].basic || {};
    Object.keys(basic).forEach(k => allBasicKeys.add(k));
  });
  const basicKeys = Array.from(allBasicKeys);

  const overviewSheet = getOrCreateSheet(ss, '學生總覽');
  // 最後多一欄「是否封存」：學生上課狀況裡移到「無緣的學生」的人標「是」，在學的留空
  overviewSheet.appendRow(basicKeys.concat(['是否封存']));
  const overviewRows = studentIds.map(id => {
    const basic = dataObj[id].basic || {};
    return basicKeys.map(k => (basic[k] !== undefined ? basic[k] : '')).concat([dataObj[id].isArchived ? '是' : '']);
  });
  if (overviewRows.length > 0) {
    overviewSheet.getRange(2, 1, overviewRows.length, basicKeys.length + 1).setValues(overviewRows);
  }

  // ---- 個別學生分頁（上課紀錄）----
  const preferredClassKeys = ['time', 'hours', 'price', 'progress', 'status', 'homework', 'next', 'prepaidInput'];

  studentIds.forEach(id => {
    const student = dataObj[id];
    const basic = student.basic || {};
    const classes = student.classes || [];
    const name = basic.name || id;

    // Google Sheet 分頁名稱不能超過100字、不能有這些符號
    const safeName = String(name).replace(/[:\\/?*\[\]]/g, '').substring(0, 90);

    const allClassKeys = new Set(preferredClassKeys);
    classes.forEach(c => Object.keys(c).forEach(k => { if (k !== 'pending' && k !== 'ymd') allClassKeys.add(k); }));  // pending＝待確認標記、ymd＝背後存的完整日期，都不寫進 Sheet
    const classKeys = Array.from(allClassKeys);

    const studentSheet = getOrCreateSheet(ss, safeName);
    studentSheet.appendRow(classKeys);
    const classRows = classes.map(c => classKeys.map(k => (c[k] !== undefined ? c[k] : '')));
    if (classRows.length > 0) {
      studentSheet.getRange(2, 1, classRows.length, classKeys.length).setValues(classRows);
    }
  });

  Logger.log('同步完成：學生總覽 ' + studentIds.length + ' 位，個別分頁已建立/更新');
}
// ===== 主要同步函式（第三階段：課程安排，排成格狀課表）=====
function syncScheduleGrid() {
  const token = getAccessToken();
  const projectId = PropertiesService.getScriptProperties().getProperty('FIREBASE_PROJECT_ID');
  const uid = PropertiesService.getScriptProperties().getProperty('MONEYBOOK_UID');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/schedules/${uid}`;

  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const doc = JSON.parse(res.getContentText());
  const ss = SpreadsheetApp.openById(TUTORING_SHEET_ID);

  const scheduleObj = doc.fields.schedule ? fsValueToJs(doc.fields.schedule) : {};

  const dayLabels = ['一', '二', '三', '四', '五', '六', '日'];
  const startHour = 7;
  let endHour = 22; // 預設到 21:00-22:00；有課程需要更晚的時段時會自動往下延伸，課刪掉/改短之後下次同步會自動縮回來

  // 跟主 App 一致的「開始分鐘／課程長度」判讀：沒有 startMin/durationMin 欄位，就當作整點開始、1小時
  function entryStartMin(e){ return (e && e.startMin === 30) ? 30 : 0; }
  function entryDurMin(e){ return (e && e.durationMin > 0) ? e.durationMin : 60; }
  function entryAbsStart(h, e){ return h * 60 + entryStartMin(e); }
  function entryAbsEnd(h, e){ return entryAbsStart(h, e) + entryDurMin(e); }
  function fmtHM(totalMin){
    const m = ((totalMin % 1440) + 1440) % 1440;
    const hh = Math.floor(m / 60), mm = m % 60;
    return (hh < 10 ? '0' + hh : hh) + ':' + (mm < 10 ? '0' + mm : mm);
  }

  // 先掃一遍，看看時間軸要不要往下延伸
  Object.keys(scheduleObj).forEach(key => {
    const hour = Number(key.split('_')[0]);
    const entry = scheduleObj[key];
    if (!entry || !entry.name || entry.name === 'X') return;
    const neededEndHour = Math.ceil(entryAbsEnd(hour, entry) / 60);
    if (neededEndHour > endHour) endHour = neededEndHour;
  });

  // 建立空白格子網格
  const grid = [];
  grid.push(['時間', ...dayLabels]);
  for (let h = startHour; h < endHour; h++) {
    const rowLabel = (h < 10 ? '0' + h : h) + ':00-' + ((h + 1) < 10 ? '0' + (h + 1) : (h + 1)) + ':00';
    grid.push([rowLabel, '', '', '', '', '', '', '']);
  }

  // 把 schedule 裡每一筆資料填進「起始格」；不是整點1小時的課，格子文字會多帶實際起訖時間
  // （例如「Mirna 08:00-10:00」），後面被蓋過去的格子維持空白——跟主 App 的 Excel 匯出邏輯一致
  Object.keys(scheduleObj).forEach(key => {
    const parts = key.split('_');
    const hour = Number(parts[0]);
    const dayIndex = Number(parts[1]);
    const entry = scheduleObj[key];
    if (!entry || !entry.name) return;

    if (hour >= startHour && hour < endHour && dayIndex >= 0 && dayIndex <= 6) {
      const rowIndex = 1 + (hour - startHour);
      const colIndex = 1 + dayIndex;
      const isStandard = entryStartMin(entry) === 0 && entryDurMin(entry) === 60;
      let text = entry.name;
      if (entry.name !== 'X' && !isStandard) {
        text += ' ' + fmtHM(entryAbsStart(hour, entry)) + '-' + fmtHM(entryAbsEnd(hour, entry));
      }
      grid[rowIndex][colIndex] = text;
    }
  });

  const sheet = getOrCreateSheet(ss, '課程安排');
  sheet.clearContents(); // 先清空，避免時間軸縮回去時，舊的多餘列殘留在 Sheet 上
  sheet.getRange(1, 1, grid.length, grid[0].length).setValues(grid);

  Logger.log('同步完成：課程安排格狀課表已更新');
}
// ===== 主要同步函式（第四階段：實際收入與匯款紀錄）=====
function syncActualRecords() {
  const token = getAccessToken();
  const projectId = PropertiesService.getScriptProperties().getProperty('FIREBASE_PROJECT_ID');
  const uid = PropertiesService.getScriptProperties().getProperty('MONEYBOOK_UID');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/actualRecords/${uid}`;

  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const doc = JSON.parse(res.getContentText());
  const ss = SpreadsheetApp.openById(TUTORING_SHEET_ID);

  const records = doc.fields.records ? fsValueToJs(doc.fields.records) : [];

  // 固定欄位順序（英文欄位名 → 中文標題）
  const columnMap = [
    ['date', '收款日'],
    ['student', '學生'],
    ['fee', '每堂收費'],
    ['remitted', '匯入金額(美金/墨幣)'],
    ['actual', '實收金額(美金/墨幣)'],
    ['rate', '匯率'],
    ['twd', '台幣'],
    ['convTwd', '換算台幣'],
    ['classes', '購買堂數'],
    ['method', '匯款方式'],
    ['avg', '平均每堂'],
    ['ppFee', 'PayPal手續費'],
    ['ppRate', 'PayPal手續費率'],
    ['notes', '備考']
  ];

  const sheet = getOrCreateSheet(ss, '實際收入與匯款紀錄');
  sheet.appendRow(columnMap.map(c => c[1]));

  const rows = records.map(r => columnMap.map(c => (r[c[0]] !== undefined ? r[c[0]] : '')));

  const BATCH_SIZE = 2000;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    sheet.getRange(2 + i, 1, batch.length, columnMap.length).setValues(batch);
  }

  Logger.log('同步完成：實際收入與匯款紀錄 ' + rows.length + ' 筆');
}
function syncDailyIncome() {
  const token = getAccessToken();
  const projectId = PropertiesService.getScriptProperties().getProperty('FIREBASE_PROJECT_ID');
  const uid = PropertiesService.getScriptProperties().getProperty('MONEYBOOK_UID');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/dailyIncome/${uid}`;

  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const doc = JSON.parse(res.getContentText());
  const ss = SpreadsheetApp.openById(TUTORING_SHEET_ID);

  const classIncomeData = doc.fields.classIncomeData ? fsValueToJs(doc.fields.classIncomeData) : {};
  const dates = Object.keys(classIncomeData).sort();

  const detailRows = [];
  dates.forEach(date => {
    const slots = classIncomeData[date] || [];
    slots.forEach((raw, idx) => {
      if (raw !== '' && raw !== undefined && raw !== null) {
        const hasStar = String(raw).indexOf('*') !== -1;
        const numericPart = String(raw).replace(/[^\d.]/g, ''); // 只留數字和小數點
        const amount = numericPart === '' ? '' : Number(numericPart);
        detailRows.push([date, idx + 1, amount, hasStar ? '特殊(未上課但收款)' : '']);
      }
    });
  });

  const detailSheet = getOrCreateSheet(ss, '每日收入明細');
  detailSheet.appendRow(['日期', '堂序', '金額', '備註']);
  if (detailRows.length > 0) {
    detailSheet.getRange(2, 1, detailRows.length, 4).setValues(detailRows);
  }

  // ---- 學生收費快照：studentFeeData ----
  const studentFeeData = doc.fields.studentFeeData ? fsValueToJs(doc.fields.studentFeeData) : [];
  const feeRows = studentFeeData.map(f => [f.name || '', f.fee || '', f.twd || '']);

  const feeSheet = getOrCreateSheet(ss, '每日收入_學生收費快照');
  feeSheet.appendRow(['學生', '原幣收費', '台幣收費']);
  if (feeRows.length > 0) {
    feeSheet.getRange(2, 1, feeRows.length, 3).setValues(feeRows);
  }

  Logger.log('同步完成：每日收入明細 ' + detailRows.length + ' 筆');
}
// ===== 讀取網頁上的「請假／沒上課有付錢」標記 =====
// base = '.../documents/users/{uid}/'（結尾要有斜線）
// 新版：users/{uid}/ttMeta/marks 一份文件，欄位 items = { 代號: {key, leave, paidAbsence, ...} }
// 舊版：users/{uid}/ttMarks 底下一標記一份文件。新文件還不存在時（網頁還沒搬家）退回讀舊版。
// 回傳 { 標記key: {key, leave, paidAbsence, ...} }
function loadTtMarks(base, headers) {
  const marks = {};
  const res = UrlFetchApp.fetch(base + 'ttMeta/marks', { headers: headers, muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code === 200) {
    const doc = JSON.parse(res.getContentText());
    const items = (doc.fields && doc.fields.items) ? fsValueToJs(doc.fields.items) : {};
    Object.keys(items).forEach(id => {
      const obj = items[id];
      if (obj && obj.key) marks[obj.key] = obj;
    });
    return marks;
  }
  if (code !== 404) throw new Error('讀取標記失敗：' + res.getContentText());
  // 404 → 舊版集合
  let pageToken = '';
  do {
    const url = base + 'ttMarks?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const json = JSON.parse(UrlFetchApp.fetch(url, { headers: headers }).getContentText());
    (json.documents || []).forEach(d => {
      const obj = {};
      Object.keys(d.fields || {}).forEach(k => obj[k] = fsValueToJs(d.fields[k]));
      if (obj.key) marks[obj.key] = obj;
    });
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return marks;
}

// ===== 主要同步函式（第五階段：TimeTree 課表＋網頁標記，鏡像整頁覆蓋）=====
// 讀取 users/{uid}/ttSync/state（GitHub Actions 每 3 小時從 TimeTree「課表」同步進來的課）
// 與 users/{uid}/ttMeta/marks（在網頁上標記的「請假／沒上課有付錢」），合併後寫進「課程行事曆」分頁。
// 跟其他分頁一樣：每次同步整頁重寫，內容永遠等於目前的 TimeTree 課表＋網頁標記。
function syncCourseCalendar() {
  const token = getAccessToken();
  const props = PropertiesService.getScriptProperties();
  const projectId = props.getProperty('FIREBASE_PROJECT_ID');
  const uid = props.getProperty('MONEYBOOK_UID');
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}/`;
  const headers = { Authorization: 'Bearer ' + token };

  // ---- TimeTree 課表（單一文件）----
  const stateRes = UrlFetchApp.fetch(base + 'ttSync/state', { headers: headers, muteHttpExceptions: true });
  if (stateRes.getResponseCode() === 404) {
    Logger.log('還沒有 TimeTree 課表資料（GitHub 自動同步還沒成功跑過），這次略過');
    return;
  }
  const stateDoc = JSON.parse(stateRes.getContentText());
  if (stateRes.getResponseCode() !== 200) {
    throw new Error('讀取 TimeTree 課表失敗：' + stateRes.getContentText());
  }
  const fields = stateDoc.fields || {};
  const events = fields.events ? fsValueToJs(fields.events) : [];
  const lastSyncISO = fields.lastSyncISO ? fsValueToJs(fields.lastSyncISO) : '';

  // ---- 網頁上的標記（新版：一份文件 ttMeta/marks；找不到時退回讀舊版 ttMarks 集合）----
  const marks = loadTtMarks(base, headers);

  const WD_LABEL = ['日', '一', '二', '三', '四', '五', '六'];
  function weekday(iso) {
    const p = iso.split('-');
    return WD_LABEL[new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay()];
  }

  const rows = events.map(ev => {
    const mk = marks[ev.key] || {};
    let status = '正常';
    if (ev.allDay) status = '整天行程（不是課）';
    else if (mk.leave) status = '請假';
    const kind = ev.allDay ? '整天' : (ev.recurring ? '每週重複' : '單次');
    return [
      ev.date || '', ev.date ? weekday(ev.date) : '', ev.startTime || '', ev.endTime || '',
      ev.title || '', status, (mk.paidAbsence && !mk.leave) ? '是' : '', kind, ev.note || ''
    ];
  });
  rows.sort((a, b) => (a[0] + a[2]).localeCompare(b[0] + b[2]));

  const ss = SpreadsheetApp.openById(TUTORING_SHEET_ID);
  const sheet = getOrCreateSheet(ss, '課程行事曆');
  sheet.appendRow(['日期', '星期', '開始', '結束', '學生（TimeTree 標題）', '狀態', '沒上課有付錢', '類型', '備註']);
  if (rows.length > 0) {
    // 日期與時間欄位設成純文字，避免 Google Sheet 自動把 "09:00" 轉成別的格式
    sheet.getRange(2, 1, rows.length, 4).setNumberFormat('@');
    const BATCH_SIZE = 2000;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      sheet.getRange(2 + i, 1, batch.length, 9).setValues(batch);
    }
  }

  Logger.log('同步完成：TimeTree 課表 ' + rows.length + ' 筆（TimeTree 最後同步：' + lastSyncISO + '）');
}
