/* 智卡运价评估系统 - 评估引擎与界面逻辑（原生 JS，无依赖，可直接 file:// 打开） */
(function () {
  'use strict';

  var STORAGE_KEY = 'lre_state_v1';
  var STATE = loadState();
  var formReady = false;   // 评估表单构建完成后置 true，供切换 Tab 时安全刷新结果

  // 把「用户存档(可能缺字段/老格式)」与 DEFAULTS 深合并，保证 STATE 始终结构完整、可直接渲染。
  // 规则：对象逐级合并（保留用户已填子字段，补齐缺失子字段）；数组与标量以「用户有则用用户，否则用默认」。
  function deepMerge(base, def) {
    var out = {};
    Object.keys(def).forEach(function (k) {
      var dv = def[k];
      var hasBase = base && typeof base === 'object' && base[k] != null;
      var bv = hasBase ? base[k] : undefined;
      if (dv && typeof dv === 'object' && !Array.isArray(dv)) {
        out[k] = deepMerge(bv, dv);
      } else {
        out[k] = (bv !== undefined) ? bv : dv;
      }
    });
    // 保留 DEFAULTS 没有、但用户存档自带的多余字段（如 logs/calibration/calibrations）
    if (base && typeof base === 'object') {
      Object.keys(base).forEach(function (k) { if (!(k in out)) out[k] = base[k]; });
    }
    return out;
  }
  // 归一化任意来源的对象为「可用 STATE」：深合并默认基线 + 补齐必填结构 + 跑迁移。
  // 输入非法（非对象）或缺少关键字段时抛错，由调用方捕获，绝不返回半截结构。
  function normalizeState(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('不是有效的配置对象');
    }
    var def = JSON.parse(JSON.stringify(window.DEFAULTS));
    var out = deepMerge(input, def);
    if (!Array.isArray(out.vehicles) || !out.vehicles.length) out.vehicles = def.vehicles;
    if (!Array.isArray(out.logs)) out.logs = [];
    if (!Array.isArray(out.returnCargos)) out.returnCargos = def.returnCargos;
    if (!out.calibrations || typeof out.calibrations !== 'object') out.calibrations = {};
    if (out.calibration == null || !isFinite(out.calibration)) out.calibration = 1;
    if (!out.energy || typeof out.energy !== 'object') out.energy = def.energy;
    if (!out.config || typeof out.config !== 'object') out.config = def.config;
    if (!out.season || !Array.isArray(out.season.monthly)) out.season = def.season;
    if (!out.tollClasses || typeof out.tollClasses !== 'object') out.tollClasses = def.tollClasses;
    migrateHydrogen(out);
    migrateVehicles(out);
    return out;
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalizeState(JSON.parse(raw));
    } catch (e) {}
    var d = JSON.parse(JSON.stringify(window.DEFAULTS));
    d.logs = []; d.calibration = 1; d.calibrations = {};
    return d; // 保留 DEFAULTS 中的 returnCargos 种子货池
  }
  // 给已存车型补齐「氢电」能源选项与氢耗（按 DEFAULTS 同车型取值）
  function migrateHydrogen(s) {
    if (!Array.isArray(s.vehicles)) return;
    var def = (window.DEFAULTS && window.DEFAULTS.vehicles) || [];
    s.vehicles.forEach(function (v) {
      var dv = def.filter(function (x) { return x.id === v.id; })[0];
      if (!dv) return;
      if (!Array.isArray(v.energy)) v.energy = dv.energy.slice();
      if (v.energy.indexOf('氢电') < 0) v.energy.push('氢电');
      if (v.hydrogen == null) v.hydrogen = dv.hydrogen;
      if (v.elec == null && dv.elec != null) v.elec = dv.elec; // 补全纯电/氢电所需电耗
    });
    if (s.energy && s.energy.hydrogenPrice == null) s.energy.hydrogenPrice = (window.DEFAULTS.energy || {}).hydrogenPrice;
  }
  // 把 DEFAULTS 中新增的车型（如 7.6m）补进已存 STATE，不覆盖用户自定义；
  // 这样老用户刷新后也能用上新车型，无需「恢复默认」丢失数据。
  function migrateVehicles(s) {
    var def = (window.DEFAULTS && window.DEFAULTS.vehicles) || [];
    if (!Array.isArray(s.vehicles)) s.vehicles = def.slice();
    var ids = s.vehicles.map(function (v) { return v.id; });
    def.forEach(function (dv) {
      if (ids.indexOf(dv.id) < 0) s.vehicles.push(JSON.parse(JSON.stringify(dv)));
    });
    // 运价评估不再单列司机餐补，清理老存档残留的 meals 字段；
    // 并为老存档补齐新字段（载重/容积/月固定），缺失时回退 DEFAULTS 同车型取值，不覆盖用户已填值。
    s.vehicles.forEach(function (v) {
      delete v.meals;
      var dv = def.filter(function (x) { return x.id === v.id; })[0];
      if (!dv) return;
      ['capacity', 'volume', 'monthlyFixed'].forEach(function (k) {
        if (v[k] == null) v[k] = dv[k];
      });
    });
  }
  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE)); } catch (e) {}
  }

  // ---------- 评估引擎 ----------
  // 细分校准键：车型·能源·模式（同维度下的成交误差通常更接近）
  function calibKey(f) {
    return (f.vehicleId || '?') + '|' + (f.energy || '?') + '|' + (f.mode || '?');
  }
  // 评估引擎委托给 model.js（纯函数、可在 Node 单测）。STATE 为本文件闭包变量。
  function evaluate(f) {
    return window.LRE.evaluate(STATE, f);
  }
  // 「重新测算/评估」按钮：刷新能源下拉（防车型能源变更）+ 用最新基线重算结果
  function recalc() {
    if (!formReady) return;
    syncEnergyOptions();
    renderResult();
    // 可见反馈：状态行 + 结果卡片高亮，确保"点了有反应"
    var st = byId('calcStatus');
    if (st) {
      var d = new Date();
      var hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2), ss = ('0' + d.getSeconds()).slice(-2);
      st.textContent = '✅ 已按最新数据基准重新测算（' + hh + ':' + mm + ':' + ss + '）';
      st.classList.add('ok');
    }
    var box = byId('result');
    if (box) { box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash'); }
  }

  function fmt(n) { return (Math.round(n * 100) / 100).toLocaleString('zh-CN'); }
  function pct(n) { return (Math.round(n * 10000) / 100).toFixed(2) + '%'; }
  // 能源类型长标签（UI 展示）与短标签（分组/日志）
  function energyLabel(e) {
    if (e === '油') return '油车（柴油）';
    if (e === '氢电') return '氢电混合';
    return '新能源（充电）';
  }
  function energyShort(e) {
    if (e === '油') return '油';
    if (e === '氢电') return '氢';
    return '电';
  }

  // ---------- 渲染：评估表单 ----------
  function fillSelect(el, items, valKey, labelKey, selected) {
    el.innerHTML = '';
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it[valKey]; o.textContent = it[labelKey];
      if (it[valKey] === selected) o.selected = true;
      el.appendChild(o);
    });
  }

  function buildForm() {
    fillSelect(byId('province'), Object.keys(STATE.provinceFactor).map(function (k) { return { k: k }; }), 'k', 'k', '全国平均');
    fillSelect(byId('vehicle'), STATE.vehicles, 'id', 'name', STATE.vehicles[0].id);
    fillSelect(byId('mode'), ['整车专线', '零担', '城配'].map(function (m) { return { x: m }; }), 'x', 'x', '整车专线');
    fillSelect(byId('month'), [1,2,3,4,5,6,7,8,9,10,11,12].map(function (m) { return { m: m }; }), 'm', 'm', new Date().getMonth() + 1);
    // 能源类型联动车型
    syncEnergyOptions();
    byId('km').value = 300;
    byId('price').value = 2500;
    byId('weight').value = 3;
    if (byId('volume'))     byId('volume').value = '';
    toggleWeight();
    var cbM = byId('cbMonthlyMode');
    if (cbM) cbM.checked = !!(STATE.config && STATE.config.monthlyRevenueMode);
    toggleMonthlyMode();
    formReady = true;
  }

  function syncEnergyOptions() {
    var vid = byId('vehicle').value;
    var v = STATE.vehicles.filter(function (x) { return x.id === vid; })[0];
    var sel = byId('energy');
    if (!sel) return;
    sel.innerHTML = '';
    // 防御：车型缺 energy 字段（老存档/自定义车型）时回退到「油」，绝不抛错
    var energies = (v && Array.isArray(v.energy) && v.energy.length) ? v.energy : ['油'];
    energies.forEach(function (e) {
      var o = document.createElement('option'); o.value = e; o.textContent = energyLabel(e); sel.appendChild(o);
    });
  }
  // 月总收入测算模式：切换单趟/月度输入显隐，并持久化开关
  function toggleMonthlyMode() {
    var on = !!(byId('cbMonthlyMode') && byId('cbMonthlyMode').checked);
    if (byId('priceRow')) byId('priceRow').style.display = on ? 'none' : '';
    if (byId('returnRow')) byId('returnRow').style.display = on ? 'none' : '';
    if (byId('monthlyRow')) byId('monthlyRow').style.display = on ? '' : 'none';
    if (on && byId('monthlyTrips') && !byId('monthlyTrips').value) {
      byId('monthlyTrips').value = (STATE.config && STATE.config.tripsPerMonth) || 22;
    }
    if (STATE.config) STATE.config.monthlyRevenueMode = on;
    saveState();
    renderResult();
  }
  // 货重与方量始终可见（满载率/吨公里成本对所有模式都有意义）
  function toggleWeight() {
    if (byId('weightRow')) byId('weightRow').style.display = '';
    if (byId('volumeRow')) byId('volumeRow').style.display = '';
  }

  // ---------- 渲染：评估结果（实战版：含税务/载重/月度/敏感度/保本） ----------
  function renderResult() {
    var f = {
      province: byId('province').value,
      vehicleId: byId('vehicle').value,
      energy: byId('energy').value,
      mode: byId('mode').value,
      km: byId('km').value,
      price: byId('price').value,
      weight: byId('weight').value,
      volume: byId('volume') ? byId('volume').value : '',
      returnRevenue: byId('returnRevenue').value,
      month: byId('month').value,
      monthlyMode: !!(byId('cbMonthlyMode') && byId('cbMonthlyMode').checked),
      monthlyRevenue: byId('monthlyRevenue') ? byId('monthlyRevenue').value : '',
      monthlyTrips: byId('monthlyTrips') ? byId('monthlyTrips').value : ''
    };
    var r = evaluate(f);
    var box = byId('result');
    if (r.error) { box.innerHTML = '<div class="muted">' + r.error + '</div>'; return; }

    var sc = r.seasonCoef, cal = r.calibration;
    function d(x) { return x * sc * cal; }
    var bars = [
      { label: '能源费', val: d(r.energyCost), color: '#BA7517' },
      { label: '过路费', val: d(r.tollCost), color: '#0F6E56' },
      { label: '司机人工', val: d(r.driverCost), color: '#534AB7' },
      { label: '轮胎/保险/装卸', val: d(r.otherVar), color: '#993C1D' },
      { label: '居间/杂费/理赔', val: d(r.broker + r.misc + r.risk), color: '#7A4B2B' }
    ];
    var maxv = Math.max.apply(null, bars.map(function (b) { return b.val; }).concat([1]));
    var barsHtml = bars.map(function (b) {
      var w = (b.val / maxv * 100).toFixed(1);
      return '<div class="bar-row"><span class="bar-label">' + b.label + '</span>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + b.color + '"></div></div>' +
        '<span class="bar-val">¥' + fmt(b.val) + '</span></div>';
    }).join('');

    var revLabel = r.returnRev > 0 ? ('¥' + fmt(r.revenueIncl) + '（含回程 ' + fmt(r.returnRev) + '）') : '¥' + fmt(r.revenueIncl);
    var H = [];
    H.push('<div class="decision ' + r.decisionClass + '">' + r.decision + '</div>');
    if (r.monthlyMode) {
      H.push('<div class="kpi-grid">' +
        kpi('月税后净利润', (r.mNetProfit >= 0 ? '¥' : '-¥') + fmt(Math.abs(r.mNetProfit)), '月总收入 ¥' + fmt(r.monthlyRevenue)) +
        kpi('月总收入（含税）', '¥' + fmt(r.monthlyRevenue), '本月 ' + r.monthlyTrips + ' 趟') +
        kpi('趟均净利', (r.netProfit >= 0 ? '¥' : '-¥') + fmt(Math.abs(r.netProfit)), '单趟等效运价 ¥' + fmt(r.revenueIncl)) +
        kpi('日均净利', (r.monthlyPerDayNet >= 0 ? '¥' : '-¥') + fmt(Math.abs(r.monthlyPerDayNet)), '按 30 天计') +
      '</div>');
    } else {
      H.push('<div class="kpi-grid">' +
        kpi('客户运价' + (r.priceIncludeVat ? '（含税）' : ''), revLabel, '去程 ' + fmt(r.revenueIncl - r.returnRev)) +
        kpi('总成本（含税）', '¥' + fmt(r.totalCost), (r.fixedCostOn === false ? '未分摊月固定成本' : '月固定分摊 ¥' + fmt(r.perTripFixed))) +
        kpi('税后净利', (r.netProfit >= 0 ? '¥' : '-¥') + fmt(Math.abs(r.netProfit)), '税前 ¥' + fmt(r.pretaxProfit)) +
        kpi('净利率', pct(r.netMargin), '阈值 ' + pct(r.threshold)) +
      '</div>');
    }
    H.push('<div class="bars">' + barsHtml + '</div>');

    // 明细表（成本 / 税务 / 载重 / 保本）
    H.push('<table class="detail">');
    H.push(row('线路里程（单程 / 往返）', fmt(r.km) + ' km / ' + fmt(r.roundKm) + ' km'));
    H.push(row('司机往返天数', r.days + ' 天（日均 ' + fmt(r.v.kmPerDay) + ' km）'));
    H.push(row('司机人工（工资+补贴·含吃住）', '¥' + fmt(r.driverCost) + '（日薪 ¥' + fmt(r.v.wage) + '）'));
    H.push(row('能源类型', energyLabel(r.energy)));
    if (r.energy === '氢电') H.push(row('能源费构成（氢 + 电）', '加氢 ¥' + fmt(r.eHydro) + ' ＋ 充电 ¥' + fmt(r.eElec)));
    H.push(row('回程货收入（冲减空返）', '¥' + fmt(r.returnRev)));
    H.push(row('淡旺季成本系数', r.seasonCoef >= 1 ? '×' + r.seasonCoef.toFixed(2) + '（旺季上浮）' : '×' + r.seasonCoef.toFixed(2) + '（淡季下浮）'));
    H.push(row('校准系数', (r.calibration === 1 ? '×1.000（未校准）' : '×' + r.calibration.toFixed(3) + (r.calibLabel ? '（' + r.calibLabel + '）' : '（已校准）'))));
    // 可选成本开关状态（哪些被关闭→不计该成本）
    var offItems = [];
    if (!r.brokerOn) offItems.push('居间/信息费');
    if (!r.insuranceOn) offItems.push('保险分摊');
    if (!r.miscOn) offItems.push('停车过磅杂费');
    if (!r.riskOn) offItems.push('货损/理赔(损耗)');
    if (!r.tireOn) offItems.push('轮胎/维修');
    if (!r.loadingOn) offItems.push('装卸费');
    if (offItems.length) H.push(row('已关闭的可选成本', offItems.join('、') + '（不计该成本）'));
    // 月固定分摊开关：关闭则单趟成本不含固定分摊（看纯运输贡献）
    if (r.fixedCostOn === false) H.push(row('月固定分摊', '已关闭（单趟成本不含月供/折旧/固定底薪）'));

    if (r.monthlyMode) {
      if (r.vatRateUsed > 0) {
        H.push(row('— 月度税务（' + (r.priceIncludeVat ? '月总收入含税' : '不含税') + '） —', ''));
        H.push(row('月收入（含税 / 不含税）', '¥' + fmt(r.monthlyRevenue) + ' / ¥' + fmt(r.monthlyRevenue - r.mOutputVat)));
        H.push(row('月度销项税额（' + pct(r.vatRateUsed) + '）', '¥' + fmt(r.mOutputVat)));
        H.push(row('月度进项税额（柴油+过路可抵扣）', '¥' + fmt(r.mInputVat)));
        H.push(row('月度应纳增值税 / 留抵', (r.mVatPayable > 0 ? ('¥' + fmt(r.mVatPayable)) : ('留抵 ¥' + fmt(r.mCarryForward)))));
        H.push(row('月度附加税', '¥' + fmt(r.mSurtax)));
        H.push(row('月度企业所得税', '¥' + fmt(r.mIncomeTax)));
        H.push(row('月税后净利润', (r.mNetProfit >= 0 ? '¥' : '-¥') + fmt(Math.abs(r.mNetProfit))));
      } else {
        H.push(row('月度税务计算', '未启用（月度净收益 = 月收入 − 月成本）'));
        H.push(row('月税后净利润', (r.mNetProfit >= 0 ? '¥' : '-¥') + fmt(Math.abs(r.mNetProfit))));
      }
    } else if (r.vatRateUsed > 0) {
      H.push(row('— 税务（' + (r.priceIncludeVat ? '运价含税' : '运价不含税') + '） —', ''));
      H.push(row('收入（含税 / 不含税）', '¥' + fmt(r.revenueIncl) + ' / ¥' + fmt(r.revenueExcl)));
      H.push(row('销项税额（' + pct(r.vatRateUsed) + '）', '¥' + fmt(r.outputVat)));
      H.push(row('进项税额（柴油+过路可抵扣）', '¥' + fmt(r.inputVat)));
      H.push(row('应纳增值税 / 留抵', (r.vatPayable > 0 ? ('¥' + fmt(r.vatPayable)) : ('留抵 ¥' + fmt(r.carryForward)))));
      H.push(row('附加税（城建+教育≈12%）', '¥' + fmt(r.surtax)));
      H.push(row('企业所得税', '¥' + fmt(r.incomeTax)));
      H.push(row('税后净利', (r.netProfit >= 0 ? '¥' : '-¥') + fmt(Math.abs(r.netProfit))));
    } else {
      H.push(row('税务计算', '未启用（净收益 = 收入 − 成本，不含税）'));
    }

    H.push(row('— 载重与满载率 —', ''));
    H.push(row('货重 / 核定载重', fmt(r.weight) + ' t / ' + fmt(r.capacity) + ' t'));
    if (r.volumeCap > 0) H.push(row('货量 / 车厢容积', fmt(r.volume) + ' 方 / ' + fmt(r.volumeCap) + ' 方'));
    H.push(row('满载率', r.loadFactor != null ? (r.loadFactor * 100).toFixed(0) + '%' : '—'));
    H.push(row('装载校验', r.fits ? '✅ 在核定载重内' : '⚠️ 超出核定载重，存在超载风险！'));
    if (r.tonKmCost != null) H.push(row('吨·公里成本（不含税）', '¥' + fmt(r.tonKmCost)));

    if (!r.monthlyMode) {
      H.push(row('保本运价（税后不亏）', '¥' + fmt(r.breakEvenPrice)));
      H.push(row('建议报价（达净利率阈值）', '¥' + fmt(r.suggestedPrice)));
    }
    H.push('</table>');

    // 月度运营
    if (r.monthlyMode) {
      H.push('<h3 class="sub" style="margin-top:16px;">月度运营测算（本月 ' + r.monthlyTrips + ' 趟）</h3>');
      H.push('<table class="detail">' +
        row('月固定成本', '¥' + fmt(r.monthlyFixed)) +
        row('单趟固定分摊', '¥' + fmt(r.perTripFixed)) +
        row('趟均税后净利', (r.netProfit >= 0 ? '¥' : '-¥') + fmt(Math.abs(r.netProfit))) +
        row('日均税后净利', (r.monthlyPerDayNet >= 0 ? '¥' : '-¥') + fmt(Math.abs(r.monthlyPerDayNet))) +
        row('月税后净利润', (r.mNetProfit >= 0 ? '¥' : '-¥') + fmt(Math.abs(r.mNetProfit))) +
        row('月盈亏平衡趟数', r.monthlyBreakEvenTrips === Infinity ? '当前线路单趟亏损，无法靠趟数摊平' : (r.monthlyBreakEvenTrips + ' 趟/月')) +
      '</table>');
    } else {
      H.push('<h3 class="sub" style="margin-top:16px;">月度运营测算（按 月出车 ' + r.tripsPerMonth + ' 趟）</h3>');
      H.push('<table class="detail">' +
        row('月固定成本', '¥' + fmt(r.monthlyFixed)) +
        row('单趟固定分摊', '¥' + fmt(r.perTripFixed)) +
        row('单趟税后净利', (r.netProfit >= 0 ? '¥' : '-¥') + fmt(Math.abs(r.netProfit))) +
        row('月税后净利润', (r.monthlyNetProfit >= 0 ? '¥' : '-¥') + fmt(Math.abs(r.monthlyNetProfit))) +
        row('月盈亏平衡趟数', r.monthlyBreakEvenTrips === Infinity ? '当前线路单趟亏损，无法靠趟数摊平' : (r.monthlyBreakEvenTrips + ' 趟/月')) +
      '</table>');
    }

    // 敏感度
    H.push('<h3 class="sub" style="margin-top:16px;">敏感度（对税后净利的影响）</h3>');
    H.push('<table class="detail">' +
      row('柴油价 +10%', (r.sens.dieselUp10 >= 0 ? '+' : '') + '¥' + fmt(r.sens.dieselUp10)) +
      row('客户运价 −5%', (r.sens.priceDown5 >= 0 ? '+' : '') + '¥' + fmt(r.sens.priceDown5)) +
      row('无回程收入', (r.sens.noReturn >= 0 ? '+' : '') + '¥' + fmt(r.sens.noReturn)) +
    '</table>');

    H.push('<p class="hint">提示：若回程无货，司机往返成本已计入；建议补充回程货收入以提高实际利润。载重/容积超出核定值会触发超载预警，请核对实际装货。</p>');

    box.innerHTML = H.join('');
  }
  function kpi(label, val, sub) {
    return '<div class="kpi"><div class="kpi-label">' + label + '</div><div class="kpi-val">' + val + '</div>' +
      (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') + '</div>';
  }
  function row(k, v) { return '<tr><td>' + k + '</td><td>' + v + '</td></tr>'; }

  // ---------- 数据基准编辑器 ----------
  function renderEditor() {
    sv('edDiesel', STATE.energy.dieselPrice);
    sv('edElec', STATE.energy.electricityPrice);
    sv('edH2', STATE.energy.hydrogenPrice);
    sv('edThreshold', (STATE.config.profitThreshold * 100).toFixed(1));
    sv('edUrl', STATE.config.dataSourceUrl || '');
    var dm = STATE.config.dataSourceMap || {};
    sv('mapDiesel', dm.dieselPrice || '');
    sv('mapElec', dm.electricityPrice || '');
    sv('mapH2', dm.hydrogenPrice || '');
    sv('mapSeason', dm.seasonMonthly || '');
    sv('mapProvince', dm.provinceFactor || '');
    sv('edBackend', STATE.config.backendUrl || '');
    sv('edRoadFactor', STATE.config.roadFactor != null ? STATE.config.roadFactor : 1.3);
    sv('distMode', STATE.config.distanceMode || 'auto');
    sv('edProvince', STATE.config.targetProvince || '');

    // —— 实战新增字段 ——
    var cfg = STATE.config, tax = cfg.tax || {};
    var cb1 = byId('edPriceVat'); if (cb1) cb1.checked = (cfg.priceIncludeVat !== false);
    var cb2 = byId('edTaxEnabled'); if (cb2) cb2.checked = !!tax.enabled;
    sv('edVatRate', (tax.vatRate != null ? tax.vatRate : 0.09));
    sv('edDieselVat', (tax.dieselInputVat != null ? tax.dieselInputVat : 0.13));
    sv('edTollVat', (tax.tollInputVat != null ? tax.tollInputVat : 0.09));
    sv('edSurtax', (tax.surtaxRate != null ? tax.surtaxRate : 0.12));
    sv('edIncomeTax', (tax.incomeTaxRate != null ? tax.incomeTaxRate : 0.25));
    sv('edBroker', STATE.other.brokerPct != null ? STATE.other.brokerPct : 0.03);
    sv('edIns', STATE.other.insurancePerKm != null ? STATE.other.insurancePerKm : 0.18);
    sv('edMisc', STATE.other.miscPerTrip != null ? STATE.other.miscPerTrip : 30);
    sv('edRisk', STATE.other.riskPct != null ? STATE.other.riskPct : 0.008);
    sv('edTrips', cfg.tripsPerMonth != null ? cfg.tripsPerMonth : 22);
    var cbF = byId('edFixedEnabled'); if (cbF) cbF.checked = (cfg.fixedCostEnabled !== false);
    // 可选成本开关
    var o = STATE.other;
    var cbB = byId('edBrokerEnabled'); if (cbB) cbB.checked = (o.brokerEnabled !== false);
    var cbI = byId('edInsEnabled'); if (cbI) cbI.checked = (o.insuranceEnabled !== false);
    var cbM = byId('edMiscEnabled'); if (cbM) cbM.checked = (o.miscEnabled !== false);
    var cbR = byId('edRiskEnabled'); if (cbR) cbR.checked = (o.riskEnabled !== false);
    var cbT = byId('edTireEnabled'); if (cbT) cbT.checked = (o.tireEnabled !== false);
    var cbL = byId('edLoadingEnabled'); if (cbL) cbL.checked = (o.loadingEnabled !== false);

    // 车型表（增加 载重 / 容积 / 月固定）
    var vt = byId('vehicleTable');
    vt.innerHTML = '<tr><th>车型</th><th>油耗 L/100km</th><th>电耗 kWh/100km</th><th>氢耗 kg/100km</th><th>日工资</th><th>日里程</th><th>载重 t</th><th>容积 方</th><th>月固定 元/月</th></tr>' +
      STATE.vehicles.map(function (v, i) {
        return '<tr>' +
          '<td>' + v.name + '</td>' +
          '<td><input data-v="' + i + '" data-k="fuel" type="number" step="0.5" value="' + v.fuel + '"></td>' +
          '<td><input data-v="' + i + '" data-k="elec" type="number" step="0.5" value="' + (v.elec == null ? '' : v.elec) + '" placeholder="-"></td>' +
          '<td><input data-v="' + i + '" data-k="hydrogen" type="number" step="0.5" value="' + (v.hydrogen == null ? '' : v.hydrogen) + '" placeholder="-"></td>' +
          '<td><input data-v="' + i + '" data-k="wage" type="number" step="10" value="' + v.wage + '"></td>' +
          '<td><input data-v="' + i + '" data-k="kmPerDay" type="number" step="10" value="' + v.kmPerDay + '"></td>' +
          '<td><input data-v="' + i + '" data-k="capacity" type="number" step="0.5" value="' + v.capacity + '"></td>' +
          '<td><input data-v="' + i + '" data-k="volume" type="number" step="1" value="' + v.volume + '"></td>' +
          '<td><input data-v="' + i + '" data-k="monthlyFixed" type="number" step="100" value="' + v.monthlyFixed + '"></td>' +
        '</tr>';
      }).join('');

    // 淡旺季 12 月
    var sc = byId('seasonInputs');
    sc.innerHTML = STATE.season.monthly.map(function (m, i) {
      return '<label class="season-cell">( ' + (i + 1) + '月 )<input data-s="' + i + '" type="number" step="0.01" value="' + m + '"></label>';
    }).join('');

    // 省份系数
    var pf = byId('provinceInputs');
    pf.innerHTML = Object.keys(STATE.provinceFactor).map(function (k) {
      return '<label class="season-cell">' + k + '<input data-p="' + k + '" type="number" step="0.01" value="' + STATE.provinceFactor[k] + '"></label>';
    }).join('');

    // 过路费费率（按车型类别）
    var tt = byId('tollTable');
    if (tt) tt.innerHTML = '<tr><th>车型类别</th><th>过路费 元/km</th></tr>' +
      Object.keys(STATE.tollClasses).map(function (k) {
        return '<tr><td>' + k + '</td><td><input data-toll="' + k + '" type="number" step="0.05" min="0" value="' + STATE.tollClasses[k] + '"></td></tr>';
      }).join('');

    // 末尾：按「目标省份」套用分省油价（不递归调用 renderEditor）
    applyProvinceOilPrice();
  }

  function bindEditor() {
    // 空值保护：极端情况下 STATE.config/energy 异常时不让绑定阶段抛错（避免按钮不绑定=“无反应”）
    STATE.config = STATE.config || {};
    STATE.config.dataSourceMap = STATE.config.dataSourceMap || {};
    STATE.energy = STATE.energy || {};
    bind('edDiesel', 'input', function () { STATE.energy.dieselPrice = +this.value; saveState(); });
    bind('edElec', 'input', function () { STATE.energy.electricityPrice = +this.value; saveState(); });
    bind('edH2', 'input', function () { STATE.energy.hydrogenPrice = +this.value; saveState(); });
    bind('edThreshold', 'input', function () { STATE.config.profitThreshold = (+this.value) / 100; saveState(); renderResult(); });
    bind('edUrl', 'input', function () { STATE.config.dataSourceUrl = this.value; saveState(); });
    var MAP_KEYS = { mapDiesel: 'dieselPrice', mapElec: 'electricityPrice', mapH2: 'hydrogenPrice', mapSeason: 'seasonMonthly', mapProvince: 'provinceFactor' };
    Object.keys(MAP_KEYS).forEach(function (id) {
      bind(id, 'input', function () {
        STATE.config.dataSourceMap = STATE.config.dataSourceMap || {};
        STATE.config.dataSourceMap[MAP_KEYS[id]] = this.value;
        saveState();
      });
    });
    bind('edBackend', 'input', function () { STATE.config.backendUrl = this.value.trim(); saveState(); });
    bind('edProvince', 'input', function () { STATE.config.targetProvince = this.value.trim(); saveState(); applyProvinceOilPrice(); });
    bind('edRoadFactor', 'input', function () { var v = parseFloat(this.value); STATE.config.roadFactor = (isFinite(v) && v > 0) ? v : 1.3; saveState(); });
    bind('distMode', 'change', function () { STATE.config.distanceMode = this.value; saveState(); });

    // —— 实战新增字段绑定 ——
    bind('edPriceVat', 'change', function () { STATE.config.priceIncludeVat = this.checked; saveState(); renderResult(); });
    bind('edTaxEnabled', 'change', function () { if (!STATE.config.tax) STATE.config.tax = {}; STATE.config.tax.enabled = this.checked; saveState(); renderResult(); });
    bind('edVatRate', 'input', function () { if (!STATE.config.tax) STATE.config.tax = {}; STATE.config.tax.vatRate = +this.value; saveState(); renderResult(); });
    bind('edDieselVat', 'input', function () { if (!STATE.config.tax) STATE.config.tax = {}; STATE.config.tax.dieselInputVat = +this.value; saveState(); });
    bind('edTollVat', 'input', function () { if (!STATE.config.tax) STATE.config.tax = {}; STATE.config.tax.tollInputVat = +this.value; saveState(); });
    bind('edSurtax', 'input', function () { if (!STATE.config.tax) STATE.config.tax = {}; STATE.config.tax.surtaxRate = +this.value; saveState(); });
    bind('edIncomeTax', 'input', function () { if (!STATE.config.tax) STATE.config.tax = {}; STATE.config.tax.incomeTaxRate = +this.value; saveState(); renderResult(); });
    bind('edBroker', 'input', function () { STATE.other.brokerPct = +this.value; saveState(); renderResult(); });
    bind('edIns', 'input', function () { STATE.other.insurancePerKm = +this.value; saveState(); renderResult(); });
    bind('edMisc', 'input', function () { STATE.other.miscPerTrip = +this.value; saveState(); renderResult(); });
    bind('edRisk', 'input', function () { STATE.other.riskPct = +this.value; saveState(); renderResult(); });
    bind('edTrips', 'input', function () { var v = parseInt(this.value, 10); STATE.config.tripsPerMonth = (v > 0) ? v : 22; saveState(); renderResult(); });
    bind('edFixedEnabled', 'change', function () { STATE.config.fixedCostEnabled = this.checked; saveState(); renderResult(); });
    // 可选成本开关
    bind('edBrokerEnabled', 'change', function () { STATE.other.brokerEnabled = this.checked; saveState(); renderResult(); });
    bind('edInsEnabled', 'change', function () { STATE.other.insuranceEnabled = this.checked; saveState(); renderResult(); });
    bind('edMiscEnabled', 'change', function () { STATE.other.miscEnabled = this.checked; saveState(); renderResult(); });
    bind('edRiskEnabled', 'change', function () { STATE.other.riskEnabled = this.checked; saveState(); renderResult(); });
    bind('edTireEnabled', 'change', function () { STATE.other.tireEnabled = this.checked; saveState(); renderResult(); });
    bind('edLoadingEnabled', 'change', function () { STATE.other.loadingEnabled = this.checked; saveState(); renderResult(); });

    bind('vehicleTable', 'input', function (e) {
      var t = e.target; if (!t.dataset.v) return;
      var i = +t.dataset.v, k = t.dataset.k;
      var val = ((k === 'elec' || k === 'hydrogen') && t.value === '') ? null : +t.value;
      STATE.vehicles[i][k] = val; saveState(); syncEnergyOptions();
    });
    bind('seasonInputs', 'input', function (e) {
      if (e.target.dataset.s == null) return;
      STATE.season.monthly[+e.target.dataset.s] = +e.target.value; saveState();
    });
    bind('provinceInputs', 'input', function (e) {
      if (e.target.dataset.p == null) return;
      STATE.provinceFactor[e.target.dataset.p] = +e.target.value; saveState();
    });
    bind('tollTable', 'input', function (e) {
      if (!e.target.dataset.toll) return;
      STATE.tollClasses[e.target.dataset.toll] = parseFloat(e.target.value) || 0;
      saveState();
    });
  }

  function resetData() {
    if (!confirm('确定恢复为系统默认基线数据？\n（你录入的真实成交会被保留，不会清空。）')) return;
    var keepLogs = (STATE && Array.isArray(STATE.logs)) ? STATE.logs : [];
    var fresh = JSON.parse(JSON.stringify(window.DEFAULTS));
    fresh.logs = keepLogs;        // 保留真实成交，不误删你的数据
    fresh.calibration = 1; fresh.calibrations = {};
    // 先落盘再渲染：即便后续某步渲染异常，本地基线也已恢复为默认（刷新即生效）
    STATE = fresh;
    saveState();
    try {
      renderEditor(); buildForm(); renderResult(); renderCalib();
      alert('已恢复为系统默认基线（真实成交已保留）。');
    } catch (e) {
      alert('已恢复默认基线，但页面局部刷新失败：' + e.message + '。请刷新页面查看效果。');
    }
  }
  function exportJson() {
    byId('jsonBox').value = JSON.stringify(STATE, null, 2);
    alert('已生成当前完整配置 JSON（可复制保存，或编辑后点「导入」载入）。');
  }
  function importJson() {
    var raw = byId('jsonBox').value;
    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { alert('JSON 解析失败：' + e.message + '（请检查括号 / 引号是否完整）'); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      alert('导入失败：内容不是一份完整的配置对象（应为 { … } 形式的 JSON）。'); return;
    }
    var prev = STATE, next;
    try { next = normalizeState(parsed); }
    catch (e) { alert('导入失败：数据不完整或字段类型错误（' + e.message + '）。当前配置未改动。'); return; }
    try {
      STATE = next;
      saveState();
      renderEditor(); buildForm(); renderResult(); renderCalib();
      alert('已导入：配置已更新并保存到本地。');
    } catch (e) {
      // 渲染异常则回滚，绝不让页面崩、也不留半截数据
      STATE = prev; saveState();
      alert('导入中止：渲染时发生错误（' + e.message + '），已保留原有配置。');
    }
  }

  // ---------- 真实成交录入与校准 ----------
  function initCalibForm() {
    fillSelect(byId('lgVehicle'), STATE.vehicles, 'id', 'name', STATE.vehicles[0].id);
    syncLgEnergy();
    fillSelect(byId('lgMonth'), [1,2,3,4,5,6,7,8,9,10,11,12].map(function (m) { return { m: m }; }), 'm', 'm', new Date().getMonth() + 1);
    byId('lgVehicle').addEventListener('change', syncLgEnergy);
  }
  function syncLgEnergy() {
    var v = STATE.vehicles.filter(function (x) { return x.id === byId('lgVehicle').value; })[0];
    var sel = byId('lgEnergy');
    if (!sel) return;
    sel.innerHTML = '';
    var energies = (v && Array.isArray(v.energy) && v.energy.length) ? v.energy : ['油'];
    energies.forEach(function (e) {
      var o = document.createElement('option'); o.value = e; o.textContent = energyLabel(e); sel.appendChild(o);
    });
  }
  function saveLog() {
    var km = +byId('lgKm').value || 0;
    var price = +byId('lgPrice').value || 0;
    var actCostRaw = byId('lgActualCost').value;
    var actProfitRaw = byId('lgActualProfit').value;
    var actCost = (actCostRaw === '' || actCostRaw == null) ? null : (+actCostRaw);
    var actProfit = (actProfitRaw === '' || actProfitRaw == null) ? null : (+actProfitRaw);
    if (km <= 0 || price <= 0) { byId('logStatus').textContent = '请至少填写里程与客户运价'; return; }
    if (actCost == null && actProfit == null) { byId('logStatus').textContent = '请填写「实际总成本」或「实际利润」之一'; return; }
    var ret = +byId('lgReturn').value || 0;
    var revenue = price + ret;
    var actualTotal = (actCost != null) ? actCost : (revenue - actProfit);
    if (actualTotal < 0) { byId('logStatus').textContent = '实际总成本不能为负，请检查利润/成本填写'; return; }
    STATE.logs.push({
      ts: Date.now(),
      route: byId('lgRoute').value.trim(),
      vehicleId: byId('lgVehicle').value,
      energy: byId('lgEnergy').value,
      mode: byId('lgMode').value,
      month: +byId('lgMonth').value,
      km: km,
      weight: +byId('lgWeight').value || 0,
      price: price,
      returnRevenue: ret,
      actualTotal: actualTotal,
      note: byId('lgNote').value.trim()
    });
    saveState();
    renderCalib();
    byId('logStatus').textContent = '已保存（共 ' + STATE.logs.length + ' 单）';
  }
  function deleteLog(idx) {
    if (idx < 0 || idx >= STATE.logs.length) return;
    STATE.logs.splice(idx, 1);
    saveState(); renderCalib();
  }
  function recomputeCalibration() {
    var valid = STATE.logs.filter(function (L) { return L.actualTotal > 0 && L.km > 0; });
    if (valid.length < 1) { alert('请先录入至少 1 单含「实际总成本」的成交'); return; }
    // 按「车型·能源·模式」分组，各组独立算均值（夹取 [0.5,2.0]）
    var groups = {};
    var allRatios = [];
    valid.forEach(function (L) {
      var m = evaluate({ vehicleId: L.vehicleId, energy: L.energy, mode: L.mode, month: L.month, km: L.km, weight: L.weight, price: L.price, returnRevenue: L.returnRevenue, raw: true });
      if (m.error || m.totalCost <= 0) return;
      var ratio = L.actualTotal / m.totalCost;
      if (!isFinite(ratio)) return;
      var key = L.vehicleId + '|' + L.energy + '|' + L.mode;
      if (!groups[key]) {
        var v = STATE.vehicles.filter(function (x) { return x.id === L.vehicleId; })[0];
        groups[key] = { key: key, label: (v ? v.name : L.vehicleId) + '·' + energyShort(L.energy) + '·' + L.mode, ratios: [] };
      }
      groups[key].ratios.push(ratio);
      allRatios.push(ratio);
    });
    if (!allRatios.length) { alert('样本不足或模型计算异常'); return; }
    var calibrations = {};
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var mean = g.ratios.reduce(function (a, b) { return a + b; }, 0) / g.ratios.length;
      mean = Math.max(0.5, Math.min(2.0, mean));
      calibrations[k] = { coef: Math.round(mean * 1000) / 1000, count: g.ratios.length, label: g.label };
    });
    STATE.calibrations = calibrations;
    // 全局兜底系数 = 全体均值（夹取），用于未匹配到分组的场景
    var globalMean = allRatios.reduce(function (a, b) { return a + b; }, 0) / allRatios.length;
    STATE.calibration = Math.round(Math.max(0.5, Math.min(2.0, globalMean)) * 1000) / 1000;
    saveState(); renderCalib(); renderResult();
    var nGroups = Object.keys(calibrations).length;
    alert('已用 ' + valid.length + ' 单校准，生成 ' + nGroups + ' 个细分系数（按 车型·能源·模式 分组）。\n模型将自动按分组套用对应系数，样本越多越准。');
  }
  function clearCalibration() {
    STATE.calibration = 1; STATE.calibrations = {}; saveState(); renderCalib(); renderResult();
    byId('logStatus').textContent = '已清除校准，恢复默认基线。';
  }
  function renderCalib() {
    // 数据来源框
    var notes = (STATE.meta && STATE.meta.notes) ? STATE.meta.notes : [];
    var asOf = (STATE.meta && STATE.meta.asOf) ? STATE.meta.asOf : '';
    byId('sourceBox').innerHTML = '<b>当前基线数据来源（' + asOf + '，行业公开参考值）</b><ul>' +
      notes.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>';

    // 逐单：模型(raw) vs 实际
    var rows = STATE.logs.map(function (L, idx) {
      var m = evaluate({ vehicleId: L.vehicleId, energy: L.energy, mode: L.mode, month: L.month, km: L.km, weight: L.weight, price: L.price, returnRevenue: L.returnRevenue, raw: true });
      if (m.error) return null;
      var revenue = L.price + (L.returnRevenue || 0);
      var modelProfit = revenue - m.totalCost;
      var actualProfit = revenue - L.actualTotal;
      var dev = L.actualTotal > 0 ? (m.totalCost - L.actualTotal) / L.actualTotal : 0; // +: 模型高估成本
      return { idx: idx, L: L, m: m, revenue: revenue, modelProfit: modelProfit, actualProfit: actualProfit, dev: dev };
    }).filter(Boolean);

    var valid = rows.filter(function (r) { return r.L.actualTotal > 0; });
    var avgDev = valid.length ? valid.reduce(function (a, r) { return a + r.dev; }, 0) / valid.length : 0;
    byId('calibStatus').innerHTML =
      '样本数：<b>' + STATE.logs.length + '</b>　|　当前校准系数：<b>×' + (STATE.calibration || 1).toFixed(3) + '</b>　|　校准前平均成本偏差：<b>' +
      (avgDev >= 0 ? '+' : '') + (avgDev * 100).toFixed(1) + '%</b>' +
      (valid.length < 3 ? '<br><span class="muted">样本不足 3 单时，校准仅供参考，建议继续积累真实成交。</span>' : '');

    // 细分分组系数表
    var gk = Object.keys(STATE.calibrations || {});
    if (gk.length) {
      var gh = '<h3 class="sub">细分校准系数（车型·能源·模式）</h3>';
      gh += '<table class="detail log-table"><tr><th>分组</th><th>样本</th><th>系数</th><th>对总成本影响</th></tr>';
      gh += gk.map(function (k) {
        var g = STATE.calibrations[k];
        var pctTxt = (g.coef >= 1 ? '+' : '') + ((g.coef - 1) * 100).toFixed(1) + '%';
        return '<tr><td>' + g.label + '</td><td>' + g.count + '</td><td>×' + g.coef.toFixed(3) + '</td><td>' + pctTxt + '</td></tr>';
      }).join('');
      gh += '</table><p class="hint">评估时系统会按当前所选「车型·能源·模式」自动套用对应分组系数；未匹配到分组时回退全局系数 ×' + (STATE.calibration || 1).toFixed(3) + '。</p>';
      byId('calibGroups').innerHTML = gh;
    } else {
      byId('calibGroups').innerHTML = '';
    }

    if (!rows.length) {
      byId('logTable').innerHTML = '<p class="muted">还没有录入任何成交。做一单记一单，模型会越用越准。</p>';
      return;
    }
    var head = '<table class="detail log-table"><tr><th>线路</th><th>车型/能源</th><th>模式</th><th>运价</th><th>模型利润</th><th>实际利润</th><th>成本偏差</th><th></th></tr>';
    var body = rows.map(function (r) {
      var vname = energyShort(r.L.energy);
      var devTxt = (r.dev >= 0 ? '+' : '') + (r.dev * 100).toFixed(1) + '%';
      var devCls = Math.abs(r.dev) > 0.1 ? 'bad' : (Math.abs(r.dev) > 0.05 ? 'warn' : 'ok');
      var vlabel = r.m.v ? r.m.v.name : r.L.vehicleId;
      return '<tr><td>' + (r.L.route || '-') + '</td><td>' + vlabel + '/' + vname + '</td><td>' + r.L.mode + '</td>' +
        '<td>¥' + fmt(r.revenue) + '</td><td>¥' + fmt(r.modelProfit) + '</td><td>¥' + fmt(r.actualProfit) + '</td>' +
        '<td class="' + devCls + '">' + devTxt + '</td><td><button class="link" data-del="' + r.idx + '">删</button></td></tr>';
    }).join('');
    byId('logTable').innerHTML = head + body + '</table>';
  }

  // ---------- 联网更新 ----------
  // 按 JSON 路径取值：支持 data.0.0h / data[0].price / data.season 形式
  function getPath(obj, path) {
    if (!path) return undefined;
    var p = String(path).replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '');
    var keys = p.split('.');
    var cur = obj;
    for (var i = 0; i < keys.length; i++) {
      if (cur == null) return undefined;
      cur = cur[keys[i]];
    }
    return cur;
  }
  function applyMapped(d) {
    var m = STATE.config.dataSourceMap || {};
    var v;
    if (m.dieselPrice) { v = getPath(d, m.dieselPrice); if (v != null) STATE.energy.dieselPrice = +v; }
    if (m.electricityPrice) { v = getPath(d, m.electricityPrice); if (v != null) STATE.energy.electricityPrice = +v; }
    if (m.hydrogenPrice) { v = getPath(d, m.hydrogenPrice); if (v != null) STATE.energy.hydrogenPrice = +v; }
    if (m.seasonMonthly) { v = getPath(d, m.seasonMonthly); if (Array.isArray(v) && v.length === 12) STATE.season.monthly = v.map(Number); }
    if (m.provinceFactor) { v = getPath(d, m.provinceFactor); if (v && typeof v === 'object') STATE.provinceFactor = Object.assign({}, STATE.provinceFactor, v); }
    saveState(); renderEditor(); renderResult();
  }
  // 按省份在分省油价数组里定位并取柴油价（仅对带 find 描述的预设生效）。
  // 返回 true 表示已处理（含成功/未命中回退）并负责写入 liveStatus；false 则交由通用映射路径。
  function applyWithProvince(d) {
    var k = STATE.config.activePreset;
    if (!k) return false;
    var p = SOURCE_PRESETS[k];
    if (!p || !p.find) return false;
    var prov = (STATE.config.targetProvince || '').trim();
    if (!prov) return false;                 // 未指定省份 → 走通用映射（默认首条）
    var arr = getPath(d, p.find.array);
    if (!arr || !arr.length) return false;
    var chosen = null, chosenName = '';
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i][p.find.field];
      if (f && String(f).indexOf(prov) !== -1) { chosen = arr[i]; chosenName = f; break; }
    }
    var ts = new Date().toLocaleString('zh-CN');
    if (!chosen) {                           // 省份未命中：回退首条并提示核对
      chosen = arr[0];
      var d0 = getPath(chosen, p.find.diesel);
      if (d0 == null) return false;
      STATE.energy.dieselPrice = +d0; saveState(); renderEditor(); renderResult();
      byId('liveStatus').textContent = '未找到「' + prov + '」，已用首条省份（' + (arr[0][p.find.field] || '?') + '）柴油价 @ ' + ts + '；请核对省份名（如填「广东」而非「广东省」）。';
      return true;
    }
    var diesel = getPath(chosen, p.find.diesel);
    if (diesel == null) return false;
    STATE.energy.dieselPrice = +diesel; saveState(); renderEditor(); renderResult();
    byId('liveStatus').textContent = '已按「' + prov + '」（' + chosenName + '）同步柴油价：' + (+diesel).toFixed(2) + ' 元/L @ ' + ts + '（联网更新·免Key）';
    return true;
  }
  function applyServerData(d) {
    if (d.dieselPrice != null) STATE.energy.dieselPrice = +d.dieselPrice;
    if (d.electricityPrice != null) STATE.energy.electricityPrice = +d.electricityPrice;
    if (d.hydrogenPrice != null) STATE.energy.hydrogenPrice = +d.hydrogenPrice;
    if (Array.isArray(d.seasonMonthly) && d.seasonMonthly.length === 12) STATE.season.monthly = d.seasonMonthly.map(Number);
    if (d.provinceFactor) STATE.provinceFactor = Object.assign({}, STATE.provinceFactor, d.provinceFactor);
    // 分省真实油价：写入后由 applyProvinceOilPrice 按「目标省份」自动套用
    if (d.provinceOilPrices && typeof d.provinceOilPrices === 'object') STATE.provinceOil = d.provinceOilPrices;
    saveState(); renderEditor(); renderResult();
  }
  // 用已拉取的分省油价，按「目标省份」自动套用该省 0# 柴油价（元/L）参与计算。
  // 不调用 renderEditor（避免递归），只更新油价输入框与读数，并重算结果。
  function applyProvinceOilPrice() {
    var prov = (STATE.config.targetProvince || '').trim();
    var note = byId('oilProvinceNote');
    var dieselEl = byId('edDiesel');
    if (!prov) {
      if (note) note.textContent = (STATE.provinceOil && Object.keys(STATE.provinceOil).length)
        ? '已加载分省油价（' + Object.keys(STATE.provinceOil).length + ' 省）。在「目标省份」选择省份即自动套用该省 0# 柴油价。'
        : '';
      return;
    }
    if (STATE.provinceOil && STATE.provinceOil[prov] != null) {
      var p = +STATE.provinceOil[prov];
      STATE.energy.dieselPrice = p;
      if (dieselEl) dieselEl.value = p.toFixed(2);
      if (note) note.textContent = '已按「' + prov + '」套用真实 0# 柴油价：' + p.toFixed(2) + ' 元/L（后端实时·免Key）';
      renderResult();
    } else if (note) {
      note.textContent = '未匹配到「' + prov + '」的分省油价（后端可能尚未拉取，或省份名不符，建议填「广东」而非「广东省」）。';
    }
  }
  function backendBase() {
    var b = (STATE.config.backendUrl || '').trim();
    return b ? b.replace(/\/+$/, '') : '';
  }
  function isNetworkBlocked(msg) {
    return /Failed to fetch|NetworkError|network|ECONN|timeout|代理|proxy|blocked|sandbox/i.test(msg || '');
  }
  // 开箱即用：首次且无任何配置时，自动套用 OpenVan 全球油价预设（浏览器直连·免Key·实时柴油价），
  // 让「联网更新」不再需要手动填 URL。已配置后端或已填 URL 则不打扰。
  function ensureLiveSource() {
    if ((STATE.config.backendUrl || '').trim()) return;
    if ((STATE.config.dataSourceUrl || '').trim()) return;
    var k = 'openvan';
    var p = SOURCE_PRESETS[k];
    if (!p) return;
    STATE.config.dataSourceUrl = p.url;
    STATE.config.dataSourceMap = Object.assign({}, p.map);
    STATE.config.activePreset = k;
    saveState(); renderEditor();
    var sel = byId('srcPreset'); if (sel) sel.value = k;
  }
  // 离线/沙箱友好：加载一套演示基线（非真实），走完「更新→基线」完整闭环
  function loadDemoData() {
    var r = function (b, a) { return +(b + (Math.random() - 0.5) * a).toFixed(3); };
    var d = {
      dieselPrice: r(7.5, 0.4),
      electricityPrice: r(1.2, 0.1),
      seasonMonthly: STATE.season.monthly.map(function (m) { return +(m + (Math.random() - 0.5) * 0.04).toFixed(3); }),
      provinceFactor: STATE.provinceFactor
    };
    applyServerData(d);
    byId('liveStatus').textContent = '已加载演示数据（非真实，仅预览更新→基线闭环）@ ' + new Date().toLocaleString('zh-CN')
      + '。要真实油价，请本机运行 node server/server.js 并访问 http://127.0.0.1:3000 后点「立即拉取最新数据」。';
    alert('已加载演示数据，可切换到「数据基准」页查看更新后的油价 / 运价指数。');
  }
  function testSource() {
    var base = backendBase();
    if (base) {
      byId('liveStatus').textContent = '正在请求后端最新数据…';
      fetch(base + '/api/data/latest').then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (d) {
          byId('rawPreview').style.display = 'block';
          byId('rawPreview').textContent = JSON.stringify(d, null, 2).slice(0, 4000);
          byId('liveStatus').textContent = '后端返回最新数据（' + (d.isDemo ? '演示数据' : '真实源') + '）@ ' + (d.updatedAt || '') + '，预览见上方黑框。';
        })
        .catch(function (e) { byId('liveStatus').textContent = '后端请求失败：' + e.message + '（确认 server 已启动、backendUrl 正确）'; });
      return;
    }
    ensureLiveSource();
    var url = STATE.config.dataSourceUrl;
    if (!url) { alert('请先填写数据源 URL（返回 JSON），或在 backendUrl 填入本系统后端地址。'); return; }
    byId('liveStatus').textContent = '正在测试连接…';
    fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (d) {
      byId('rawPreview').style.display = 'block';
      byId('rawPreview').textContent = JSON.stringify(d, null, 2).slice(0, 4000);
      byId('liveStatus').textContent = '已拉取，原始返回见上方黑框（用「字段映射」把它对应到柴油价/充电价等）。';
    }).catch(function (e) {
      byId('rawPreview').style.display = 'block';
      var msg = (e && e.message) || String(e);
      byId('rawPreview').textContent = (isNetworkBlocked(msg) ? '外网不可达（沙箱/代理拦截/断网）' : '拉取失败：' + msg);
      byId('liveStatus').textContent = (isNetworkBlocked(msg)
        ? '⚠️ 当前环境无法访问外网（如在 CloudStudio 沙箱或被本地代理拦截）。'
        : '测试失败：' + msg)
        + ' 要获取真实数据：① 本机终端执行 node server/server.js ② 浏览器打开 http://127.0.0.1:3000 。或点「加载演示数据」预览。';
    });
  }
  function liveUpdate() {
    var base = backendBase();
    if (base) {
      byId('liveStatus').textContent = '正在请求后端刷新…';
      fetch(base + '/api/data/refresh').then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (d) {
          applyServerData(d);
          byId('liveStatus').textContent = '已同步最新数据 @ ' + (d.updatedAt || '') + (d.isDemo ? '（演示数据）' : '（真实源）') + '｜' + (d.note || '');
        })
        .catch(function (e) { byId('liveStatus').textContent = '后端更新失败：' + e.message + '（确认 server 已启动、backendUrl 正确）'; });
      return;
    }
    ensureLiveSource();
    var url = STATE.config.dataSourceUrl;
    if (!url) { alert('请先填写数据源 URL（返回 JSON），或在 backendUrl 填入本系统后端地址。'); switchTab('data'); return; }
    byId('liveStatus').textContent = '正在拉取…';
    fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (d) {
      if (applyWithProvince(d)) return;     // 已按目标省份定位并设好 liveStatus
      var m = STATE.config.dataSourceMap || {};
      var hasMap = !!(m.dieselPrice || m.electricityPrice || m.seasonMonthly || m.provinceFactor);
      if (hasMap) applyMapped(d); else applyServerData(d); // 无映射则兼容旧式扁平 JSON
      byId('liveStatus').textContent = '已同步最新数据 @ ' + new Date().toLocaleString('zh-CN') + (hasMap ? '（按字段映射）' : '（按扁平字段）')
        + ' ｜ 注：OpenVan 仅含柴油价，电/氢价请到「数据基准」页手填。';
    }).catch(function (e) {
      var msg = (e && e.message) || String(e);
      byId('rawPreview').style.display = 'block';
      byId('rawPreview').textContent = isNetworkBlocked(msg) ? '外网不可达（sandbox / 代理拦截 / 断网）' : '拉取失败：' + msg;
      byId('liveStatus').textContent = (isNetworkBlocked(msg)
        ? '⚠️ 当前环境无法访问外网（CloudStudio 沙箱 / 代理拦截 / 断网）。'
        : '更新失败：' + msg)
        + ' 获取真实数据请本机运行 node server/server.js 并访问 http://127.0.0.1:3000；或点「加载演示数据」预览完整闭环。';
    });
  }
  function syncFromBackend() {
    var base = backendBase();
    if (!base) return;
    fetch(base + '/api/data/latest').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d && d.dieselPrice != null) {
        applyServerData(d);
        byId('liveStatus').textContent = '已从后端同步最新数据 @ ' + (d.updatedAt || '') + (d.isDemo ? '（演示数据）' : '（真实源）');
      }
    }).catch(function () { /* 后端未启动则静默，使用本地基线 */ });
  }

  // ---------- 真实数据源预设（免 Key · 一键接入） ----------
  // map：通用字段映射（用于「按字段映射」路径，默认取首条）。
  // find：分省数组型源专用——按省份名在数组里定位并取柴油价（目标省份留空时回退到首条）。
  // 注意：这是「油价」源，只有柴油；充电价/加氢价不在油价数据里，不应从汽油价推断。
  var SOURCE_PRESETS = {
    openvan: {
      url: 'https://openvan.camp/api/fuel/prices',
      map: { dieselPrice: 'data.CN.prices.diesel' },
      note: 'OpenVan.camp 中的中国 CN 柴油价（实测约 8.31 元/L，实时、免 Key）。仅含柴油，充电价/加氢价不在油价源内——请到「数据基准」页手填，或在「字段映射」里指定其它源。浏览器可直连（免 Key）。'
    },
    xxapi: {
      url: 'https://v2.xxapi.cn/api/oilPrice',
      map: { dieselPrice: 'data.0.n0' },
      find: { array: 'data', field: 'regionName', diesel: 'n0' },
      note: 'xxapi 中国分省油价（n0=0#柴油，免 Key）。默认取返回数组首条省份；在「目标省份」填如「广东」即取该省柴油价。浏览器直连可能跨域，建议填 backendUrl 走后端代理（见 README）。'
    },
    ruseo: {
      url: 'https://api.ruseo.cn/api/oilprice',
      map: { dieselPrice: 'data.list.0.diesel_0' },
      find: { array: 'data.list', field: 'region', diesel: 'diesel_0' },
      note: '澄曜 中国分省油价（diesel_0=0#柴油，免 Key）。默认取首条省份；在「目标省份」填如「广东」即取该省。同理建议走后端代理规避跨域。'
    }
  };
  function applyPreset() {
    var k = byId('srcPreset').value;
    if (!k) { alert('请先选择一个数据源预设'); return; }
    var p = SOURCE_PRESETS[k];
    STATE.config.dataSourceUrl = p.url;
    STATE.config.dataSourceMap = Object.assign({}, p.map);
    STATE.config.activePreset = k;          // 记住当前预设，供按省份定位使用
    saveState(); renderEditor();
    var sel = byId('srcPreset'); if (sel) sel.value = k;
    byId('liveStatus').textContent = '已应用预设：' + p.note;
  }

  // ---------- 地图自动算里程 ----------
  // 注：高德 Web 服务相关代码（md5 / amapSig 等）已彻底移除，里程走免 Key 离线估算 + 免费地理编码。

  function setDistStatus(t) { var el = byId('distStatus'); if (el) el.textContent = t; }

  // 把用户输入（可能是「城市」或「省/市/区/街道/门牌」）解析为坐标：
  // 1) 精确匹配；2) 以已知城市名开头（如「广州市天河区」→「广州」）；3) 包含已知城市名。
  // 返回 { coord:'lng,lat', name:'展示名' } 或 null。
  function resolveCoord(input) {
    var q = (input || '').trim();
    if (!q) return null;

    // 第一优先级：区县/街道（含去后缀别名），因为它们比城市名更具体。
    // 例如「广州番禺大石街」会命中「番禺」而非「广州」，从而得到区县级坐标。
    var dist = window.DISTRICT_COORDS || {};
    var distBest = null, distLen = 0;
    Object.keys(dist).forEach(function (k) {
      if (q.indexOf(k) !== -1 && k.length > distLen) { distBest = k; distLen = k.length; }
    });
    if (distBest) return { coord: dist[distBest], name: distBest + '（由「' + q + '」识别）' };

    // 第二优先级：城市级坐标
    var city = window.CITY_COORDS || {};
    if (city[q]) return { coord: city[q], name: q };
    var best = null, bestLen = 0;
    Object.keys(city).forEach(function (k) {
      if (q.indexOf(k) === 0 && k.length > bestLen) { best = k; bestLen = k.length; }
    });
    if (!best) {
      Object.keys(city).forEach(function (k) {
        if (q.indexOf(k) !== -1 && k.length > bestLen) { best = k; bestLen = k.length; }
      });
    }
    if (best) return { coord: city[best], name: best + '（由「' + q + '」识别）' };
    return null;
  }

  // 提取两地址的最长公共片段（>=2字），用于同城/同区短途兜底估算
  function sharedRegion(a, b) {
    a = (a || '').trim(); b = (b || '').trim();
    if (!a || !b) return null;
    var best = null;
    for (var i = 0; i < a.length; i++) {
      for (var L = a.length - i; L >= 2; L--) {
        var sub = a.substr(i, L);
        if (b.indexOf(sub) !== -1) { if (!best || sub.length > best.length) best = sub; }
      }
    }
    // 过滤掉纯行政区划后缀（避免"市/区/镇"等过短无意义匹配）
    if (best && best.length >= 2 && !/^(省|市|区|县|镇|街道|路|号)$/.test(best)) return best;
    return null;
  }

  // 球面直线距离（km），输入 "lng,lat" 字符串
  function haversine(strA, strB) {
    var a = strA.split(','), b = strB.split(',');
    var R = 6371;
    var lat1 = (+a[1]) * Math.PI / 180, lat2 = (+b[1]) * Math.PI / 180;
    var dLat = ((+b[1]) - (+a[1])) * Math.PI / 180;
    var dLng = ((+b[0]) - (+a[0])) * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // —— 免费、免 Key 的联网地理编码与驾车路由（OpenStreetMap / OSRM 公共实例）——
  // 仅用于"详细地址 / 城市表未收录"时的精确补充；城市级仍走离线，零网络开销。
  function nominatimGeocode(q, cb) {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q);
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (arr) {
        if (Array.isArray(arr) && arr.length && arr[0].lon != null && arr[0].lat != null) cb(arr[0].lon + ',' + arr[0].lat);
        else cb(null);
      })
      .catch(function () { cb(null); });
  }
  // Photon（komoot 基于 OSM，免 Key、国内可访问、支持中文乡镇级地址）—— 作为首选地理编码器
  function photonGeocode(q, cb) {
    var url = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=1';
    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (j && j.features && j.features.length) {
          var c = j.features[0].geometry.coordinates; // [lon, lat]
          if (c && c.length >= 2 && c[0] != null && c[1] != null) { cb(c[0] + ',' + c[1]); return; }
        }
        cb(null);
      })
      .catch(function () { cb(null); });
  }
  // 地理编码调用链：Photon 与 Nominatim 并行竞速，任一成功即用；全部失败（含超时）才 null
  function geocode(q, cb) {
    var done = false;
    var t = setTimeout(function () { if (!done) { done = true; cb(null); } }, 3500);
    function finish(res) { if (done) return; done = true; clearTimeout(t); cb(res); }
    timedGeocode(photonGeocode, q, function (p) { if (p) finish(p); });
    timedGeocode(nominatimGeocode, q, function (n) { if (n) finish(n); });
  }
  // 给地理编码加超时兜底：沙箱/弱网环境下 fetch 可能既不 resolve 也不 reject（挂起），
  // 超时即视为失败，保证回调一定触发，里程计算不会永远"正在联网"。
  function timedGeocode(fn, q, cb, ms) {
    var done = false;
    var t = setTimeout(function () { if (!done) { done = true; cb(null); } }, ms || 4000);
    fn(q, function (res) {
      if (done) return;
      done = true; clearTimeout(t); cb(res);
    });
  }
  function osrmRoute(coordA, coordB, cb) {
    var url = 'https://router.project-osrm.org/route/v1/driving/' + coordA + ';' + coordB + '?overview=false';
    fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (j && j.routes && j.routes.length && j.routes[0].distance != null) cb(j.routes[0].distance); // 米
        else cb(null);
      })
      .catch(function () { cb(null); });
  }
  // 离线兜底：城市/区县坐标表 + 直线 × 道路系数
  function offlineSet(o, d, co, cd, opts) {
    opts = opts || {};
    var factor = STATE.config.roadFactor || 1.3;
    var km = Math.round(haversine(co, cd) * factor);
    if (!km && !opts.allowZero) {
      // 坐标重合（同城市/同区县）但用户填了详细地址，给一个可修改的同城短途默认值
      var shortKm = STATE.config.shortHaulKm || 25;
      byId('km').value = shortKm;
      setDistStatus('离线坐标重合，已按同城短途默认 ' + shortKm + ' km 估算（' + o + '→' + d + '，请按实际里程核对）。');
      renderResult(); return;
    }
    byId('km').value = km;
    setDistStatus('已估算里程（离线·直线×' + factor + '）：' + km + ' km（' + o + '→' + d + '）');
    renderResult();
  }

  function calcDistance() {
    var base = backendBase();
    var o = byId('startCity').value.trim();
    var d = byId('endCity').value.trim();
    if (!o || !d) { alert('请填写起点和终点（可填城市，也可填到街道/门牌以便更精确）'); return; }

    // 后端模式：免 Key 离线估算里程（起 server 即可），前端只传地址
    if (base) {
      setDistStatus('正在查询里程（后端）…');
      fetch(base + '/api/route?origin=' + encodeURIComponent(o) + '&destination=' + encodeURIComponent(d))
        .then(function (r) { return r.json().then(function (j) { return r.ok ? j : Promise.reject(new Error(j.error || ('HTTP ' + r.status))); }); })
        .then(function (res) {
          byId('km').value = res.distanceKm;
          setDistStatus('已更新里程：' + res.distanceKm + ' km（' + o + '→' + d + '）');
          renderResult();
        })
        .catch(function (e) { setDistStatus('后端调用失败：' + e.message + '（确认 server 已启动、backendUrl 正确）'); });
      return;
    }

    var mode = STATE.config.distanceMode || 'auto';
    // 智能识别地址中的城市/区县名 → 离线坐标（街道/区/门牌也能秒出，免网免 Key）
    var ro = resolveCoord(o), rd = resolveCoord(d);

    // 离线模式：直接走离线估算（即使坐标重合也接受 0，由用户手动核对）
    if (ro && rd && mode === 'offline') {
      offlineSet(ro.name, rd.name, ro.coord, rd.coord, { allowZero: true });
      return;
    }

    // 自动/街道模式：离线坐标不同，直接用离线估算（区县级优先，无需联网）
    if (ro && rd && mode !== 'street' && ro.coord !== rd.coord) {
      offlineSet(ro.name, rd.name, ro.coord, rd.coord);
      return;
    }

    // 街道级模式，或自动模式下坐标重合（同城同区县），尝试联网精确路由；失败则同城短途兜底
    setDistStatus('正在联网获取精确里程（免费·免 Key）…');

    function onlinePath(geoO, labelO, geoD, labelD) {
      osrmRoute(geoO, geoD, function (distM) {
        if (distM && distM > 0) {
          var kmr = Math.round(distM / 1000);
          byId('km').value = kmr;
          setDistStatus('已更新里程（OSRM 驾车·免费免 Key）：' + kmr + ' km（' + labelO + '→' + labelD + '）');
          renderResult();
        } else {
          // 路由服务不可用：退而用地理编码坐标算直线×系数兜底
          var factor2 = STATE.config.roadFactor || 1.3;
          var km2 = Math.round(haversine(geoO, geoD) * factor2);
          byId('km').value = km2;
          setDistStatus('已估算里程（联网坐标·直线×' + factor2 + '，路由服务暂不可用）：' + km2 + ' km（' + labelO + '→' + labelD + '）');
          renderResult();
        }
      });
    }

    geocode(o, function (ca) {
      if (!ca) {
        if (ro && rd) { offlineSet(ro.name, rd.name, ro.coord, rd.coord); return; }
        // 同城/短途兜底：两端地址共享同一区/县名（如都含「顺德」）则给保守短途估算
        var shared = sharedRegion(o, d);
        if (shared) {
          var shortKm = STATE.config.shortHaulKm || 30;
          byId('km').value = shortKm;
          setDistStatus('未能联网获取精确坐标，已按同城短途估算（' + shared + ' 范围内，默认 ' + shortKm + ' km，请核对）。');
          renderResult(); return;
        }
        setDistStatus('联网地理编码失败（' + o + '）：请检查地址拼写，或改为「仅离线」模式并用城市名（如 广州）。'); return;
      }
      geocode(d, function (cb2) {
        if (!cb2) {
          if (ro && rd) { offlineSet(ro.name, rd.name, ro.coord, rd.coord); return; }
          var shared2 = sharedRegion(o, d);
          if (shared2) {
            var shortKm2 = STATE.config.shortHaulKm || 30;
            byId('km').value = shortKm2;
            setDistStatus('未能联网获取精确坐标，已按同城短途估算（' + shared2 + ' 范围内，默认 ' + shortKm2 + ' km，请核对）。');
            renderResult(); return;
          }
          setDistStatus('联网地理编码失败（' + d + '）：请检查地址拼写，或改为「仅离线」模式并用城市名。'); return;
        }
        onlinePath(ca, o, cb2, d);
      });
    });
  }

  // ---------- 回程货池与自动匹配 ----------
  function returnCargoRevenue(c, roundKm) {
    if (c.rateMode === 'perKm') return Math.round((+c.price) * roundKm);
    return Math.round(+c.price);
  }
  function rcVehicleLabel(id) {
    if (id === 'any') return '不限车型';
    var v = STATE.vehicles.filter(function (x) { return x.id === id; })[0];
    return v ? v.name : id;
  }
  // 地址匹配：货池里存的是城市名，用户输入可能是"广州市天河区…"，双向包含即可匹配
  function addrMatch(city, addr) {
    if (!city || !addr) return false;
    return addr.indexOf(city) >= 0 || city.indexOf(addr) >= 0;
  }
  // 在「评估」页按 终点→起点 且 车型匹配 找出回程货源
  function matchReturnCargos() {
    var area = byId('returnMatchArea');
    if (!area) { alert('回程货匹配区域未加载，请刷新页面（建议清缓存后硬性刷新）后重试。'); return; }
    // 立即给出可见反馈，避免"点击无反应"的错觉
    area.innerHTML = '<p class="hint">正在匹配回程货池…</p>';
    try {
      var o = byId('startCity').value.trim();
      var d = byId('endCity').value.trim();
      var vid = byId('vehicle').value;
      if (!o || !d) { area.innerHTML = '<p class="hint">先填写起点与终点（城市或详细地址），系统才能匹配回程货源。</p>'; return; }
      if (!STATE.returnCargos || !STATE.returnCargos.length) {
        area.innerHTML =
          '<div class="source-box" style="border-color:var(--warn);">' +
            '<b>回程货池为空</b><br>' +
            '<span>匹配回程货源前，需要先有一份「可带回程货」。任选一种方式：</span><br>' +
            '<button class="btn" data-seedrc style="margin-top:8px;">▶ 载入示例回程货（武汉→广州 等）</button> ' +
            '<button class="btn" data-addroute style="margin-top:8px;">＋ 把当前路线加为回程货</button><br>' +
            '<span class="muted">提示：示例货仅作演示，可到「回程货」页删除；若不想带回程货，保持「回程货收入 = 0」即可。</span>' +
          '</div>';
        return;
      }
      var km = Math.max(0, parseFloat(byId('km').value) || 0);
      var roundKm = km * 2;
      var matches = STATE.returnCargos.filter(function (c) {
        return addrMatch(c.origin, d) && addrMatch(c.dest, o) && (c.vehicleId === vid || c.vehicleId === 'any');
      });
      if (!matches.length) {
        area.innerHTML =
          '<div class="source-box" style="border-color:var(--warn);">' +
            '<b>货池中暂无「' + d + '→' + o + '」且车型匹配的回程货源</b><br>' +
            '<span class="muted">已检查 ' + STATE.returnCargos.length + ' 条回程货。你可以：</span><br>' +
            '<button class="btn" data-addroute style="margin-top:8px;">＋ 把当前路线（' + d + '→' + o + '）加为回程货</button> ' +
            '<button class="btn" data-seedrc style="margin-top:8px;">▶ 载入示例回程货</button><br>' +
            '<span class="muted">或到「回程货」页添加；不带回程货则「回程货收入」保持 0。</span>' +
          '</div>';
        return;
      }
      var html = '<p class="hint">找到 ' + matches.length + ' 条匹配回程货源（' + d + '→' + o + '，回程里程约 ' + fmt(roundKm) + ' km）：</p>';
      html += matches.map(function (c) {
        var rev = returnCargoRevenue(c, roundKm);
        var rate = c.rateMode === 'perKm' ? ('¥' + fmt(c.price) + '/km × ' + fmt(roundKm) + 'km = ') : '一口价 ';
        return '<div class="source-box" style="margin:8px 0;">' +
          '<b>' + (c.label || '-') + '</b>　' + rcVehicleLabel(c.vehicleId) + (c.weight ? (' · ' + c.weight + 't') : '') + '<br>' +
          '计费：' + rate + '<b>¥' + fmt(rev) + '</b>' +
          (c.note ? ('<br><span class="muted">' + c.note + '</span>') : '') +
          ' <button class="btn" data-applyrc="' + STATE.returnCargos.indexOf(c) + '" style="margin-top:6px;">应用此回程收入</button>' +
          '</div>';
      }).join('');
      area.innerHTML = html;
    } catch (e) {
      area.innerHTML = '<p class="hint" style="color:var(--bad);">匹配出错：' + (e && e.message ? e.message : e) + '</p>';
    }
  }
  // 把 DEFAULTS 内置的示例回程货（武汉→广州 等）补进当前货池（去重），返回新增条数
  function seedSampleReturnCargos() {
    var samples = (window.DEFAULTS && window.DEFAULTS.returnCargos) || [];
    var added = 0;
    samples.forEach(function (c) {
      var dup = STATE.returnCargos.some(function (x) {
        return x.label === c.label && x.origin === c.origin && x.dest === c.dest;
      });
      if (!dup) { STATE.returnCargos.push(JSON.parse(JSON.stringify(c))); added++; }
    });
    if (added) { saveState(); if (typeof renderReturnPool === 'function') renderReturnPool(); }
    return added;
  }
  // 把当前评估路线（终点→起点，即回程方向）直接加为一条回程货，方便即时试算
  function addCurrentRouteAsCargo() {
    var o = byId('startCity').value.trim();
    var d = byId('endCity').value.trim();
    if (!o || !d) { alert('请先填写起点与终点城市。'); return 0; }
    STATE.returnCargos.push({
      origin: d, dest: o, vehicleId: 'any', rateMode: 'perKm', price: 2.5,
      label: d + '→' + o + ' 回程', weight: '', note: '由「匹配回程货池」自动添加，请到「回程货」页完善价格'
    });
    saveState(); if (typeof renderReturnPool === 'function') renderReturnPool();
    return 1;
  }
  function initReturnPool() {
    var sel = byId('rcVehicle');
    sel.innerHTML = '';
    var any = document.createElement('option'); any.value = 'any'; any.textContent = '不限车型'; sel.appendChild(any);
    STATE.vehicles.forEach(function (v) { var o = document.createElement('option'); o.value = v.id; o.textContent = v.name; sel.appendChild(o); });
    byId('btnSaveRc').addEventListener('click', saveReturnCargo);
    byId('rcTable').addEventListener('click', function (e) { if (e.target.dataset.delrc != null) deleteReturnCargo(+e.target.dataset.delrc); });
  }
  function saveReturnCargo() {
    var label = byId('rcLabel').value.trim();
    var origin = byId('rcOrigin').value.trim();
    var dest = byId('rcDest').value.trim();
    var price = +byId('rcPrice').value || 0;
    if (!label || !origin || !dest || price <= 0) { byId('rcStatus').textContent = '请填写名称、起运/目的城市、价格'; return; }
    STATE.returnCargos.push({
      id: 'rc' + Date.now(),
      label: label, origin: origin, dest: dest,
      vehicleId: byId('rcVehicle').value,
      rateMode: byId('rcRate').value,
      price: price,
      weight: +byId('rcWeight').value || 0,
      note: byId('rcNote').value.trim()
    });
    saveState(); renderReturnPool();
    byId('rcStatus').textContent = '已加入货池（共 ' + STATE.returnCargos.length + ' 条）';
  }
  function deleteReturnCargo(idx) {
    if (idx < 0 || idx >= STATE.returnCargos.length) return;
    STATE.returnCargos.splice(idx, 1);
    saveState(); renderReturnPool();
  }
  function renderReturnPool() {
    byId('rcCount').textContent = STATE.returnCargos.length;
    if (!STATE.returnCargos.length) { byId('rcTable').innerHTML = '<p class="muted">货池为空。添加回程货源后，可在「评估」页自动匹配。</p>'; return; }
    var head = '<table class="detail log-table"><tr><th>货源</th><th>线路</th><th>车型</th><th>计费</th><th>价格</th><th></th></tr>';
    var body = STATE.returnCargos.map(function (c, i) {
      var rate = c.rateMode === 'perKm' ? ('¥' + fmt(c.price) + '/km') : ('¥' + fmt(c.price) + ' 一口价');
      return '<tr><td>' + (c.label || '-') + (c.note ? ('<br><span class="muted">' + c.note + '</span>') : '') + '</td>' +
        '<td>' + c.origin + '→' + c.dest + '</td><td>' + rcVehicleLabel(c.vehicleId) + '</td><td>' + rate + '</td><td>¥' + fmt(c.price) + '</td>' +
        '<td><button class="link" data-delrc="' + i + '">删</button></td></tr>';
    }).join('');
    byId('rcTable').innerHTML = head + body + '</table>';
  }

  // ---------- Tabs ----------
  function switchTab(name) {
    ['eval', 'data', 'live', 'return', 'calib', 'doc'].forEach(function (t) {
      var tab = byId('tab-' + t); if (tab) tab.classList.toggle('active', t === name);
      var panel = byId('panel-' + t); if (panel) panel.style.display = (t === name) ? 'block' : 'none';
    });
    // 切回评估页时用最新「数据基准」重算（改完基线后无需手动改表单字段）
    if (name === 'eval' && formReady) renderResult();
  }

  function byId(id) { return document.getElementById(id); }
  // 安全写入输入框值：元素缺失也不抛错
  function sv(id, v) { var e = byId(id); if (e) e.value = v; }
  // 空值安全的事件绑定：元素缺失也不抛错，避免一个坏元素连累整组按钮「无反应」
  function bind(id, evt, fn) {
    var el = byId(id);
    if (el) el.addEventListener(evt, fn);
    return el;
  }

  // ---------- 初始化 ----------
  // 分段防崩：任何一步出错都不影响其他步骤，且页面永不白屏
  function safe(label, fn) {
    try { fn(); } catch (e) {
      console.error('[init:' + label + ']', e);
      var box = byId('initErrors');
      if (box) {
        box.style.display = 'block';
        box.textContent += '初始化[' + label + ']出错：' + (e && e.message ? e.message : e) + '\n';
      }
    }
  }

  function init() {
    // 1. 先绑定 Tab 切换并显示默认页 —— 保证页面永不空白
    ['eval', 'data', 'live', 'return', 'calib', 'doc'].forEach(function (t) {
      var el = byId('tab-' + t); if (el) el.addEventListener('click', function () { switchTab(t); });
    });
    switchTab('eval');

    // 1.5 关键交互的无条件绑定（不依赖任何后续模块，避免被初始化错误跳过）
    var btnMatch = byId('btnMatchReturn');
    if (btnMatch) btnMatch.addEventListener('click', matchReturnCargos);
    var btnRecalc = byId('btnRecalc');
    if (btnRecalc) btnRecalc.addEventListener('click', recalc);
    var cbMonth = byId('cbMonthlyMode');
    if (cbMonth) cbMonth.addEventListener('change', toggleMonthlyMode);
    // 一键纯底价：关闭全部可选成本（6项）+ 月固定成本分摊，仅保留油费+路费+司机
    var btnSimplify = byId('btnSimplify');
    if (btnSimplify) btnSimplify.addEventListener('click', function () {
      var o = STATE.other;
      o.insuranceEnabled = false; o.brokerEnabled = false; o.miscEnabled = false;
      o.riskEnabled = false; o.tireEnabled = false; o.loadingEnabled = false;
      STATE.config.fixedCostEnabled = false;
      saveState(); renderEditor(); renderResult();
      alert('已精简为纯运输底价：仅保留油费 + 过路费 + 司机人工三项核心成本，并已关闭月固定成本分摊。税务开关不受影响，可单独再开。');
    });
    // 恢复全部可选成本开关 + 月固定分摊
    var btnRestore = byId('btnRestoreCosts');
    if (btnRestore) btnRestore.addEventListener('click', function () {
      var o = STATE.other;
      o.insuranceEnabled = true; o.brokerEnabled = true; o.miscEnabled = true;
      o.riskEnabled = true; o.tireEnabled = true; o.loadingEnabled = true;
      STATE.config.fixedCostEnabled = true;
      saveState(); renderEditor(); renderResult();
    });
    var matchArea = byId('returnMatchArea');
    if (matchArea) matchArea.addEventListener('click', function (e) {
      if (e.target.dataset.applyrc != null) {
        var idx = +e.target.dataset.applyrc;
        var c = STATE.returnCargos[idx];
        if (!c) return;
        var km = Math.max(0, parseFloat(byId('km').value) || 0);
        var rev = returnCargoRevenue(c, km * 2);
        byId('returnRevenue').value = rev;
        renderResult();
        matchArea.insertAdjacentHTML('beforeend',
          '<p class="hint">已应用「' + (c.label || '回程货') + '」回程收入 ¥' + fmt(rev) + '。</p>');
      } else if (e.target.dataset.seedrc != null) {
        var n = seedSampleReturnCargos();
        matchArea.innerHTML = '<p class="hint">已载入 ' + n + ' 条示例回程货，正在重新匹配…</p>';
        matchReturnCargos();
      } else if (e.target.dataset.addroute != null) {
        addCurrentRouteAsCargo();
        matchReturnCargos();
      }
    });

    // 2. 表单构建（后续绑定依赖它创建的选项）
    safe('buildForm', function () {
      buildForm();
      ['province', 'vehicle', 'energy', 'mode', 'month', 'km', 'price', 'weight', 'volume', 'returnRevenue'].forEach(function (id) {
        var el = byId(id); if (!el) return;
        el.addEventListener('input', renderResult);
        el.addEventListener('change', renderResult);
      });
      byId('vehicle').addEventListener('change', syncEnergyOptions);
      byId('mode').addEventListener('change', toggleWeight);
    });

    // 3. 各功能模块绑定（互不影响）
    // 3.0 先无条件绑定「高级」三个按钮，绝不依赖 bindEditor 成功，避免被初始化错误跳过 → “无反应”
    safe('editor-buttons', function () {
      byId('btnReset').addEventListener('click', resetData);
      byId('btnExport').addEventListener('click', exportJson);
      byId('btnImport').addEventListener('click', importJson);
    });
    safe('editor', function () {
      bindEditor();
    });
    safe('live', function () {
      byId('btnLive').addEventListener('click', liveUpdate);
      byId('btnTestSrc').addEventListener('click', testSource);
      byId('btnApplyPreset').addEventListener('click', applyPreset);
      byId('btnLoadDemo').addEventListener('click', loadDemoData);
    });
    safe('distance', function () {
      byId('btnDist').addEventListener('click', calcDistance);
    });
    safe('calib', function () {
      initCalibForm();
      byId('btnSaveLog').addEventListener('click', saveLog);
      byId('btnCalibrate').addEventListener('click', recomputeCalibration);
      byId('btnClearCalib').addEventListener('click', clearCalibration);
      byId('logTable').addEventListener('click', function (e) {
        if (e.target.dataset.del != null) deleteLog(+e.target.dataset.del);
      });
    });
    safe('return', function () {
      initReturnPool();
      renderReturnPool();
      ['startCity', 'endCity', 'vehicle'].forEach(function (id) {
        byId(id).addEventListener('change', function () { if (STATE.returnCargos.length) matchReturnCargos(); });
      });
    });

    // 4. 首次渲染
    safe('live-init', function () { ensureLiveSource(); });   // 首次自动预置 OpenVan，开箱即用
    safe('render', function () { renderEditor(); });
    safe('render', function () { renderResult(); });
    safe('render', function () { renderCalib(); });
    safe('backend', function () { syncFromBackend(); });
  }

  // 页面级兜底：任何未捕获错误显示在页面上，不再静默白屏
  window.onerror = function (msg, src, line) {
    var box = byId('initErrors');
    if (box) { box.style.display = 'block'; box.textContent += '运行错误：' + msg + ' (' + line + ')\n'; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
