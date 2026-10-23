// ==UserScript==
// @name         StepFun 用量和费用增强
// @namespace    dsh.local/stepfun-usage-plus
// @version      1.4.2
// @description  阶跃星辰「用量和费用」页就地接管：使用详情由脚本自己渲染（默认当前计费周期、汇总/明细切换、合计行、总Token 整数+小字 M/B、Credit 带 Credits 单位、缓存利用率），日期切换由脚本直接重取接口不再模拟点日历；Credit 账户卡内加「套餐用量/今日用量」四列汇总块与到期时间、与账户金额并排（版式按参考图 1:1）。
// @match        https://platform.stepfun.com/account-overview*
// @homepageURL  https://github.com/yuloop/stepfun-usage-plus
// @supportURL   https://github.com/yuloop/stepfun-usage-plus/issues
// @updateURL    https://raw.githubusercontent.com/yuloop/stepfun-usage-plus/main/stepfun-usage-plus.user.js
// @downloadURL  https://raw.githubusercontent.com/yuloop/stepfun-usage-plus/main/stepfun-usage-plus.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  var API = 'https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/';
  var TTL = 5 * 60 * 1000, GREY = '#86909c';
  var INCL_CACHE = true;  // 总Token=输入+输出+缓存读、缓存利用率=缓存÷(输入+缓存)；false=站点口径
  var st = { plan: null, credit: null, agg: null, rec: {}, at: 0, busy: false, range: 'cycle', mode: 'sum', custom: null };

  function q(s, r) { return (r || document).querySelector(s); }
  function qa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function byPrefix(n, r) { return q('[class*="' + n + '"]', r); }
  function esc(v) { return String(v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmtM(n) { return (num(n) / 1e6).toFixed(2) + 'M'; }
  function fmtMB(n) { var v = num(n); return v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : (v / 1e6).toFixed(2) + 'M'; }
  function fmtInt(n) { return num(n).toLocaleString('en-US'); }
  function fmtRate(r) { return r === null || r === undefined ? '—' : (r * 100).toFixed(2) + '%'; }
  function pad(x) { return (x < 10 ? '0' : '') + x; }
  function mdOf(s) { if (!num(s)) return '--'; var d = new Date(num(s) * 1000); return (d.getMonth() + 1) + '/' + d.getDate(); }
  function ymdOf(s) { if (!num(s)) return '--'; var d = new Date(num(s) * 1000); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function ymdhmsOf(s) { if (!num(s)) return '--'; var d = new Date(num(s) * 1000); return ymdOf(s) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function slotMin(v) { var n = num(v); var d = new Date(n > 1e12 ? n : n * 1000); return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':00'; }

  function apiHeaders() {
    var h = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'Oasis-Platform': 'web', 'Oasis-appID': '10300' };
    try {
      var w = localStorage.getItem('web_id');
      if (w) { try { w = JSON.parse(w); } catch (e) { /* 带引号 JSON 串 */ } h['Oasis-Webid'] = String(w); }
    } catch (e) { /* 无 localStorage 照常 */ }
    return h;
  }
  function post(name, body) {
    var opt = { method: 'POST', credentials: 'include', headers: apiHeaders(), body: JSON.stringify(body || {}) };
    return fetch(API + name, opt).then(function (r) {
      return r.text().then(function (t) { if (!r.ok) throw new Error(name + ' HTTP ' + r.status + ' ' + t.slice(0, 160)); return JSON.parse(t); });
    });
  }
  function fetchUsage(a, b) {
    if (!(b > a)) return Promise.resolve([]);
    var all = [], page = 1;
    function next() {
      if (page > 40) return Promise.resolve(all);
      return post('QueryStepPlanUsages', { startTime: String(a), toTime: String(b), page: page, pageSize: 200, granularHour: 1 }).then(function (res) {
        var recs = (res && (res.records || res.data)) || [], total = Number(res && res.total) || 0;
        all = all.concat(recs);
        if (recs.length < 200 || (total && all.length >= total)) return all;
        page += 1;
        return next();
      });
    }
    return next();
  }

  function aggregate(recs) {
    var a = { tin: 0, tout: 0, cache: 0, calls: 0, credit: 0, hours: 0 }, seen = {};
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i] || {}, slot = r.from_time !== undefined ? r.from_time : r.fromTime;
      if (slot !== undefined && slot !== null && slot !== '') seen[String(slot)] = 1;
      a.tin += num(r.in_amount); a.tout += num(r.out_amount); a.cache += num(r.cache_amount);
      a.calls += num(r.calls); a.credit += num(r.credit_consumed);
    }
    a.hours = Object.keys(seen).length;
    a.total = a.tin + a.tout + (INCL_CACHE ? a.cache : 0);
    var base = INCL_CACHE ? a.tin + a.cache : a.tin;
    a.rate = base > 0 ? a.cache / base : null;
    return a;
  }
  // 计费周期 = 页面「重置时间」往前一个自然月
  function cycleWindow() {
    var sub = (st.plan && st.plan.subscription) || {};
    var rl = st.credit && st.credit.plan_credit_rate_limit, bk = rl && rl.credit_buckets && rl.credit_buckets[0];
    var reset = num(bk && bk.next_reset_at) || num(rl && rl.subscription_credit_reset_time), name = sub.name || 'Pro';
    if (!reset) return sub.activated_at ? { start: num(sub.activated_at) * 1000, end: Date.now(), name: name } : null;
    var end = reset * 1000, d = new Date(end);
    var start = new Date(d.getFullYear(), d.getMonth() - 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()).getTime();
    return { start: start, end: end, name: name };
  }
  function todayWindow() { var n = new Date(); return { start: new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(), end: Date.now() }; }
  function rangeOf(kind) {
    if (kind === 'today') return todayWindow();
    if (kind === '7d') return { start: Date.now() - 7 * 86400e3, end: Date.now() };
    if (kind === 'custom') return st.custom;
    return cycleWindow();
  }
  function loadRec(kind) {
    var w = rangeOf(kind);
    if (!w) return Promise.resolve([]);
    if (kind === 'custom') delete st.rec.custom;
    return fetchUsage(w.start, Math.min(w.end, Date.now())).catch(function () { return []; });
  }
  function loadData(force) {
    if (st.busy) return Promise.resolve();
    if (!force && st.agg && Date.now() - st.at < TTL) return Promise.resolve();
    st.busy = true;
    return Promise.all([post('GetStepPlanStatus', {}).catch(function () { return null; }), post('QueryStepPlanRateLimit', {}).catch(function () { return null; })])
      .then(function (meta) {
        st.plan = meta[0]; st.credit = meta[1];
        var kinds = { cycle: 1, today: 1 };
        kinds[st.range] = 1;
        var keys = Object.keys(kinds);
        return Promise.all(keys.map(function (k) { return loadRec(k).then(function (r) { st.rec[k] = r; }); })).then(function () { return keys; });
      }).then(function (keys) {
        var cy = st.rec.cycle || [], td = st.rec.today || [];
        st.agg = { plan: aggregate(cy), today: aggregate(td) };
        st.at = Date.now(); st.busy = false;
        renderBlock(); renderTable();
      }).catch(function (e) { st.busy = false; console.warn('[SFX] 取数失败：', e && e.message); });
  }

  /* ---------- Credit 账户里的汇总块（版式按参考图） ---------- */
  var CSS = '.sfx-extra{margin:15px 12px 0;background:#f7f8fa;border-radius:7px;padding:14px 12px 12px;container-type:inline-size}'
    + '.sfx-groups{display:flex}.sfx-group{flex:1 1 0;min-width:0}.sfx-gbody{display:flex;margin-top:16px}.sfx-cell{flex:1 1 0;min-width:0}'
    + '.sfx-group+.sfx-group{border-left:1px solid #e1e2e6;padding-left:13px}'
    + '.sfx-ghead{display:flex;justify-content:space-between;font-size:13px;line-height:14px;font-weight:600;color:#1d2129}.sfx-gnote{font-weight:400;color:#86909c;white-space:nowrap}'
    + '.sfx-cell.sfx-rate{border-left:1px solid #e1e2e6;padding-left:15px}'
    + '.sfx-big{font-size:18px;line-height:14px;height:14px;font-weight:600;color:#1d2129;white-space:nowrap}'
    + '.sfx-big .sfx-unit{font-size:10px;line-height:14px;font-weight:400;margin-left:2px}.sfx-sub{margin-top:9px;font-size:10px;line-height:10px;color:#86909c}'
    + '.sfx-bar{margin-top:11px;height:10px;border-radius:5px;background:#e5e6eb;overflow:hidden}.sfx-bar>i{display:block;height:100%;background:#56af45;border-radius:5px}'
    + '.sfx-foot{margin-top:25px;font-size:10px;line-height:10px;color:#86909c}'
    + '@container (max-width:760px){.sfx-groups{flex-wrap:wrap}.sfx-group{flex:1 1 100%}.sfx-group+.sfx-group{border-left:0;padding-left:0;margin-top:10px;padding-top:10px;border-top:1px solid #e1e2e6}'
    + '.sfx-ghead{flex-wrap:wrap}.sfx-gbody{flex-wrap:wrap;margin-top:8px}.sfx-cell{flex:1 1 100%}.sfx-cell.sfx-rate{border-left:0;padding-left:0;margin-top:9px}'
    + '.sfx-big{font-size:16px;line-height:16px;height:16px;white-space:normal}}'
    // 自建表格
    + '.sfx-tbl{margin-top:12px}.sfx-tool{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}'
    + '.sfx-tool .sfx-tag{font-size:13px;color:#86909c;margin-left:4px}'
    + '.sfx-scroll{max-height:620px;overflow:auto;border:1px solid #e5e6eb;border-radius:6px}'
    + '.sfx-table{width:100%;border-collapse:collapse;font-size:14px;color:#1d2129}'
    + '.sfx-table th{position:sticky;top:0;background:#f2f3f5;height:40px;font-weight:400;color:#4e5969;white-space:nowrap;padding:0 14px;text-align:center;z-index:2}'
    + '.sfx-table td{height:40px;padding:0 14px;border-top:1px solid #e5e6eb;white-space:nowrap;text-align:center}'
    + '.sfx-table tr:nth-child(even) td{background:#f7f8fa}'
    + '.sfx-table td.sfx-l,.sfx-table th.sfx-l{text-align:left}'
    + '.sfx-table tr.sfx-sum td{background:#eef3ff;font-weight:600}'
    + '.sfx-u{color:#86909c;font-size:.86em;margin-left:3px}'
    + '.sfx-date{height:32px;border:1px solid #e5e6eb;border-radius:4px;padding:0 8px;font-size:13px;color:#1d2129;background:#fff}';
  function injectStyles() {
    var s = document.getElementById('sfx-style');
    if (s && s.dataset.sfxCss === CSS) return;
    if (!s) { s = document.createElement('style'); s.id = 'sfx-style'; document.head.appendChild(s); }
    s.textContent = CSS; s.dataset.sfxCss = CSS;
  }
  function cellHtml(big, label) { return '<div class="sfx-cell"><div class="sfx-big">' + esc(big) + '<span class="sfx-unit">Tokens</span></div><div class="sfx-sub">' + esc(label) + '</div></div>'; }
  function rateHtml(rate) {
    var w = rate === null || rate === undefined ? 0 : Math.max(0, Math.min(100, rate * 100));
    return '<div class="sfx-cell sfx-rate"><div class="sfx-big">' + fmtRate(rate) + '</div><div class="sfx-sub">缓存利用率</div>'
      + '<div class="sfx-bar"><i style="width:' + w.toFixed(2) + '%"></i></div></div>';
  }
  function groupHtml(title, note, agg) {
    return '<div class="sfx-group"><div class="sfx-ghead"><span>' + esc(title) + '</span><span class="sfx-gnote">' + esc(note) + '</span></div>'
      + '<div class="sfx-gbody">' + cellHtml(agg ? fmtMB(agg.total) : '—', '总Token消耗') + rateHtml(agg ? agg.rate : null) + '</div></div>';
  }
  function renderBlock() {
    var clone = document.getElementById('sfx-credit-clone');
    if (!clone || clone.style.display === 'none') return;
    var card = q('[class*="planUsageCard"]', clone);
    if (!card) return;
    injectStyles();
    var a = st.agg || {}, pw = cycleWindow(), now = new Date(), p = a.plan, t = a.today;
    var sig = [p && p.total, p && p.calls, p && p.hours, t && t.total, t && t.calls, st.at].join('|');
    var box = document.getElementById('sfx-credit-extra');
    if (!box) { box = document.createElement('div'); box.id = 'sfx-credit-extra'; box.className = 'sfx-extra'; card.appendChild(box); }
    if (box.dataset.sfxSig !== sig) {
      var planTitle = pw ? '套餐用量 · ' + mdOf(pw.start / 1000) + ' - ' + mdOf(pw.end / 1000) + ' (' + pw.name + ')' : '套餐用量';
      box.innerHTML = '<div class="sfx-groups">' + groupHtml(planTitle, (p ? p.hours : 0) + ' 个时段', p)
        + groupHtml('今日用量 · ' + (now.getMonth() + 1) + '/' + now.getDate(), fmtInt(t ? t.calls : 0) + ' 次调用', t)
        + '</div><div class="sfx-foot">套餐区间 ' + fmtInt(p ? p.calls : 0) + ' 次调用 · Credit 消耗 ' + (p ? fmtM(p.credit) : '—') + ' Credits</div>';
      box.dataset.sfxSig = sig;
    }
    var stale = document.getElementById('sfx-expire');
    if (stale) stale.remove();
    var reset = byPrefix('cardReset', card), ex = document.getElementById('sfx-expire-inline');
    if (reset && st.plan && st.plan.subscription) {
      if (!ex) { ex = document.createElement('span'); ex.id = 'sfx-expire-inline'; ex.className = 'sfx-expire-inline'; reset.appendChild(ex); }
      var txt = ' · 套餐于 ' + ymdhmsOf(num(st.plan.subscription.expired_at)) + ' 到期';
      if (ex.textContent !== txt) ex.textContent = txt;
    }
  }

  /* ---------- 顶部并排（克隆原生卡，不动 React 节点） ---------- */
  function nativePlanCard(box) {
    var cs = qa('[class*="planUsageCard"]', box);
    for (var i = 0; i < cs.length; i++) if (!cs[i].closest('#sfx-credit-clone')) return cs[i];
    return null;
  }
  function findCards() {
    var amount = null, plan = null;
    qa('[class*="paramsBox"]').forEach(function (b) {
      if (b.closest('#sfx-credit-clone')) return;
      if (!amount && q('[class*="accountAmountCard"]', b)) amount = b;
      if (!plan && nativePlanCard(b)) plan = b;
    });
    return { amount: amount, plan: plan };
  }
  function applyLayout() {
    var f = findCards(), clone = document.getElementById('sfx-credit-clone');
    if (!f.amount || !f.plan) { if (clone) clone.style.display = 'none'; return; }
    var native = nativePlanCard(f.plan);
    if (!native) { if (clone) clone.style.display = 'none'; return; }
    injectStyles();
    if (f.plan !== f.amount && f.plan.style.display !== 'none') f.plan.style.display = 'none';
    var host = f.amount, amountCard = q('[class*="accountAmountCard"]', host) || host;
    var sig = (native.textContent || '').replace(/\s+/g, ' ').trim() + '|' + native.querySelectorAll('*').length;
    if (!clone) { clone = document.createElement('div'); clone.id = 'sfx-credit-clone'; host.insertBefore(clone, host.firstChild); }
    clone.style.display = '';
    if (clone.dataset.sfxSig !== sig) {
      clone.innerHTML = ''; clone.appendChild(native.cloneNode(true)); clone.dataset.sfxSig = sig;
      var box = document.getElementById('sfx-credit-extra');
      if (box) box.removeAttribute('data-sfx-sig');
    }
    host.style.display = 'flex'; host.style.gap = '33px'; host.style.alignItems = 'flex-start';
    clone.style.flex = '1 1 65.7%'; clone.style.minWidth = '0';
    amountCard.style.flex = '1 1 32.9%'; amountCard.style.minWidth = '0';
  }

  /* ---------- 自建「使用详情」表：脚本管列、默认当期、汇总/明细、合计行 ---------- */
  function tabKind() {
    var lb = qa('[class*="sourceTabs"] label').filter(function (l) { return q('input', l) && q('input', l).checked; })[0];
    return lb && /API/.test(lb.innerText) ? 'api' : 'plan';
  }
  function btnClass(scope) {
    var proto = null;
    qa('button', scope).forEach(function (b) { if (!proto && /重置|查看汇总|查看明细/.test(b.innerText)) proto = b; });
    return proto ? proto.className : 'arco-btn arco-btn-secondary arco-btn-size-default';
  }
  function rowsOf(kind, mode) {
    var recs = st.rec[kind] || [], out = [], byModel = {};
    if (mode === 'sum') {
      recs.forEach(function (r) {
        var k = r.model_id || '?', g = byModel[k];
        if (!g) { g = byModel[k] = { model: k, tin: 0, tout: 0, cache: 0, calls: 0, credit: 0 }; out.push(g); }
        g.tin += num(r.in_amount); g.tout += num(r.out_amount); g.cache += num(r.cache_amount); g.calls += num(r.calls); g.credit += num(r.credit_consumed);
      });
      out.sort(function (a, b) { var ta = a.tin + a.cache, tb = b.tin + b.cache; return tb - ta; });
      return out;
    }
    recs.forEach(function (r) {
      out.push({ model: r.model_id || '?', slot: num(r.from_time !== undefined ? r.from_time : r.fromTime), tin: num(r.in_amount), tout: num(r.out_amount), cache: num(r.cache_amount), calls: num(r.calls), credit: num(r.credit_consumed) });
    });
    out.sort(function (a, b) { return b.slot - a.slot; });
    return out;
  }
  function fmtRow(r, span) {
    var base = INCL_CACHE ? r.tin + r.cache : r.tin, total = r.tin + r.tout + (INCL_CACHE ? r.cache : 0);
    return '<tr><td class="sfx-l">' + (r.slot ? slotMin(r.slot) : esc(span)) + '</td><td class="sfx-l">' + esc(r.model) + '</td>'
      + '<td>' + fmtInt(r.calls) + '</td><td>' + fmtInt(r.tin) + '</td><td>' + fmtInt(r.tout) + '</td><td>' + fmtInt(r.cache) + '</td>'
      + '<td>' + fmtInt(total) + '<span class="sfx-u">' + fmtMB(total) + '</span></td>'
      + '<td>' + fmtM(r.credit) + '<span class="sfx-u">Credits</span></td>'
      + '<td>' + fmtRate(base > 0 ? r.cache / base : null) + '</td></tr>';
  }
  function tableHtml(rows, agg, span, mode) {
    var head = '<thead><tr><th class="sfx-l">调用时间</th><th class="sfx-l">模型</th><th>调用次数</th><th>输入Token数</th><th>输出Token数</th><th>缓存Token数</th>'
      + '<th title="' + (INCL_CACHE ? '总Token数 = 输入 + 输出 + 缓存读' : '总Token数 = 输入 + 输出') + '">总Token数</th>'
      + '<th>Credit用量</th><th title="' + (INCL_CACHE ? '缓存利用率 = 缓存 ÷ (输入 + 缓存)' : '缓存利用率 = 缓存 ÷ 输入') + '">缓存利用率</th></tr></thead>';
    var body = rows.map(function (r) { return fmtRow(r, span); }).join('');
    var sumRow = '<tr class="sfx-sum"><td class="sfx-l">合计</td><td class="sfx-l">' + (mode === 'sum' ? rows.length + ' 个模型' : '共 ' + rows.length + ' 条') + '</td><td>' + fmtInt(agg.calls) + '</td><td>' + fmtInt(agg.tin) + '</td>'
      + '<td>' + fmtInt(agg.tout) + '</td><td>' + fmtInt(agg.cache) + '</td><td>' + fmtInt(agg.total) + '<span class="sfx-u">' + fmtMB(agg.total) + '</span></td>'
      + '<td>' + fmtM(agg.credit) + '<span class="sfx-u">Credits</span></td><td>' + fmtRate(agg.rate) + '</td></tr>';
    return '<div class="sfx-scroll"><table class="sfx-table">' + head + '<tbody>' + sumRow + body + '</tbody></table></div>';
  }
  // 等空闲再重取：连续改动（先改开始日、再改结束日）不会被 st.busy 守卫吞掉
  function reload(kind) {
    if (kind && kind !== 'sum' && kind !== 'detail') { st.range = kind; delete st.rec[kind]; }
    var go = function () { if (st.busy) return setTimeout(go, 300); loadData(true).then(renderTable); };
    go();
  }
  function ensureHost() {
    var sec = byPrefix('usageDetailSection');
    if (!sec) return null;
    var native = q('[class*="expandableTable"]', sec);
    var wrapNative = native ? native.closest('.w-full') || native : null;
    var timesel = byPrefix('timeselect', sec);
    var host = document.getElementById('sfx-tbl');
    if (!host) {
      host = document.createElement('div');
      host.id = 'sfx-tbl'; host.className = 'sfx-tbl';
      if (wrapNative && wrapNative.parentNode) wrapNative.parentNode.insertBefore(host, wrapNative);
      else sec.appendChild(host);
      host.addEventListener('change', function (ev) {
        var d = ev.target.closest('[data-sfx-d]');
        if (!d) return;
        var i1 = q('[data-sfx-d="1"]', host), i2 = q('[data-sfx-d="2"]', host);
        if (!i1 || !i2 || !i1.value || !i2.value) return;
        var a = new Date(i1.value + 'T00:00:00').getTime(), b = new Date(i2.value + 'T23:59:59').getTime();
        if (!(b > a)) return;
        st.custom = { start: a, end: b }; st.range = 'custom';
        reload('custom');
      });
      host.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-sfx-k]');
        if (!b) return;
        var kind = b.getAttribute('data-sfx-k');
        if (kind === 'sum' || kind === 'detail') st.mode = kind;
        if (kind === 'sum' || kind === 'detail') { st.mode = kind; renderTable(); return; }
        st.custom = null;
        if (st.rec[kind]) { st.range = kind; host.dataset.sfxSig = ''; renderTable(); } else reload(kind);
      });
    }
    var isPlan = tabKind() === 'plan';
    if (wrapNative) wrapNative.style.display = isPlan ? 'none' : '';
    if (timesel) timesel.style.display = isPlan ? 'none' : '';
    host.style.display = isPlan ? '' : 'none';
    return isPlan ? host : null;
  }
  function renderTable() {
    var host = ensureHost();
    if (!host) return;
    var rows = rowsOf(st.range, st.mode), agg = aggregate(st.rec[st.range] || []);
    var cls = btnClass(host.parentNode || document), w = rangeOf(st.range) || { start: 0, end: 0 };
    var sig = [st.range, st.mode, rows.length, st.at, st.custom && st.custom.start, st.custom && st.custom.end].join('|');
    if (host.dataset.sfxSig === sig) return;
    host.dataset.sfxSig = sig;
    var d1 = ymdOf((st.custom ? st.custom.start : w.start) / 1000), d2 = ymdOf((st.custom ? st.custom.end : Math.min(w.end, Date.now())) / 1000);
    var mk = function (k, label, on) {
      return '<button type="button" class="' + cls + '" data-sfx-k="' + k + '" style="' + (on ? 'background:#e8f0ff;color:#1668ff' : '') + '">' + label + '</button>';
    };
    var span = (!w.start ? '—' : ymdOf(w.start / 1000) + ' ~ ' + ymdOf(Math.min(w.end, Date.now()) / 1000));
    host.innerHTML = '<div class="sfx-tool">'
      + mk('cycle', '本期', st.range === 'cycle') + mk('today', '今日', st.range === 'today') + mk('7d', '近7天', st.range === '7d')
      + '<input type="date" class="sfx-date" data-sfx-d="1" value="' + d1 + '"><span class="sfx-tag">~</span>'
      + '<input type="date" class="sfx-date" data-sfx-d="2" value="' + d2 + '">'
      + '<span class="sfx-tag">' + span + ' · ' + rows.length + ' 行</span><span style="flex:1"></span>'
      + mk('sum', '汇总', st.mode === 'sum') + mk('detail', '明细', st.mode === 'detail')
      + '</div>' + tableHtml(rows, agg, span, st.mode);
  }

  function tick() {
    try {
      if (!q('[class*="demandRegisterPage"]')) return;
      applyLayout(); renderBlock(); renderTable(); loadData(false);
    } catch (e) { console.warn('[SFX] 注入异常：', e && e.message); }
  }
  tick();
  var timer = null;
  new MutationObserver(function () {
    if (timer) return;
    timer = setTimeout(function () { timer = null; tick(); }, 800);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(function () { loadData(true); }, TTL);
})();
