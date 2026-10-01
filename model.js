/* 物流运价评估系统 - 评估引擎（纯函数，无 DOM 依赖，可在 Node 中单测）
 * 暴露 window.LRE / global.LRE：
 *   LRE.evaluate(STATE, f) -> 完整结果对象
 *   LRE.compute(STATE, f)   -> 不含保本/建议报价求解的结果（供内部复用）
 * 设计要点（实战化）：
 *   1) 含税/税务真实化：收入价税分离（销项9%），能源/过路费进项抵扣，增值税=销项-进项（可留抵），
 *      附加税(城建+教育≈12%)，可选企业所得税；输出「税后净利」与「净利率」。
 *   2) 载重与满载率：车型 capacity/volume vs 输入货重/方量，校验装得下、算满载率、吨公里成本。
 *   3) 固定成本+月度运营：月固定成本按「月均趟数」分摊到单趟；输出单趟净利、月利润、月盈亏平衡趟数。
 *   4) 完整成本科目：能源/过路/司机/轮胎保险/装卸 + 居间信息费 + 停车过磅杂费 + 货损理赔准备金。
 *   5) 保本运价与建议报价：数值搜索使「税后净利=0 / 达净利率阈值」。
 *   6) 敏感度：能源价+10%、无回程收入 对税后净利的影响。
 */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : (typeof global !== 'undefined' ? global : this);

  function num(x, d) { var n = parseFloat(x); return isFinite(n) ? n : (d || 0); }
  function max0(x) { return x > 0 ? x : 0; }

  // 价税分离：已知含税金额与税率，返回 {incl, excl, vat}
  function splitTax(incl, rate) {
    var vat = incl * rate / (1 + rate);
    return { incl: incl, excl: incl - vat, vat: vat };
  }

  function calibKey(f) {
    return (f.vehicleId || '?') + '|' + (f.energy || '?') + '|' + (f.mode || '?');
  }

  // ---------- 核心计算（不含保本/建议报价求解） ----------
  function compute(STATE, f) {
    var D = root.DEFAULTS || {};
    var v = STATE.vehicles.filter(function (x) { return x.id === f.vehicleId; })[0];
    if (!v) return { error: '请选择车型' };

    var km = max0(num(f.km));
    var roundKm = km * 2;                                   // 往返里程（车辆需返回）
    var kmPerDay = v.kmPerDay || 400;
    var days = Math.max(1, Math.ceil(roundKm / kmPerDay));  // 司机往返总天数
    var energy = f.energy;                                  // '油' | '电' | '氢电'
    var cfg = STATE.config || {};
    var tax = (cfg.tax && cfg.tax.enabled) ? cfg.tax : null;
    var other = STATE.other || {};
    // —— 月总收入测算模式（可选）：勾选后用「月总收入÷本月趟数」折算等效单趟运价复用主流程 ——
    var monthlyMode = !!f.monthlyMode;
    var mTrips = 0, mRevenueIncl = 0;
    if (monthlyMode) {
      var mPerMonth = Math.max(1, num(cfg.tripsPerMonth, 22));
      mTrips = Math.max(1, num(f.monthlyTrips) || mPerMonth);
      mRevenueIncl = max0(num(f.monthlyRevenue));
      // 折算等效单趟含税运价（回程已并入月总收入，故置 0），后续逻辑全部复用
      f = Object.assign({}, f, {
        price: mTrips > 0 ? mRevenueIncl / mTrips : 0,
        returnRevenue: 0
      });
    }
    var provFactor = (STATE.provinceFactor && STATE.provinceFactor[f.province]) || 1;
    var tollRate = (STATE.tollClasses && STATE.tollClasses[v.toll] || 0) * provFactor;

    // 能源费（含税），拆分柴油/电/氢，便于进项抵扣
    var eDiesel = 0, eElec = 0, eHydro = 0;
    var EP = STATE.energy || {};
    if (energy === '油') {
      eDiesel = num(EP.dieselPrice) * (v.fuel / 100) * roundKm;
    } else if (energy === '氢电') {
      eHydro = num(EP.hydrogenPrice) * (num(v.hydrogen) / 100) * roundKm;
      eElec  = num(EP.electricityPrice) * (num(v.elec) / 100) * roundKm;
    } else {
      eElec  = num(EP.electricityPrice) * (num(v.elec) / 100) * roundKm;
    }
    var energyCost = eDiesel + eElec + eHydro;

    var tollCost = tollRate * roundKm;
    // 司机人工 = 日工资 × 往返天数（日工资已含补贴/吃住，运价评估不单列餐补）
    var driverCost = num(v.wage) * days;

    // 轮胎/维修、保险分摊、装卸费 均为可选成本，可单独开关（关闭即不计）
    var tireOn = (other.tireEnabled !== false);
    var insuranceOn = (other.insuranceEnabled !== false);
    var loadingOn = (other.loadingEnabled !== false);
    var tire = tireOn ? ((energy === '油') ? num(other.tireRepairPerKmOil) : num(other.tireRepairPerKmElec)) : 0;
    var insuranceCost = insuranceOn ? num(other.insurancePerKm) : 0;
    var loading = loadingOn ? ((other.loadingByMode && other.loadingByMode[f.mode]) || 0) : 0;
    if (f.mode === '零担') loading = loading * max0(num(f.weight));
    var otherVar = (tire + insuranceCost) * roundKm + loading;

    // —— 实战新增成本科目（均按去程运价计提，回程收入不计提居间/风险） ——
    var price = max0(num(f.price));                        // 去程运价（用户输入，可能含税）
    var returnRev = max0(num(f.returnRevenue));             // 回程收入
    var brokerOn = (other.brokerEnabled !== false);
    var miscOn = (other.miscEnabled !== false);
    var riskOn = (other.riskEnabled !== false);
    var broker = brokerOn ? price * num(other.brokerPct) : 0;        // 居间/信息费
    var misc = miscOn ? num(other.miscPerTrip) : 0;                  // 停车/过磅/装卸杂费 元/趟
    var risk = riskOn ? price * num(other.riskPct) : 0;              // 货损/理赔准备金

    var seasonArr = (STATE.season && STATE.season.monthly) || [];
    var seasonCoef = seasonArr.length ? seasonArr[((parseInt(f.month, 10) - 1 + 12) % 12)] : 1;
    if (!seasonCoef || !isFinite(seasonCoef)) seasonCoef = 1;

    // 细分校准：优先套用「车型·能源·模式」分组系数，否则回退全局系数
    var calibGroup = null, calibration = 1, ck;
    if (!(f && f.raw)) {
      ck = calibKey(f);
      calibGroup = (STATE.calibrations && STATE.calibrations[ck]) || null;
      calibration = calibGroup ? calibGroup.coef : (STATE.calibration || 1);
    }

    // 变动成本（含税）小计，受淡旺季系数 + 校准系数影响
    var variableIncl = (energyCost + tollCost + driverCost + otherVar + broker + misc + risk) * seasonCoef * calibration;

    // 固定成本分摊（月度）—— 可单独开关：关闭则单趟成本不含固定分摊（看纯运输贡献）
    var fixedCostOn = (cfg.fixedCostEnabled !== false);
    var tripsPerMonth = Math.max(1, num(cfg.tripsPerMonth, 22));
    var monthlyFixed = num(v.monthlyFixed);
    var perTripFixed = fixedCostOn ? (monthlyFixed / tripsPerMonth) : 0;

    // 单趟总成本（含税，含固定分摊；不含税务负债——税单独算）
    var totalCost = variableIncl + perTripFixed;

    // ---------- 收入与税务 ----------
    var priceIncludeVat = (cfg.priceIncludeVat !== false); // 默认含税
    var vatRate = tax ? num(tax.vatRate, 0.09) : 0;
    var revenueIncl = price + returnRev;                   // 含税总收入
    var revSplit = priceIncludeVat
      ? splitTax(revenueIncl, vatRate)
      : { incl: revenueIncl, excl: revenueIncl - revenueIncl * vatRate, vat: revenueIncl * vatRate };
    var outputVat = revSplit.vat;
    var revenueExcl = revSplit.excl;

    // 进项税（仅能源柴油/电/氢 与 过路费 可抵扣）
    var inputVat = 0;
    if (tax) {
      var dV = num(tax.dieselInputVat, 0.13), eV = num(tax.elecInputVat, 0.13),
          hV = num(tax.hydroInputVat, 0.13), tV = num(tax.tollInputVat, 0.09);
      inputVat += eDiesel * dV / (1 + dV);
      inputVat += eElec  * eV / (1 + eV);
      inputVat += eHydro * hV / (1 + hV);
      inputVat += tollCost * tV / (1 + tV);
    }
    var vatPayable = max0(outputVat - inputVat);           // 本月应纳增值税（可留抵）
    var carryForward = max0(inputVat - outputVat);          // 进项留抵
    var surtaxRate = tax ? num(tax.surtaxRate, 0.12) : 0;
    var surtax = vatPayable * surtaxRate;

    // 不含税成本 = 含税变动成本 − 对应进项 + 固定分摊（固定无进项）
    var costExcl = (variableIncl - inputVat) + perTripFixed;
    var pretaxProfit = revenueExcl - costExcl;              // 会计税前利润
    var incomeTaxRate = tax ? num(tax.incomeTaxRate, 0) : 0;
    var incomeTax = incomeTaxRate > 0 ? max0(pretaxProfit) * incomeTaxRate : 0;
    var netProfit = pretaxProfit - vatPayable - surtax - incomeTax;  // 税后净利

    var threshold = num(cfg.profitThreshold, 0.08);
    var netMargin = revenueIncl > 0 ? netProfit / revenueIncl : 0;

    // 决策：基于税后净利 / 净利率
    var decision, decisionClass;
    if (revenueIncl <= 0) { decision = '请填写客户运价'; decisionClass = 'warn'; }
    else if (netProfit < 0) { decision = '不接·税后亏损'; decisionClass = 'bad'; }
    else if (netMargin >= threshold) { decision = '可接单'; decisionClass = 'ok'; }
    else { decision = '利润偏薄·建议议价'; decisionClass = 'warn'; }

    // ---------- 载重 / 满载率 ----------
    var weight = max0(num(f.weight));
    var volume = max0(num(f.volume));
    var capacity = num(v.capacity);
    var volumeCap = num(v.volume);
    var loadFactorW = (capacity > 0) ? weight / capacity : null;
    var loadFactorV = (volume > 0 && volumeCap > 0) ? volume / volumeCap : null;
    var loadFactor = (loadFactorW != null && (loadFactorV == null || loadFactorW >= loadFactorV))
      ? loadFactorW : loadFactorV;
    var fits = (capacity > 0) ? (weight <= capacity) : true;
    var tonKmCost = (weight > 0 && roundKm > 0) ? (costExcl - perTripFixed) / (weight * roundKm) : null;

    // ---------- 月度运营 ----------
    // 单趟净利（不含固定分摊）= 不含税收入 − 不含税变动 − 单趟税额
    var perTripTax = vatPayable + surtax + incomeTax;
    var perTripNetExclFixed = revenueExcl - (variableIncl - inputVat) - perTripTax;
    var monthlyNetProfit = tripsPerMonth * netProfit;
    var monthlyRevenue = tripsPerMonth * revenueIncl;
    var monthlyBreakEvenTrips = (perTripNetExclFixed > 0) ? Math.ceil(monthlyFixed / perTripNetExclFixed) : Infinity;

    var res = {
      v: v, km: km, roundKm: roundKm, days: days, seasonCoef: seasonCoef, energy: energy,
      eDiesel: eDiesel, eElec: eElec, eHydro: eHydro, energyCost: energyCost,
      tollCost: tollCost, driverCost: driverCost, otherVar: otherVar,
      broker: broker, misc: misc, risk: risk,
      insuranceOn: insuranceOn, brokerOn: brokerOn, miscOn: miscOn, riskOn: riskOn,
      tireOn: tireOn, loadingOn: loadingOn,
      variableIncl: variableIncl, monthlyFixed: monthlyFixed, tripsPerMonth: tripsPerMonth,
      perTripFixed: perTripFixed, fixedCostOn: fixedCostOn, totalCost: totalCost,
      revenueIncl: revenueIncl, returnRev: returnRev, revenueExcl: revenueExcl,
      outputVat: outputVat, inputVat: inputVat, vatPayable: vatPayable, carryForward: carryForward,
      surtax: surtax, incomeTax: incomeTax, pretaxProfit: pretaxProfit, netProfit: netProfit,
      priceIncludeVat: priceIncludeVat, vatRateUsed: vatRate,
      weight: weight, volume: volume, capacity: capacity, volumeCap: volumeCap,
      loadFactorW: loadFactorW, loadFactorV: loadFactorV, loadFactor: loadFactor, fits: fits, tonKmCost: tonKmCost,
      threshold: threshold, netMargin: netMargin,
      decision: decision, decisionClass: decisionClass,
      perTripTax: perTripTax, perTripNetExclFixed: perTripNetExclFixed,
      monthlyNetProfit: monthlyNetProfit, monthlyRevenue: monthlyRevenue,
      monthlyBreakEvenTrips: monthlyBreakEvenTrips,
      calibration: calibration, calibKey: ck,
      calibLabel: calibGroup ? calibGroup.label : null
    };
    // 月度模式：在等效单趟结果之上，叠加月度口径汇总（单趟模式 res 原样返回，零影响）
    if (monthlyMode) {
      res.monthlyMode = true;
      res.monthlyRevenue = mRevenueIncl;
      res.monthlyTrips = mTrips;
      res.monthlyPerDayNet = netProfit * mTrips / 30;
      res.mOutputVat = outputVat * mTrips;
      res.mInputVat = inputVat * mTrips;
      res.mVatPayable = vatPayable * mTrips;
      res.mCarryForward = carryForward * mTrips;
      res.mSurtax = surtax * mTrips;
      res.mIncomeTax = incomeTax * mTrips;
      res.mPretaxProfit = pretaxProfit * mTrips;
      res.mNetProfit = netProfit * mTrips;
      res.monthlyNetProfit = netProfit * mTrips;
    }
    return res;
  }

  // 数值搜索使「税后净利」达到目标（保本=0；建议=净利率阈值×含税收入）
  function solvePrice(STATE, f, base, kind) {
    var lo = 0, hi = 5e7;
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      var c = compute(STATE, Object.assign({}, f, { price: mid }));
      var g;
      if (kind === 'breakeven') g = c.netProfit - 0;
      else g = c.netProfit - base.threshold * (mid + (parseFloat(f.returnRevenue) || 0));
      if (!isFinite(g)) { lo = mid; break; }
      if (g < 0) lo = mid; else hi = mid;
    }
    return Math.round((lo + hi) / 2);
  }

  // 敏感度分析（相对当前净利的变动；月度模式输出月度口径差额）
  function sensitivity(STATE, f, base) {
    var out = {};
    var baseNet = f.monthlyMode ? (base.mNetProfit != null ? base.mNetProfit : base.netProfit * 30) : base.netProfit;
    function pick(c) { return f.monthlyMode ? (c.mNetProfit != null ? c.mNetProfit : c.netProfit * 30) : c.netProfit; }
    // 能源价 +10%：克隆 STATE 临时上调柴油价
    var S2 = Object.assign({}, STATE);
    S2.energy = Object.assign({}, STATE.energy, { dieselPrice: num(STATE.energy.dieselPrice) * 1.1 });
    var cDiesel = compute(S2, f);
    out.dieselUp10 = pick(cDiesel) - baseNet;
    // 无回程收入
    var cNoRet = compute(STATE, Object.assign({}, f, { returnRevenue: 0 }));
    out.noReturn = pick(cNoRet) - baseNet;
    // 运价 -5%（月度模式转为月总收入 -5%）
    var cDown = f.monthlyMode
      ? compute(STATE, Object.assign({}, f, { monthlyRevenue: num(f.monthlyRevenue) * 0.95 }))
      : compute(STATE, Object.assign({}, f, { price: num(f.price) * 0.95 }));
    out.priceDown5 = pick(cDown) - baseNet;
    return out;
  }

  function evaluate(STATE, f) {
    var o = compute(STATE, f);
    if (o.error) return o;
    o.breakEvenPrice = solvePrice(STATE, f, o, 'breakeven');
    o.suggestedPrice = solvePrice(STATE, f, o, 'threshold');
    o.sens = sensitivity(STATE, f, o);
    return o;
  }

  root.LRE = { evaluate: evaluate, compute: compute, splitTax: splitTax, calibKey: calibKey };
})();
