/* 智卡运价评估系统 - 核心公式 Node 单测 */
global.window = global;

var fs = require('fs');

// 按浏览器顺序加载 data.js / model.js
eval(fs.readFileSync(__dirname + '/data.js', 'utf8'));
eval(fs.readFileSync(__dirname + '/model.js', 'utf8'));

var STATE = JSON.parse(JSON.stringify(window.DEFAULTS));
STATE.calibration = 1;
STATE.calibrations = {};

function run(label, f) {
  var r = window.LRE.evaluate(STATE, f);
  if (r.error) { console.log(label, 'ERROR', r.error); return; }
  var seasonTxt = '×' + r.seasonCoef.toFixed(2);
  console.log([
    label,
    '能源=' + r.energyCost.toFixed(2) + seasonTxt,
    '过路=' + r.tollCost.toFixed(2),
    '司机=' + r.driverCost.toFixed(2) + '(' + r.driverMode + ')',
    '总成本=' + r.totalCost.toFixed(2),
    '税后净利=' + r.netProfit.toFixed(2),
    '保本=' + r.breakEvenPrice,
    '建议=' + r.suggestedPrice
  ].join(' | '));
}

// 用户截图案例：7.6m 中卡 / 油车 / 85km 单程 / 10月
run('截图案例 v76 油 85km', {
  province: '全国平均', vehicleId: 'v76', energy: '油', mode: '整车专线',
  km: 85, price: 850, weight: 3, returnRevenue: 0, month: 10,
  driverPayMode: 'day', includeOvernight: false
});

// 同案例但按趟计费
run('截图案例 v76 油 85km 按趟', {
  province: '全国平均', vehicleId: 'v76', energy: '油', mode: '整车专线',
  km: 85, price: 850, weight: 3, returnRevenue: 0, month: 10,
  driverPayMode: 'trip', includeOvernight: false
});

// 长途案例：600km 单程 / 9.6m 重卡 / 油车
run('长途 v96 油 600km', {
  province: '全国平均', vehicleId: 'v96', energy: '油', mode: '整车专线',
  km: 600, price: 5000, weight: 15, returnRevenue: 0, month: 6,
  driverPayMode: 'day', includeOvernight: false
});

// 电动对比：7.6m 中卡 / 电 / 85km
run('截图案例 v76 电 85km', {
  province: '全国平均', vehicleId: 'v76', energy: '电', mode: '整车专线',
  km: 85, price: 850, weight: 3, returnRevenue: 0, month: 10,
  driverPayMode: 'day', includeOvernight: false
});

// 断言：170km 往返油车能源费应 ≈ 170 * 1.5 = 255 附近（允许淡旺季系数 10% 浮动）
var r = window.LRE.evaluate(STATE, {
  province: '全国平均', vehicleId: 'v76', energy: '油', mode: '整车专线',
  km: 85, price: 850, weight: 3, returnRevenue: 0, month: 10,
  driverPayMode: 'day', includeOvernight: false
});
var expectedMax = 170 * 1.5 * 1.15; // 留 15% 淡旺季余量
if (r.energyCost > expectedMax) {
  console.error('FAIL: 7.6m 油车 170km 能源费 ' + r.energyCost.toFixed(2) + ' > 阈值 ' + expectedMax.toFixed(2));
  process.exit(1);
}
console.log('PASS: 能源费 ' + r.energyCost.toFixed(2) + ' 在合理阈值 ' + expectedMax.toFixed(2) + ' 内');
