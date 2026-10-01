/* 智卡运价评估系统 - 核心公式 Node 单测 (版本 ab：实测锚点重算能耗) */
global.window = global;

var fs = require('fs');
eval(fs.readFileSync(__dirname + '/data.js', 'utf8'));
eval(fs.readFileSync(__dirname + '/model.js', 'utf8'));

var STATE = JSON.parse(JSON.stringify(window.DEFAULTS));
STATE.calibration = 1;
STATE.calibrations = {};

var fuelPrice = STATE.energy.dieselPrice; // 8.00 元/L
function unitPriceOil(v) { return v.fuel / 100 * fuelPrice; }

console.log('=== 油车单价梯度校验（元/km，柴油价 ' + fuelPrice + ' 元/L，油价统一）===');
// 基准：9.6m 实测 18-20L/100km ≈ 1.5-1.6 元/km；其他车型按真实满载油耗比例推算
var expect = { v42: 0.88, v68: 1.20, v76: 1.36, v96: 1.52, v13: 2.56, v175: 3.04 };
var fail = 0;
STATE.vehicles.forEach(function (v) {
  var up = unitPriceOil(v);
  var ok = Math.abs(up - expect[v.id]) < 0.01;
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : '!!  ') + v.name + '  fuel=' + v.fuel + '  单价=' + up.toFixed(2) + '  期望=' + expect[v.id]);
});

// 9.6m 实测锚点：单程100km（往返200km）、油车、3月(淡旺季系数=1.00 隔离)
var r96 = window.LRE.evaluate(STATE, {
  province: '全国平均', vehicleId: 'v96', energy: '油', mode: '整车专线',
  km: 100, price: 1500, weight: 15, returnRevenue: 0, month: 3,
  driverPayMode: 'day', includeOvernight: false
});
var up96 = r96.energyCost / r96.roundKm;
console.log('=== 9.6m 实测锚点 ===');
console.log('9.6m 油 单程100km 能源费=' + r96.energyCost.toFixed(2) + ' 往返=' + r96.roundKm + ' 单价=' + up96.toFixed(2) + ' 元/km');
if (up96 < 1.45 || up96 > 1.65) { console.error('FAIL: 9.6m 单价超出实测 1.5-1.6 区间'); fail++; }
else console.log('OK: 9.6m 单价落在 1.5-1.6 实测区间');

// 业务案例回归
function run(label, f) {
  var r = window.LRE.evaluate(STATE, f);
  if (r.error) { console.log(label, 'ERR', r.error); return; }
  console.log([label,
    '能源=' + r.energyCost.toFixed(2),
    '司机=' + r.driverCost.toFixed(2) + '(' + r.driverMode + ')',
    '总成本=' + r.totalCost.toFixed(2),
    '税后净利=' + r.netProfit.toFixed(2),
    '保本=' + r.breakEvenPrice, '建议=' + r.suggestedPrice
  ].join(' | '));
}
console.log('=== 业务案例回归 ===');
run('v76 油 85km(原截图案例)', { province: '全国平均', vehicleId: 'v76', energy: '油', mode: '整车专线', km: 85, price: 850, weight: 3, returnRevenue: 0, month: 10, driverPayMode: 'day', includeOvernight: false });
run('v96 油 600km 长途', { province: '全国平均', vehicleId: 'v96', energy: '油', mode: '整车专线', km: 600, price: 5000, weight: 15, returnRevenue: 0, month: 6, driverPayMode: 'day', includeOvernight: false });
run('v13 油 600km 半挂', { province: '全国平均', vehicleId: 'v13', energy: '油', mode: '整车专线', km: 600, price: 6000, weight: 25, returnRevenue: 0, month: 6, driverPayMode: 'day', includeOvernight: false });
run('v175 油 800km 大板', { province: '全国平均', vehicleId: 'v175', energy: '油', mode: '整车专线', km: 800, price: 9000, weight: 30, returnRevenue: 0, month: 6, driverPayMode: 'day', includeOvernight: false });

if (fail > 0) { console.error('\n有 ' + fail + ' 项未通过'); process.exit(1); }
console.log('\nALL PASS');
