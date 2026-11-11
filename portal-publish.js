/* =====================================================================
   學生頁：把每位學生「自己那一份」資料複製到 portal/{老師uid}/students/{學生代號}

   - 只有日誌會寫這裡；學生頁（另一個網頁、另一個 repo）只讀自己的那份。
   - 不動日誌原本的任何資料。學生頁看得到的只有：姓名、付費方式、剩幾堂、已上幾堂、
     學生所在時區、前後幾個月的上課日期與台灣時間。看不到收入、匯款、備註、其他學生。
   - 誰能讀哪一份，由 Firestore 規則決定（見學生頁 repo 的 firestore.rules）。
   - 上課資料來自 TimeTree「課表」，沿用日誌的標題對應規則（stdResolveTitle）。
===================================================================== */

/* ───── 純函式（不碰網頁，tests/run.js 會單獨抄出來測） ───── */

/* 'YYYY-MM-DD' 加減天數（用 UTC 天數運算，不受瀏覽器時區影響） */
function portalIsoAdd(iso, n){
  var p = String(iso).split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/* 學生所在地（課表及學生設定裡選的 nat）→ 網路標準時區名稱，例如 America/Mexico_City；沒設定回傳空字串 */
function portalTzOf(name, studentInfo, tzList){
  var info = studentInfo && studentInfo[String(name || '').trim()];
  if(!info || !info.nat) return '';
  var e = (tzList || []).find(function(t){ return t && t.id === info.nat; });
  return (e && e.tz) || '';
}

/* 組出一位學生要給學生頁看的資料。
   a = { id, st（stdDb 裡這位學生）, tz, occ（TimeTree 期間內的課）,
         resolve（標題→學生）, countdown（剩幾堂）, taught（已上幾堂） } */
function portalBuildPayload(a){
  var st = a.st || {};
  var basic = st.basic || {};
  var name = String(basic.name || '').trim();
  if(st.isArchived) return { v: 1, name: name, archived: true };

  var cd = a.countdown(st);
  var pay = basic.payMode || '';
  if(!pay && cd != null) pay = 'package';      // 沒設定付費方式、但有預付倒數 → 當包堂（跟日誌一致）

  var lessons = [];
  (a.occ || []).forEach(function(o){
    var r = a.resolve(o.title);
    if(!r || r.id !== a.id) return;
    if(o.allDay){
      // 整天行程：標題剛好等於學生名字才算「沒上課有付錢」，其他整天行程不是課
      if(String(o.title || '').trim().toLowerCase() !== r.key) return;
      lessons.push({ d: o.date, s: '', e: '', x: 1 });
      return;
    }
    lessons.push({ d: o.date, s: o.startTime || '', e: o.endTime || o.startTime || '', x: (o.leave || o.paidAbsence) ? 1 : 0 });
  });
  lessons.sort(function(p, q){ return (p.d + p.s) < (q.d + q.s) ? -1 : (p.d + p.s) > (q.d + q.s) ? 1 : 0; });

  return {
    v: 1, name: name, archived: false,
    pay: pay,                                              // 'package' 包堂｜'single' 單次付費｜'' 未設定
    remaining: (pay === 'package' && cd != null) ? cd : null,
    taught: a.taught(st).count,
    tz: a.tz || '',
    lessons: lessons
  };
}


/* ───── 作業狀態（學生頁的作業 → 顯示在日誌「作業」欄；只讀，不寫回任何資料） ───── */

/* 毫秒 → 台灣日期 'YYYY-MM-DD'（不受瀏覽器時區影響） */
function portalTwIso(ms){
  var d = new Date(ms + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/* 一份作業要掛在哪一列課：上課日期「在發出日期當天或之前、最靠近發出日期」的那一堂（同一天有好幾堂，取比較後面的）。
   比第一堂還早 → 掛第一堂；所有列都沒有日期 → 最後一列；沒有任何列 → -1。
   rowDates：跟課列同順序的日期（'YYYY-MM-DD' 或 null/空字串） */
function portalHwRowIndex(assignedAt, rowDates){
  var list = rowDates || [];
  if(!list.length) return -1;
  var day = portalTwIso(assignedAt || 0), best = -1, bestDate = '', first = -1, firstDate = '';
  list.forEach(function(rd, i){
    if(!rd) return;
    if(rd <= day && (best < 0 || rd >= bestDate)){ best = i; bestDate = rd; }
    if(first < 0 || rd < firstDate){ first = i; firstDate = rd; }
  });
  if(best >= 0) return best;
  if(first >= 0) return first;
  return list.length - 1;
}

/* 一份作業的狀態文字與種類（cls：todo 未交｜submitted 已交待批改｜graded 已批改） */
function portalHwStatusText(d){
  if(!d) return { text: '', cls: '' };
  if(d.status === 'graded') return { text: '已批改' + (d.result && d.result.max != null ? ' ' + d.result.got + '/' + d.result.max : ''), cls: 'graded' };
  if(d.status === 'submitted') return { text: '已交，待批改', cls: 'submitted' };
  return { text: '未交', cls: 'todo' };
}

/* 把一位學生的所有作業，分到各列課：回傳 { 列編號: [作業, …] } */
function portalHwByRow(hwList, rowDates){
  var out = {};
  (hwList || []).slice().sort(function(a, b){ return (a.assignedAt || 0) - (b.assignedAt || 0); }).forEach(function(d){
    var i = portalHwRowIndex(d.assignedAt, rowDates);
    if(i < 0) return;
    (out[i] = out[i] || []).push(d);
  });
  return out;
}

/* ───── 跟網頁連接的部分 ───── */
(function(){
"use strict";

var PORTAL_URL = 'https://wangchiapin.github.io/diario-de-chino/';   // 學生頁網址（repo 名稱不同的話改這裡）
var PAST_DAYS = 120, FUTURE_DAYS = 90, POLL_MS = 60000;

var lastHash = {};            // 學生代號 → 上次寫出去的內容（沒變就不寫，省雲端額度）
var cleanedThisSession = false;
var busy = false;

function setStatus(text, ok){
  window.portalStatus = { text: text, ok: !!ok, at: Date.now() };
  var el = document.getElementById('portalStatus');
  if(el){ el.textContent = text; el.style.color = ok ? '' : '#a04b3f'; }
}

/* 資料都載入完才可以發佈，不然會把空的或舊的蓋上去 */
function notReadyReason(){
  if(!window.ledgerUid) return '還沒登入生活帳本帳號';
  if(typeof stdDb === 'undefined' || typeof stdCloudLoaded === 'undefined' || !stdCloudLoaded) return '學生上課狀況還沒載入完成';
  if(typeof window.ttGetStatus !== 'function') return 'TimeTree 功能還沒載入完成';
  var s = window.ttGetStatus();
  if(!s || !s.loaded) return 'TimeTree 課表還在讀取';
  if(!s.hasData) return '還沒有 TimeTree 課表資料（自動同步還沒成功跑過）';
  return '';
}

function buildAll(){
  var today = renewTodayISO();
  var occ = window.ttGetOccurrencesInRange(portalIsoAdd(today, -PAST_DAYS), portalIsoAdd(today, FUTURE_DAYS)) || [];
  var out = {};
  Object.keys(stdDb || {}).forEach(function(id){
    var st = stdDb[id];
    if(!st || !st.basic) return;
    var name = String(st.basic.name || '').trim();
    out[id] = portalBuildPayload({
      id: id, st: st,
      tz: portalTzOf(name, typeof studentInfo !== 'undefined' ? studentInfo : {}, typeof TZ_LIST !== 'undefined' ? TZ_LIST : []),
      occ: occ, resolve: stdResolveTitle, countdown: renewCountdownOf, taught: stdTaughtStats
    });
  });
  return out;
}

/* manual = true：按按鈕；false：背景每分鐘自動檢查（沒變就什麼都不做） */
async function publish(manual){
  if(busy) return;
  var why = notReadyReason();
  if(why){ if(manual) setStatus('現在還不能更新：' + why, false); return; }
  busy = true;
  try{
    var db = window.firebaseDb, uid = window.ledgerUid;
    var all = buildAll();
    var ids = Object.keys(all);
    var changed = ids.filter(function(id){ return lastHash[id] !== JSON.stringify(all[id]); });

    // 每次開網頁第一次：把學生頁上「日誌已經沒有的學生」清掉
    var stale = [];
    if(!cleanedThisSession){
      var snap = await window.firebaseGetDocs(window.firebaseCollection(db, 'portal', uid, 'students'));
      snap.forEach(function(d){ if(!all[d.id]) stale.push(d.id); });
    }
    if(!changed.length && !stale.length){
      cleanedThisSession = true;
      if(manual) setStatus('✓ 學生頁已經是最新（' + ids.length + ' 位學生，沒有需要更新的）', true);
      return;
    }
    // 一次最多 400 筆（Firestore 一批上限 500）
    var ops = changed.map(function(id){ return { set: id }; }).concat(stale.map(function(id){ return { del: id }; }));
    for(var i = 0; i < ops.length; i += 400){
      var b = window.firebaseWriteBatch(db);
      ops.slice(i, i + 400).forEach(function(op){
        if(op.set){
          var data = Object.assign({}, all[op.set], { updatedAt: Date.now() });
          b.set(window.firebaseDoc(db, 'portal', uid, 'students', op.set), data);
        }else{
          b.delete(window.firebaseDoc(db, 'portal', uid, 'students', op.del));
        }
      });
      await b.commit();
    }
    changed.forEach(function(id){ lastHash[id] = JSON.stringify(all[id]); });
    cleanedThisSession = true;
    var t = new Date();
    setStatus('✓ 學生頁已更新（' + changed.length + ' 位有變動，共 ' + ids.length + ' 位）　' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'), true);
  }catch(e){
    console.error('更新學生頁失敗', e);
    setStatus('⚠️ 更新學生頁失敗：' + (e && e.code === 'permission-denied' ? 'Firestore 規則還沒加（portal 那段）' : ((e && e.message) || e)), false);
  }finally{
    busy = false;
  }
}

window.portalPublishNow = function(){ return publish(true); };

window.portalCopyLink = async function(kind){
  if(!window.ledgerUid){ alert('請先登入生活帳本帳號'); return; }
  var url = PORTAL_URL + (kind === 'admin' ? 'admin.html' : '?t=' + window.ledgerUid);
  try{ await navigator.clipboard.writeText(url); setStatus('✓ 已複製：' + url, true); }
  catch(e){ window.prompt('複製這個網址：', url); }
};

/* ───── 讀學生頁的作業狀態（只讀） ───── */
var hwLoading = false, hwLoadedAt = 0, hwHash = '';
window.portalHw = {};       // 學生代號 → [{ wid, title, assignedAt, status, result }]
window.portalHwLoadedAt = 0;

async function hwLoad(manual){
  if(hwLoading) return;
  if(!window.ledgerUid || typeof stdDb === 'undefined' || typeof stdCloudLoaded === 'undefined' || !stdCloudLoaded) return;
  hwLoading = true;
  var msg = document.getElementById('portalHwStatus');
  try{
    var db = window.firebaseDb, uid = window.ledgerUid, ids = Object.keys(stdDb || {}).filter(function(id){ var s = stdDb[id]; return s && s.basic && !s.isArchived; });
    var next = {};
    await Promise.all(ids.map(async function(id){
      var snap = await window.firebaseGetDocs(window.firebaseCollection(db, 'portal', uid, 'students', id, 'hw'));
      var arr = [];
      snap.forEach(function(d){ var v = d.data() || {}; arr.push({ wid: d.id, title: v.title || '', assignedAt: v.assignedAt || 0, status: v.status || 'todo', result: v.result || null }); });
      if(arr.length) next[id] = arr;
    }));
    var h = JSON.stringify(next);
    window.portalHw = next; hwLoadedAt = Date.now(); window.portalHwLoadedAt = hwLoadedAt;
    if(h !== hwHash){
      hwHash = h;
      try{ if(typeof stdRenderClasses === 'function' && stdCurrentId) stdRenderClasses(); }catch(e){ console.error(e); }
      try{ if(typeof stdMissingRefresh === 'function') stdMissingRefresh(); }catch(e){ console.error(e); }
    }
    if(msg){ var t = new Date(); msg.textContent = '✓ 作業狀態已更新　' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); msg.style.color = ''; }
  }catch(e){
    console.error('讀取作業狀態失敗', e);
    if(msg){ msg.textContent = '⚠️ 讀不到作業狀態：' + (e && e.code === 'permission-denied' ? 'Firestore 規則還沒加（portal 那段）' : ((e && e.message) || e)); msg.style.color = '#a04b3f'; }
  }finally{ hwLoading = false; }
}
window.portalHwRefresh = function(){ return hwLoad(true); };

/* 某位學生各列課的作業狀態（列編號 → 作業清單）。rowDates 沒給就自己算 */
window.portalHwMap = function(id, rowDates){
  var list = (window.portalHw || {})[id];
  if(!list || !list.length) return {};
  if(!rowDates){ try{ rowDates = stdClassDates((stdDb[id] && stdDb[id].classes) || []); }catch(e){ return {}; } }
  return portalHwByRow(list, rowDates);
};
/* 這位學生最新一列課，有沒有發過作業（備課提醒用） */
window.portalHwOnLastRow = function(id){
  try{
    var classes = (stdDb[id] && stdDb[id].classes) || [];
    if(!classes.length) return false;
    var m = window.portalHwMap(id);
    return !!(m[classes.length - 1] && m[classes.length - 1].length);
  }catch(e){ return false; }
};
window.portalHwBlockHtml = function(list){
  if(!list || !list.length) return '';
  var esc = typeof escapeHtml === 'function' ? escapeHtml : function(x){ return String(x); };
  return '<div class="hw-st" title="這是學生頁的作業狀態（只能看，不能改）">' + list.map(function(d){
    var st = portalHwStatusText(d);
    return '<div class="hw-it ' + st.cls + '">📝 ' + esc(d.title || '作業') + '：' + esc(st.text) + '</div>';
  }).join('') + '</div>';
};
window.portalHwChipHtml = function(list){
  if(!list || !list.length) return '';
  var cls = list.some(function(d){ return d.status === 'submitted'; }) ? 'submitted' : list.some(function(d){ return d.status !== 'graded'; }) ? 'todo' : 'graded';
  var txt = cls === 'submitted' ? '待批改' : cls === 'todo' ? '作業未交' : '作業已批改';
  return '<span class="std-card-chip hw-chip ' + cls + '">📝 ' + txt + '</span>';
};

// 背景自動更新：每分鐘看一次，內容有變才寫（日誌存檔、TimeTree 同步、請假標記…之後最慢約 1 分鐘會反映到學生頁）
setInterval(function(){ if(document.visibilityState === 'visible') publish(false); }, POLL_MS);
setTimeout(function(){ publish(false); }, 15000);   // 開網頁 15 秒後先跑一次
// 作業狀態：開網頁後 20 秒讀一次，之後每 3 分鐘、或回到這個分頁（距離上次超過 1 分鐘）時再讀
setTimeout(function(){ hwLoad(false); }, 20000);
setInterval(function(){ if(document.visibilityState === 'visible') hwLoad(false); }, 180000);
document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'visible' && Date.now() - hwLoadedAt > 60000) hwLoad(false); });
})();
