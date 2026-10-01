// 智卡运价评估系统 - 默认基线数据
// 数据来源：公开渠道调研（2026-09），见 meta.notes。
// 重要：这些是「行业公开参考值」，不是你的真实运营数据。
// 系统运行时以 localStorage 中的用户数据/录入的真实成交为优先；
// 本文件仅作为初始默认值与「恢复默认」来源。请尽快用你的真实数据覆盖。
window.DEFAULTS = {
  // 数据溯源：何时、依据什么填的
  meta: {
    asOf: '2026-10-01',
    notes: [
      '柴油价：2026-09-24 国家发改委调价后全国 0# 柴油约 7.86–8.3 元/L，取均价 8.0（北京8.02/广东7.98/山东8.21/河南8.29）。',
      '充电价：自有/谷电桩约 0.5–0.6 元/kWh，公共快充约 1.0–1.5 元/kWh，取 0.75 元/kWh 作折中基线。',
      '加氢价：国内氢燃料电池卡车示范运营站零售约 35–60 元/kg（含补贴），取 45 元/kg 作基线；氢耗按车型载重估算（参考已投运燃料电池重卡公示能耗）。',
      '公路物流运价指数：中物联 2026-09-18 周报 综合1048.29 / 整车1053.95 / 零担重货1053.92 / 零担轻货1024.21。',
      '油车油耗、新能源电耗：卡车油耗实测与新能源重卡评测公开数据（太平洋汽车/有驾/易车等）。',
      '司机日薪、过路费、轮胎维修、保险分摊：行业运营经验区间，需按你车队实际情况微调。',
      '车型载重/容积/月固定成本：按常见车型的公告载重、典型租金/月供/保险/固定底薪估算，仅供分摊参考。',
      '税务：运输服务增值税销项 9%；柴油/充电/加氢进项 13%、通行费进项 9%；城建+教育+地方附加约 12%；企业所得税默认 25%（个体/小规模可调为 0）。'
    ]
  },

  // 能源价格（元）。可细化到省/时段，MVP 先用全国均价。
  energy: {
    dieselPrice: 8.00,       // 柴油 元/L（2026-09-24 调价后全国均价，区间 7.86–8.3）
    electricityPrice: 0.75,  // 充电 元/kWh（自有桩0.5–0.6 / 公共快充1.0–1.5，折中基线）
    hydrogenPrice: 45.00     // 加氢 元/kg（示范运营站零售约 35–60，取 45 作基线）
  },

  // 分省 0# 柴油价（元/L），由后端实时拉取真实数据后写入；键为归一化省份名（广东/北京/内蒙古…）。
  // 在「目标省份」选择后即自动套用该省柴油价参与计算（无需手动改油价）。
  provinceOil: {},

  // 货车通行费 元/公里（按车型类别，全国参考值；实际以各省收费公路标准为准）
  tollClasses: {
    '一类(≤4.5t)': 0.45,
    '二类(2轴)': 0.90,
    '三类(3轴)': 1.20,
    '四类(4轴)': 1.60,
    '五类(5轴)': 1.90,
    '六类(6轴)': 2.10
  },

  // 省份通行费系数（相对全国基准，粗略反映区域差异）
  provinceFactor: {
    '全国平均': 1.00, '广东': 1.05, '江苏': 1.02, '浙江': 1.03,
    '山东': 0.98, '河南': 0.95, '四川': 1.00, '北京': 1.10,
    '上海': 1.08, '河北': 0.97, '湖北': 0.99, '湖南': 0.98
  },

  // 车型库：能耗、人工、过路费档位、载重/容积/月固定成本、司机时间参数。
  // fuel=百公里油耗(L)，elec=百公里电耗(kWh)，hydrogen=百公里氢耗(kg)
  // capacity=核定载重(吨)，volume=车厢容积(方)，monthlyFixed=月固定成本(元/月：月供+折旧+固定底薪+保险年分摊+年审等)
  // 油耗/电耗参考（锚点：9.6m 实测 18–20L/100km≈1.5–1.6 元/km @柴油价8元/L）：
  //   4.2m≈11L / 30kWh，6.8m≈15L / 55kWh，7.6m≈17L / 75kWh，
  //   9.6m≈19L / 100kWh，13m≈32L / 170kWh，17.5m≈38L / 220kWh
  // 氢耗（燃料电池重卡公示能耗按载重估算）：4.2m≈2.0kg / 6.8m≈3.5kg / 9.6m≈6.0kg / 13m≈8.5kg / 17.5m≈11.0kg
  // 三种车型能源：油 / 电 / 氢电混合（氢电混合 = 燃料电池供氢 + 动力电池补电，双能源融合核算）
  //
  // 司机人工时间参数（新版）：
  //   wage=日薪基准(元/天)，hourlyWage=小时工资(元/时，仅展示用)，tripWage=短途趟次工资(元/趟)
  //   minChargeHours=短途半日阈值(默认4h：任务时间≤此值按半日计)，avgSpeed=综合平均时速(仅展示驾驶时长)
  //   loadingTime=默认装卸等待时长(h)，overnightAllowance=在外过夜补贴(元/晚，默认不计，可勾选)
  //   kmPerDay=计费日里程能力(单程km)：单程里程≤此值均计 1 天；超出按 ceil(单程/kmPerDay) 天。这是人工计费核心参数。
  // 油耗参考（按实测锚点重标·2026-10-01）：4.2m≈11L / 6.8m≈15L / 7.6m≈17L / 9.6m≈19L(实测18–20) / 13m≈32L / 17.5m≈38L；柴油价统一8元/L，油车单价梯度 0.88→1.20→1.36→1.52→2.56→3.04 元/km
  vehicles: [
    { id:'v42',  name:'4.2m 轻卡',  energy:['油','电','氢电'], fuel:11, elec:30,  hydrogen:2.0,  toll:'一类(≤4.5t)', wage:300, kmPerDay:400, capacity:3,  volume:18,  monthlyFixed:4500,  tripWage:120, hourlyWage:38, minChargeHours:4, avgSpeed:35, loadingTime:1.0, overnightAllowance:80  },
    { id:'v68',  name:'6.8m 中卡',  energy:['油','电','氢电'], fuel:15, elec:55,  hydrogen:3.5,  toll:'二类(2轴)',  wage:320, kmPerDay:700, capacity:8,  volume:30,  monthlyFixed:6000,  tripWage:150, hourlyWage:40, minChargeHours:4, avgSpeed:40, loadingTime:1.5, overnightAllowance:100 },
    { id:'v76',  name:'7.6m 中卡',  energy:['油','电','氢电'], fuel:17, elec:75,  hydrogen:4.5,  toll:'二类(2轴)',  wage:350, kmPerDay:750, capacity:10, volume:45,  monthlyFixed:7000,  tripWage:180, hourlyWage:44, minChargeHours:4, avgSpeed:42, loadingTime:1.5, overnightAllowance:120 },
    { id:'v96',  name:'9.6m 重卡',  energy:['油','电','氢电'], fuel:19, elec:100, hydrogen:6.0,  toll:'四类(4轴)',  wage:400, kmPerDay:800, capacity:18, volume:60,  monthlyFixed:9000,  tripWage:220, hourlyWage:50, minChargeHours:4, avgSpeed:45, loadingTime:2.0, overnightAllowance:150 },
    { id:'v13',  name:'13m 半挂',   energy:['油','电','氢电'], fuel:32, elec:170, hydrogen:8.5,  toll:'五类(5轴)',  wage:450, kmPerDay:900, capacity:30, volume:90,  monthlyFixed:15000, tripWage:260, hourlyWage:56, minChargeHours:4, avgSpeed:48, loadingTime:2.0, overnightAllowance:180 },
    { id:'v175', name:'17.5m 大板', energy:['油','电','氢电'], fuel:38, elec:220, hydrogen:11.0, toll:'六类(6轴)', wage:500, kmPerDay:1000, capacity:35, volume:130, monthlyFixed:20000, tripWage:300, hourlyWage:62, minChargeHours:4, avgSpeed:50, loadingTime:2.5, overnightAllowance:200 }
  ],

  // 其他变动成本
  other: {
    tireRepairPerKmOil: 0.35,   // 轮胎+维修 元/公里（油车，含机油机滤等）
    tireRepairPerKmElec: 0.20,  // 电车更低（无发动机大修）
    insurancePerKm: 0.18,       // 保险/年审/管理分摊 元/公里
    // 装卸费：零担按 元/吨，整车/城配按 元/趟
    loadingByMode: { '整车专线': 0, '零担': 60, '城配': 40 },
    // —— 实战成本科目 ——
    brokerPct: 0.03,            // 居间/信息费 = 去程运价 × 此比例（默认 3%）
    miscPerTrip: 30,            // 停车/过磅/装卸杂费 元/趟
    riskPct: 0.008,             // 货损/理赔准备金 = 去程运价 × 此比例（默认 0.8%）

    // —— 可选成本开关（项目难盈利时可逐项关闭，关闭即不计该成本）——
    insuranceEnabled: true,     // 保险分摊（元/km）
    brokerEnabled: true,        // 居间/信息费
    miscEnabled: true,          // 停车过磅杂费
    riskEnabled: true,          // 货损/理赔准备金（损耗）
    tireEnabled: true,          // 轮胎/维修（元/km）
    loadingEnabled: true        // 装卸费
  },

  // 淡旺季成本系数：旺季司机/运力紧张，成本上浮；月索引 0=1月
  season: {
    monthly: [1.10, 1.05, 1.00, 0.98, 1.00, 1.05, 1.00, 1.00, 1.02, 1.12, 1.15, 1.08],
    note: '春节(1-2月)、双11(10-11月)为传统旺季；可联网同步公路物流运价指数动态校准（当前指数约 1048，基准 1000）。'
  },

  // 全局配置
  config: {
    profitThreshold: 0.08,   // 可接单的最低净利率阈值
    dataSourceUrl: '',       // 联网数据源：返回 JSON 的地址（真实数据源）
    dataSourceMap: {         // 字段映射：JSON 路径（支持 data.0.0h / data[0].price 形式），留空则该字段沿用上次值
      dieselPrice: '',
      electricityPrice: '',
      hydrogenPrice: '',
      seasonMonthly: '',
      provinceFactor: ''
    },
    distanceMode: 'auto',    // 里程估算模式：auto(城市离线·详细地址自动联网) / offline(仅离线) / street(街道级联网·免Key)
    backendUrl: '',          // 可选：本机后端地址（http://127.0.0.1:3000）。提供分省真实油价与免 Key 里程估算；不填则前端用内置离线估算，全程免 Key
    roadFactor: 1.3,         // 离线估算的道路系数：直线距离 × 此值 ≈ 驾车里程（中国城际约 1.2~1.4）
    shortHaulKm: 25,         // 同城/短途兜底默认里程（km）
    // —— 税务（实战关键） ——
    priceIncludeVat: true,   // 客户运价是否含税（运输报价通常含税，默认 true）
    tripsPerMonth: 22,       // 月度运营测算的月均出车趟数（用于分摊月固定成本）
    fixedCostEnabled: true,  // 月固定成本（月供/折旧/固定底薪）是否分摊到单趟；关闭则单趟成本不含固定分摊（看"纯运输贡献"）
    tax: {
      enabled: true,         // 是否计算增值税/附加/所得税（关闭则退化为旧版税前毛利）
      vatRate: 0.09,         // 运输服务增值税（销项）9%
      dieselInputVat: 0.13,  // 柴油进项 13%
      elecInputVat: 0.13,    // 充电进项 13%
      hydroInputVat: 0.13,   // 加氢进项 13%
      tollInputVat: 0.09,    // 通行费进项 9%（电子通行费票据）
      surtaxRate: 0.12,      // 城建税+教育费附加+地方教育附加 ≈ 12%
      incomeTaxRate: 0.25    // 企业所得税 25%（个体户/小规模纳税人请设为 0）
    }
  },

  // 细分校准：按「车型·能源·模式」分组的系数（键 = vehicleId|energy|mode）
  // 单笔成交校准时自动生成，evaluate 会优先套用匹配分组、否则回退全局 calibration。
  calibrations: {},

  // 回程货池：维护可带回程货源，评估页可按「终点→起点」自动匹配并估算回程收入
  returnCargos: [
    { id: 'rc1', label: '武汉→广州 食品百货', origin: '武汉', dest: '广州', vehicleId: 'v96',  weight: 12, rateMode: 'perKm', price: 1.6,  note: '整车专线，9.6m 以上' },
    { id: 'rc2', label: '武汉→广州 快消零担', origin: '武汉', dest: '广州', vehicleId: 'any',   weight: 5,  rateMode: 'fixed', price: 1800, note: '零担拼车，5t 内' },
    { id: 'rc3', label: '上海→广州 电子产品', origin: '上海', dest: '广州', vehicleId: 'v175', weight: 20, rateMode: 'perKm', price: 2.1,  note: '17.5m 大板，高值货' },
    { id: 'rc4', label: '广州→武汉 建材',     origin: '广州', dest: '武汉', vehicleId: 'v175', weight: 25, rateMode: 'perKm', price: 1.9,  note: '17.5m 大板' }
  ]
};
