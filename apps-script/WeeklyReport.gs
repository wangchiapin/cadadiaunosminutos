// ===== 每週報表：每週日晚上 8 點寄到信箱（HTML 信件 + PDF 附件）=====
// 使用方式（在 Apps Script 編輯器裡）：
//   1. 先執行一次 previewWeeklyReport()：馬上寄一封試用信到你的信箱，確認樣子。
//   2. 滿意的話，執行一次 installWeeklyReportTrigger()：之後每週日 20:00（台灣時間）自動寄出。
//   3. 想換收件信箱：在「專案設定 → 指令碼屬性」新增 REPORT_EMAIL；沒設定就寄給你自己。
//   4. 想取消：執行 removeWeeklyReportTrigger()。
// 注意：本檔案前半段是「純計算＋排版」，不碰 Google 服務，所以可以在電腦上用假資料測試；
//       後半段「寄信／排程」才會用到 Apps Script 的功能。
// 需要跟 Code.gs 放在同一個專案（會用到 getAccessToken、fsValueToJs）。

var WR_TZ = 'Asia/Taipei';

// ---------- 日期小工具（全部用 'YYYY-MM-DD' 字串運算，避免時區搞錯）----------
function wrParseISO(iso) {
  var p = String(iso).split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
}
function wrFmtISO(d) {
  var m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}
function wrAddDays(iso, n) {
  var d = wrParseISO(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return wrFmtISO(d);
}
function wrWeekday(iso) { return wrParseISO(iso).getUTCDay(); } // 0=日
function wrWdLabel(iso) { return ['日', '一', '二', '三', '四', '五', '六'][wrWeekday(iso)]; }
function wrMonday(iso) { // 該日所在那週的星期一
  var wd = wrWeekday(iso);
  return wrAddDays(iso, wd === 0 ? -6 : 1 - wd);
}
function wrShort(iso) { var p = iso.split('-'); return (+p[1]) + '/' + (+p[2]); }
function wrMonthKey(iso) { return iso.slice(0, 7); }
function wrAddMonths(ym, n) {
  var p = ym.split('-'), y = +p[0], m = +p[1] - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + '-' + (m + 1 < 10 ? '0' + (m + 1) : (m + 1));
}

// ---------- 數字小工具 ----------
function wrNum(v) {
  var n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function wrMoney(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function wrEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 實收紀錄的幣別判斷：披索 / 台幣 / 美金（其餘外幣一律當美金）
function wrCurrencyOf(r) {
  var text = String(r.fee || '') + ' ' + String(r.notes || '') + ' ' + String(r.method || '');
  if (/披索|墨幣|墨西哥/.test(text)) return '披索';
  if (/台幣|台币/.test(text)) return '台幣';
  if (r.twd && !r.remitted && !r.actual) return '台幣';
  return '美金';
}

// 學生預付倒數（跟網頁「學生上課狀況」同一套算法）；沒有任何預付紀錄就回傳 null
function wrCountdownOf(student) {
  var cd = null;
  ((student && student.classes) || []).forEach(function (c) {
    if (c && c.prepaidInput && String(c.prepaidInput).trim() !== '') {
      var v = parseInt(c.prepaidInput, 10);
      if (!isNaN(v)) cd = v;
    } else if (cd !== null) { cd--; }
  });
  return cd;
}

// TimeTree 課的標題對應學生：完全相同，或「姓名 後面接空白／括號」
function wrTitleMatches(name, title) {
  var n = String(name == null ? '' : name).trim().toLowerCase();
  var t = String(title == null ? '' : title).trim().toLowerCase();
  if (!n || !t) return false;
  return t === n || t.indexOf(n + ' ') === 0 || t.indexOf(n + '(') === 0 || t.indexOf(n + '（') === 0;
}

// ---------- 計算：把原始資料變成報表要用的數字 ----------
// input: { schedule:{retired,monthlyGoals,settings}, daily:{classIncomeData}, actual:{records}, students:{data}, tt:{events}, marks:{key:{leave,paidAbsence}}, nowMs }
function wrBuildReportData(input, todayISO) {
  var sch = input.schedule || {};
  var income = (input.daily && input.daily.classIncomeData) || {};
  var records = (input.actual && input.actual.records) || [];
  var events = (input.tt && input.tt.events) || [];
  var marks = input.marks || {};
  var goals = sch.monthlyGoals || {};
  var settings = sch.settings || {};

  var weekStart = wrMonday(todayISO);
  var weekEnd = wrAddDays(weekStart, 6);
  var nextStart = wrAddDays(weekStart, 7);
  var nextEnd = wrAddDays(weekStart, 13);
  var thisMonth = wrMonthKey(todayISO);
  var thisYear = todayISO.slice(0, 4);

  // --- 每日收入：各區間合計 ---
  var weekIncome = 0, weekClasses = 0, monthIncome = 0, yearIncome = 0;
  var monthTotals = {};
  Object.keys(income).forEach(function (d) {
    (income[d] || []).forEach(function (v) {
      var n = wrNum(v);
      if (n === null || String(v).trim() === '') return;
      var mk = wrMonthKey(d);
      monthTotals[mk] = (monthTotals[mk] || 0) + n;
      if (mk === thisMonth) monthIncome += n;
      if (d.slice(0, 4) === thisYear) yearIncome += n;
      if (d >= weekStart && d <= weekEnd) { weekIncome += n; weekClasses += 1; }
    });
  });

  function goalOfMonth(ym) { return Number(goals[+ym.slice(0, 4) - 1911]) || 0; }
  var monthGoal = goalOfMonth(thisMonth);

  // --- 近 12 個月 ---
  var trend = [];
  for (var i = 11; i >= 0; i--) {
    var ym = wrAddMonths(thisMonth, -i);
    trend.push({ ym: ym, total: monthTotals[ym] || 0, goal: goalOfMonth(ym) });
  }

  // --- 實收紀錄：今年依學生、依幣別 ---
  var byStudent = {}, byCurrency = {}, yearActual = 0;
  records.forEach(function (r) {
    if (String(r.date || '').slice(0, 4) !== thisYear) return;
    var n = wrNum(r.convTwd);
    if (n === null) return;
    var st = String(r.student || '（未填）').trim() || '（未填）';
    byStudent[st] = (byStudent[st] || 0) + n;
    var cur = wrCurrencyOf(r);
    byCurrency[cur] = (byCurrency[cur] || 0) + n;
    yearActual += n;
  });
  function toShareList(obj, limit) {
    var arr = Object.keys(obj).map(function (k) { return { name: k, value: obj[k] }; })
      .filter(function (x) { return x.value > 0; })
      .sort(function (a, b) { return b.value - a.value; });
    if (limit && arr.length > limit) {
      var rest = arr.slice(limit).reduce(function (s, x) { return s + x.value; }, 0);
      arr = arr.slice(0, limit); arr.push({ name: '其他', value: rest });
    }
    var total = arr.reduce(function (s, x) { return s + x.value; }, 0);
    arr.forEach(function (x) { x.pct = total ? x.value / total * 100 : 0; });
    return arr;
  }
  var studentShare = toShareList(byStudent, 7);
  var currencyShare = toShareList(byCurrency, 0);
  var foreignPct = yearActual ? (yearActual - (byCurrency['台幣'] || 0)) / yearActual * 100 : 0;

  // --- TimeTree 課表：本週檢查、下週預覽 ---
  function isClass(ev) { return !ev.allDay; }
  function isLeave(ev) { return !!(marks[ev.key] && marks[ev.key].leave); }
  var expectedByDate = {};
  var leaves = [], paid = [];
  events.forEach(function (ev) {
    if (!isClass(ev) || !ev.date) return;
    if (ev.date >= weekStart && ev.date <= weekEnd) {
      var mk = marks[ev.key] || {};
      if (mk.leave) leaves.push({ date: ev.date, time: ev.startTime || '', title: ev.title || '' });
      else if (mk.paidAbsence) paid.push({ date: ev.date, time: ev.startTime || '', title: ev.title || '' });
    }
    if (!isLeave(ev)) expectedByDate[ev.date] = (expectedByDate[ev.date] || 0) + 1;
  });
  var unfilled = [];
  for (var d = weekStart; d <= weekEnd && d <= todayISO; d = wrAddDays(d, 1)) {
    var expected = expectedByDate[d] || 0;
    var filled = (income[d] || []).filter(function (v) { return String(v == null ? '' : v).trim() !== ''; }).length;
    if (expected !== filled) unfilled.push({ date: d, expected: expected, filled: filled });
  }
  var byTime = function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); };
  leaves.sort(byTime); paid.sort(byTime);

  var nextDays = [];
  var nextClassCount = 0;
  for (var k = 0; k < 7; k++) {
    var nd = wrAddDays(nextStart, k);
    var list = events.filter(function (ev) { return isClass(ev) && ev.date === nd && !isLeave(ev); })
      .sort(function (a, b) { return String(a.startTime).localeCompare(String(b.startTime)); })
      .map(function (ev) { return { time: ev.startTime || '', title: ev.title || '' }; });
    nextClassCount += list.length;
    nextDays.push({ date: nd, items: list });
  }

  // --- 續課／收款提醒 ---
  // 包堂（或沒設定付費方式、但有預付倒數）：剩 2 堂以內；單次付費：下週有課的，列出第一堂
  var stuData = (input.students && input.students.data) || {};
  var renewPackage = [], renewSingle = [];
  Object.keys(stuData).forEach(function (id) {
    var s = stuData[id];
    if (!s || s.isArchived) return;
    var basic = s.basic || {};
    var name = basic.name || '未命名學生';
    if (basic.payMode === 'single') {
      var mine = events.filter(function (ev) {
        return isClass(ev) && ev.date >= nextStart && ev.date <= nextEnd && !isLeave(ev) && wrTitleMatches(basic.name, ev.title);
      }).sort(function (a, b) { return (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')); });
      if (mine.length) renewSingle.push({ name: name, date: mine[0].date, time: mine[0].startTime || '', count: mine.length });
    } else {
      var cd = wrCountdownOf(s);
      if (cd !== null && cd <= 2) renewPackage.push({ name: name, remaining: Math.max(cd, 0) });
    }
  });
  renewPackage.sort(function (a, b) { return a.remaining - b.remaining || String(a.name).localeCompare(String(b.name)); });
  renewSingle.sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });

  // --- 備份提醒 ---
  var remindDays = Number(settings.backupRemindDays) > 0 ? Number(settings.backupRemindDays) : 30;
  var lastBackupAt = Number(settings.lastBackupAt) || 0;
  var backupDaysAgo = lastBackupAt && input.nowMs ? Math.floor((input.nowMs - lastBackupAt) / 86400000) : null;
  var backupWarn = !lastBackupAt || (backupDaysAgo !== null && backupDaysAgo >= remindDays);

  return {
    todayISO: todayISO, weekStart: weekStart, weekEnd: weekEnd, nextStart: nextStart, nextEnd: nextEnd,
    weekIncome: weekIncome, weekClasses: weekClasses,
    monthIncome: monthIncome, monthGoal: monthGoal, monthPct: monthGoal ? monthIncome / monthGoal * 100 : null,
    yearIncome: yearIncome, yearActual: yearActual, foreignPct: foreignPct,
    trend: trend, studentShare: studentShare, currencyShare: currencyShare,
    unfilled: unfilled, leaves: leaves, paid: paid, nextDays: nextDays, nextClassCount: nextClassCount,
    renewPackage: renewPackage, renewSingle: renewSingle,
    backup: { never: !lastBackupAt, daysAgo: backupDaysAgo, remindDays: remindDays, warn: backupWarn }
  };
}

// ---------- 排版：產生 HTML（全部用表格＋行內樣式，Gmail 才不會跑版）----------
var WR_C = {
  bg: '#f4efe6', card: '#fbf8f2', line: '#e6dccb', text: '#3f3427', dim: '#8a7c68',
  gold: '#b08d57', goldPale: '#ddd1bb', sage: '#7d9a8c', sagePale: '#b3c7bd', berry: '#b5533c',
  warnBg: '#fbf0cf', warnLine: '#ead9a0'
};
var WR_SHARE_COLORS = ['#b08d57', '#7d9a8c', '#d3b88a', '#a5b8ad', '#9b7b4b', '#c9a56a', '#6b8579', '#cfc3ad'];

function wrCard(label, value, sub, highlight, col) {
  var pad = col === 0 ? '5px 5px 5px 0' : (col === 2 ? '5px 0 5px 5px' : '5px');
  return '<td width="33%" valign="top" style="padding:' + pad + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + (highlight ? '#f3ebdc' : WR_C.card) + ';border:1px solid ' + WR_C.line + ';border-radius:8px;">' +
    '<tr><td style="padding:12px 14px;">' +
    '<div style="font-size:12px;color:' + WR_C.dim + ';font-weight:700;">' + wrEsc(label) + '</div>' +
    '<div style="font-size:22px;color:' + WR_C.text + ';font-weight:800;margin:6px 0 4px;">' + value + '</div>' +
    '<div style="font-size:11.5px;color:' + WR_C.dim + ';">' + (sub || '&nbsp;') + '</div>' +
    '</td></tr></table></td>';
}

function wrSection(title, bodyHtml) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + WR_C.card + ';border:1px solid ' + WR_C.line + ';border-radius:8px;margin:0 0 12px;">' +
    '<tr><td style="padding:14px 16px;">' +
    '<div style="font-size:14px;font-weight:800;color:' + WR_C.text + ';margin-bottom:10px;">' + title + '</div>' + bodyHtml +
    '</td></tr></table>';
}

// 單條進度條：pct 0~100
function wrBar(pct, color, bg) {
  var p = Math.max(0, Math.min(100, pct || 0));
  var left = p > 0 ? '<td width="' + p.toFixed(1) + '%" style="background:' + color + ';height:12px;font-size:0;line-height:0;border-radius:6px 0 0 6px;">&nbsp;</td>' : '';
  var right = p < 100 ? '<td style="background:' + bg + ';height:12px;font-size:0;line-height:0;">&nbsp;</td>' : '';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' + left + right + '</tr></table>';
}

// 堆疊長條（占比）＋圖例
function wrShareBlock(list, emptyText) {
  if (!list.length) return '<div style="font-size:12.5px;color:' + WR_C.dim + ';">' + emptyText + '</div>';
  var segs = list.map(function (x, i) {
    return '<td width="' + Math.max(x.pct, 0.5).toFixed(1) + '%" style="background:' + WR_SHARE_COLORS[i % WR_SHARE_COLORS.length] + ';height:16px;font-size:0;line-height:0;">&nbsp;</td>';
  }).join('');
  var legend = list.map(function (x, i) {
    return '<tr><td width="14" style="padding:3px 0;"><div style="width:10px;height:10px;background:' + WR_SHARE_COLORS[i % WR_SHARE_COLORS.length] + ';border-radius:2px;"></div></td>' +
      '<td style="font-size:12.5px;color:' + WR_C.text + ';padding:3px 0;">' + wrEsc(x.name) + '</td>' +
      '<td align="right" style="font-size:12.5px;color:' + WR_C.dim + ';padding:3px 0;">NT$' + wrMoney(x.value) + '　' + x.pct.toFixed(1) + '%</td></tr>';
  }).join('');
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;"><tr>' + segs + '</tr></table>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + legend + '</table>';
}

function wrRenderHtml(data) {
  var C = WR_C;
  var rangeText = wrShort(data.weekStart) + ' – ' + wrShort(data.weekEnd);

  // 上方黃色提醒條
  var notes = [];
  if (data.unfilled.length) notes.push('本週有 ' + data.unfilled.length + ' 天「排課堂數」跟「已填收入筆數」對不起來');
  if (data.renewPackage.length || data.renewSingle.length) notes.push('有 ' + (data.renewPackage.length + data.renewSingle.length) + ' 位學生需要續課或收款');
  if (data.backup.warn) notes.push(data.backup.never ? '還沒做過完整備份' : '上次完整備份已經 ' + data.backup.daysAgo + ' 天前');
  var banner = notes.length
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.warnBg + ';border:1px solid ' + C.warnLine + ';border-radius:8px;margin:0 0 12px;"><tr><td style="padding:10px 14px;font-size:13px;color:' + C.text + ';">ⓘ ' + notes.map(wrEsc).join('；') + '。詳見下方「需要留意」。</td></tr></table>'
    : '';

  // 數字卡片（3 x 2）
  var monthSub = data.monthGoal ? '目標 NT$' + wrMoney(data.monthGoal) + '（' + data.monthPct.toFixed(0) + '%）' : '尚未設定月目標';
  var cards =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 7px;"><tr>' +
    wrCard('本週上課堂數', data.weekClasses + ' 堂', wrShort(data.weekStart) + ' – ' + wrShort(data.weekEnd), true, 0) +
    wrCard('本週收入', 'NT$' + wrMoney(data.weekIncome), '來自「每日上課收入」', false, 1) +
    wrCard('本月累計', 'NT$' + wrMoney(data.monthIncome), monthSub, false, 2) +
    '</tr><tr>' +
    wrCard('今年累計收入', 'NT$' + wrMoney(data.yearIncome), '每日上課收入合計', false, 0) +
    wrCard('外幣收入占比', data.foreignPct.toFixed(1) + '%', '今年實收（換算台幣）', false, 1) +
    wrCard('下週預計堂數', data.nextClassCount + ' 堂', wrShort(data.nextStart) + ' – ' + wrShort(data.nextEnd), false, 2) +
    '</tr></table>';

  // 近 12 個月
  var maxV = 1;
  data.trend.forEach(function (t) { maxV = Math.max(maxV, t.total, t.goal); });
  var trendRows = data.trend.map(function (t) {
    var reached = t.goal && t.total >= t.goal;
    var label = t.ym.replace('-', '/');
    var goalTxt = t.goal ? '目標 ' + wrMoney(t.goal) : '';
    return '<tr><td width="58" style="font-size:12px;color:' + C.dim + ';padding:4px 0;">' + label + '</td>' +
      '<td style="padding:4px 8px;">' + wrBar(t.total / maxV * 100, reached ? C.sage : C.gold, C.goldPale) + '</td>' +
      '<td width="150" align="right" style="font-size:12px;color:' + C.text + ';padding:4px 0;">' + wrMoney(t.total) +
      (goalTxt ? ' <span style="color:' + C.dim + ';">／ ' + goalTxt + '</span>' : '') + '</td></tr>';
  }).join('');
  var trendHtml = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + trendRows + '</table>' +
    '<div style="font-size:11.5px;color:' + C.dim + ';margin-top:6px;"><span style="color:' + C.sage + ';">■</span> 達到月目標　<span style="color:' + C.gold + ';">■</span> 還沒達到</div>';

  // 需要留意
  var alertHtml = '';
  function listBlock(title, rows) {
    return '<div style="font-size:12.5px;font-weight:700;color:' + C.text + ';margin:8px 0 4px;">' + title + '</div>' + rows;
  }
  function plainRow(left, right) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:12.5px;color:' + C.text + ';padding:3px 0;border-bottom:1px dashed ' + C.line + ';">' + left + '</td>' +
      '<td align="right" style="font-size:12.5px;color:' + C.dim + ';padding:3px 0;border-bottom:1px dashed ' + C.line + ';">' + right + '</td></tr></table>';
  }
  // 續課／收款提醒（放在「需要留意」的最前面）
  alertHtml += listBlock('🔔 包堂：快用完或已用完的學生', data.renewPackage.length ? data.renewPackage.map(function (x) {
    return plainRow(wrEsc(x.name), x.remaining <= 0 ? '已經沒有剩餘堂數' : '剩 ' + x.remaining + ' 堂');
  }).join('') : '<div style="font-size:12.5px;color:' + C.sage + ';">✓ 目前沒有。</div>');
  alertHtml += listBlock('💵 單次付費：下週有課，記得收款', data.renewSingle.length ? data.renewSingle.map(function (x) {
    return plainRow(wrEsc(x.name), wrShort(x.date) + '（' + wrWdLabel(x.date) + '）' + wrEsc(x.time) + (x.count > 1 ? '　共 ' + x.count + ' 堂' : ''));
  }).join('') : '<div style="font-size:12.5px;color:' + C.dim + ';">下週沒有單次付費學生的課。</div>');
  if (data.unfilled.length) {
    alertHtml += listBlock('🔍 排課跟已填收入對不上的日子', data.unfilled.map(function (u) {
      var hint = u.expected > u.filled ? '可能少填了' : '填的比排課多';
      return plainRow(wrShort(u.date) + '（' + wrWdLabel(u.date) + '）', 'TimeTree ' + u.expected + ' 堂　已填 ' + u.filled + ' 筆　' + hint);
    }).join(''));
  } else {
    alertHtml += listBlock('🔍 排課跟已填收入', '<div style="font-size:12.5px;color:' + C.sage + ';">✓ 本週每一天都對得上。</div>');
  }
  alertHtml += listBlock('💤 本週請假', data.leaves.length ? data.leaves.map(function (x) {
    return plainRow(wrEsc(x.title), wrShort(x.date) + '（' + wrWdLabel(x.date) + '）' + wrEsc(x.time));
  }).join('') : '<div style="font-size:12.5px;color:' + C.dim + ';">沒有</div>');
  alertHtml += listBlock('💰 本週「沒上課有付錢」', data.paid.length ? data.paid.map(function (x) {
    return plainRow(wrEsc(x.title), wrShort(x.date) + '（' + wrWdLabel(x.date) + '）' + wrEsc(x.time));
  }).join('') : '<div style="font-size:12.5px;color:' + C.dim + ';">沒有</div>');
  var b = data.backup;
  alertHtml += listBlock('💾 備份', '<div style="font-size:12.5px;color:' + (b.warn ? C.berry : C.sage) + ';">' +
    (b.never ? '還沒做過完整備份，建議到「⚙️ 設定」下載一份。' :
      (b.warn ? '上次完整備份是 ' + b.daysAgo + ' 天前（超過 ' + b.remindDays + ' 天），建議再備份一次。' : '✓ 上次完整備份是 ' + b.daysAgo + ' 天前。')) + '</div>');

  // 下週課表
  var nextHtml = data.nextDays.map(function (nd) {
    var names = nd.items.length ? nd.items.map(function (it) { return wrEsc(it.time) + ' ' + wrEsc(it.title); }).join('<br>') : '<span style="color:' + C.dim + ';">—</span>';
    return '<tr><td width="70" valign="top" style="font-size:12.5px;font-weight:700;color:' + C.text + ';padding:5px 0;border-bottom:1px dashed ' + C.line + ';">' + wrShort(nd.date) + '（' + wrWdLabel(nd.date) + '）</td>' +
      '<td valign="top" style="font-size:12.5px;color:' + C.text + ';padding:5px 0;border-bottom:1px dashed ' + C.line + ';">' + names + '</td>' +
      '<td width="50" align="right" valign="top" style="font-size:12px;color:' + C.dim + ';padding:5px 0;border-bottom:1px dashed ' + C.line + ';">' + nd.items.length + ' 堂</td></tr>';
  }).join('');
  var nextTable = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + nextHtml + '</table>';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>' +
    '<body style="margin:0;padding:0;background:' + C.bg + ';font-family:\'Noto Sans TC\',\'PingFang TC\',\'Microsoft JhengHei\',Arial,sans-serif;color:' + C.text + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.bg + ';"><tr><td align="center" style="padding:20px 10px;">' +
    '<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;"><tr><td>' +
    '<div style="font-size:22px;font-weight:800;color:' + C.text + ';">📊 華語教學日誌 週報</div>' +
    '<div style="font-size:12px;color:' + C.dim + ';margin:4px 0 14px;">' + wrEsc(data.weekStart) + ' ～ ' + wrEsc(data.weekEnd) + '（' + rangeText + '）・每週日晚上自動寄出</div>' +
    banner + cards +
    wrSection('近 12 個月收入（每日上課收入）', trendHtml) +
    wrSection('今年收入依學生占比（實收・換算台幣）', wrShareBlock(data.studentShare, '今年還沒有實收紀錄。')) +
    wrSection('今年收入依幣別占比（實收・換算台幣）', wrShareBlock(data.currencyShare, '今年還沒有實收紀錄。')) +
    wrSection('需要留意', alertHtml) +
    wrSection('下週課表預覽（' + wrShort(data.nextStart) + ' – ' + wrShort(data.nextEnd) + '）', nextTable) +
    '<div style="font-size:11px;color:' + C.dim + ';text-align:center;margin-top:8px;">資料來自華語教學日誌（雲端）與 TimeTree 課表。收入金額以台幣計。</div>' +
    '</td></tr></table></td></tr></table></body></html>';
}

// ---------- 以下才會用到 Apps Script 的功能：讀資料、寄信、排程 ----------
function wrFetchDoc(url, token) {
  var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() === 404) return {};
  if (res.getResponseCode() !== 200) throw new Error('讀取失敗：' + url + ' → ' + res.getContentText());
  var doc = JSON.parse(res.getContentText());
  var out = {};
  Object.keys(doc.fields || {}).forEach(function (k) { out[k] = fsValueToJs(doc.fields[k]); });
  return out;
}

function wrLoadInput() {
  var token = getAccessToken();
  var props = PropertiesService.getScriptProperties();
  var projectId = props.getProperty('FIREBASE_PROJECT_ID');
  var uid = props.getProperty('MONEYBOOK_UID');
  var root = 'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents/';
  var sch = wrFetchDoc(root + 'schedules/' + uid, token);
  var daily = wrFetchDoc(root + 'dailyIncome/' + uid, token);
  var actual = wrFetchDoc(root + 'actualRecords/' + uid, token);
  var tt = wrFetchDoc(root + 'users/' + uid + '/ttSync/state', token);
  var students = wrFetchDoc(root + 'studentRecords/' + uid, token);

  var marks = {};
  var pageToken = '';
  do {
    var url = root + 'users/' + uid + '/ttMarks?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    var json = JSON.parse(UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token } }).getContentText());
    (json.documents || []).forEach(function (d) {
      var obj = {};
      Object.keys(d.fields || {}).forEach(function (k) { obj[k] = fsValueToJs(d.fields[k]); });
      if (obj.key) marks[obj.key] = obj;
    });
    pageToken = json.nextPageToken || '';
  } while (pageToken);

  return { schedule: sch, daily: daily, actual: actual, students: students, tt: tt, marks: marks, nowMs: Date.now() };
}

function wrSend(subjectPrefix) {
  var todayISO = Utilities.formatDate(new Date(), WR_TZ, 'yyyy-MM-dd');
  var data = wrBuildReportData(wrLoadInput(), todayISO);
  var html = wrRenderHtml(data);
  var to = PropertiesService.getScriptProperties().getProperty('REPORT_EMAIL') || Session.getEffectiveUser().getEmail();
  var title = '華語教學日誌週報 ' + data.weekStart + '～' + data.weekEnd;
  var pdf = Utilities.newBlob(html, 'text/html', title + '.html').getAs('application/pdf').setName(title + '.pdf');
  MailApp.sendEmail({
    to: to,
    subject: (subjectPrefix || '') + '📊 ' + title,
    htmlBody: html,
    body: '請用支援 HTML 的信箱閱讀這封週報（PDF 版本在附件）。',
    attachments: [pdf]
  });
  Logger.log('週報已寄出：' + to);
}

// 每週日晚上 8 點自動執行的主程式
function sendWeeklyReport() { wrSend(''); }

// 馬上寄一封試用信（信件標題前面會加【試寄】）
function previewWeeklyReport() { wrSend('【試寄】'); }

// 設定「每週日 20:00（台灣時間）」自動寄出；重複執行不會產生多個排程
function installWeeklyReportTrigger() {
  removeWeeklyReportTrigger();
  ScriptApp.newTrigger('sendWeeklyReport').timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(20).nearMinute(0).inTimezone(WR_TZ).create();
  Logger.log('已設定：每週日 20:00（' + WR_TZ + '）寄出週報');
}

function removeWeeklyReportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendWeeklyReport') ScriptApp.deleteTrigger(t);
  });
}
