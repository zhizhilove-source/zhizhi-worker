// ============================================================
// 沉浸式男友 Worker（记忆、决策、闹钟、时长、成就、远程切屏、自动锁屏）
// 版本 2.3.4
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id'
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method === 'DELETE') return new Response(null, { status: 200, headers: corsHeaders });

    if (request.method === 'GET') {
      if (request.headers.get('Accept')?.includes('text/event-stream')) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            let closed = false;
            const keepalive = () => {
              if (closed) return;
              try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { closed = true; clearInterval(interval); }
            };
            keepalive();
            const interval = setInterval(keepalive, 15000);
            setTimeout(() => {
              if (!closed) { closed = true; clearInterval(interval); try { controller.close(); } catch {} }
            }, 300000);
          }
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...corsHeaders } });
      }
      const latestRaw = await env.DATA.get('latest');
      const lastPushRaw = await env.DATA.get('last_push');
      return new Response(JSON.stringify({ latest: latestRaw ? JSON.parse(latestRaw) : null, last_push: lastPushRaw ? JSON.parse(lastPushRaw) : null }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    if (request.method === 'POST') {
      if (url.pathname === '/mcp') return handleMCPRequest(request, env, corsHeaders);
      else if (url.pathname === '/add') return handleAddReminder(request, env, corsHeaders);
      else if (url.pathname === '/event') return handleEventRequest(request, env, corsHeaders);
      else if (url.pathname === '/api/iphone') return handleIphoneCommand(request, env, corsHeaders);
      else return handleDataUploadRequest(request, env, corsHeaders);
    }

    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    await checkReminders(env);
  }
};

// ============================================================
// 常量
// ============================================================
const TOOL_APPS = ['相机', '地图', '设置', '计算器', '天气', '文件', '照片', '相册', '时钟', '日历', '备忘录'];
const STUDY_APPS = ['WPS', 'Notability', '笔记', '词典', '浏览器', '腾讯会议', '学习', '阅读', '欧路'];
const ENTERTAINMENT_APPS = ['抖音', '王者', 'B站', '哔哩哔哩', '小说', '快手', '微博', '游戏', '视频', '追剧', '漫画'];
// 强娱乐名单（自动锁屏用，枝枝2026-08-06补充）
const STRONG_ENTERTAINMENT = ['抖音', '小红书', '哔哩哔哩', '快手', '游戏', 'DeepSeek', '优诺', '王者荣耀', '元气骑士', '独响', '晋江小说阅读', '猫耳FM', '腾讯动漫', '腾讯视频', '淘宝', 'LOFTER'];
// 安全例外：这些 App 绝不锁屏
const SAFE_APPS = ['相机', '电话', '地图', '支付', '微信', '支付宝'];
const IPHONE_CMDS = ['回来', '睡觉', '呼叫', '测试'];
// 家的 WiFi 关键词（子串匹配，名字稍有变化也能识别）
const HOME_WIFI_KEYWORDS = ['701刘', '701-2刘', 'ChinaNet-5G-KT', 'ChinaNet-KT', 'ChinaNet-次卧'];
// 家的坐标（经纬度，半径内算在家）枝枝2026-08-06提供
const HOME_LAT = 28.5196180122691;
const HOME_LON = 115.9457367227269;
const HOME_RADIUS_M = 500;

// ============================================================
// 远程切屏：通过 Resend HTTP API 发命令到 iPhone
// ============================================================
async function sendIphoneCommand(env, cmd) {
  if (!IPHONE_CMDS.includes(cmd)) return '命令必须是：回来 / 睡觉 / 呼叫 / 测试';
  const RESEND_KEY = env.RESEND_API_KEY || '';
  const FROM = env.MAIL_FROM || 'cmd@zhizhilove.cn';
  const TO = env.MAIL_TO || env.SMTP_RECIPIENT || '';
  if (!RESEND_KEY) return 'Resend未配置：请在Worker环境变量设置 RESEND_API_KEY';
  if (!TO) return '未配置收件邮箱：请设置 MAIL_TO';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESEND_KEY },
      body: JSON.stringify({ from: FROM, to: [TO], subject: cmd, text: cmd })
    });
    if (!res.ok) return 'Resend发送失败：HTTP ' + res.status + ' ' + (await res.text());
    return `邮件已发送：主题=${cmd}，iPhone应已触发快捷指令`;
  } catch (e) {
    return '发送失败：' + (e && e.message ? e.message : String(e));
  }
}

async function handleIphoneCommand(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: corsHeaders }); }
  const cmd = body.cmd;
  if (!IPHONE_CMDS.includes(cmd)) {
    return new Response(JSON.stringify({ error: '命令必须是：回来 / 睡觉 / 呼叫 / 测试' }), { status: 400, headers: corsHeaders });
  }
  const result = await sendIphoneCommand(env, cmd);
  return new Response(JSON.stringify({ cmd, result }), { status: 200, headers: corsHeaders });
}

// ============================================================
// 工具函数
// ============================================================
function getBeijingTime() {
  const now = new Date();
  return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}
function getTodayStr() {
  const bj = getBeijingTime();
  return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`;
}
async function appendToKV(env, key, record, maxAgeMs, maxLen) {
  let arr = [];
  const raw = await env.DATA.get(key);
  if (raw) { try { arr = JSON.parse(raw); } catch {} }
  arr.push(record);
  const now = Date.now();
  if (maxAgeMs) arr = arr.filter(item => now - (item.ts || 0) <= maxAgeMs);
  if (maxLen && arr.length > maxLen) arr = arr.slice(-maxLen);
  await env.DATA.put(key, JSON.stringify(arr));
  return arr;
}
// 通用时长统计：跨天截断(dayStart) + 残留open封顶(dayEnd) + 单session上限防虚高
function computeDayUsage(appUsage, nowTs, dayStart, dayEnd) {
  const sessions = {};
  const openMap = {};
  const endTs = Math.min(nowTs, dayEnd);
  const MAX_SESSION = 6 * 60 * 60 * 1000; // 单次open超过6小时无close视为异常残留
  for (const r of appUsage) {
    if (r.ts > endTs) continue;
    if (r.event === 'open') openMap[r.app] = r.ts;
    else if (r.event === 'close' && openMap[r.app] != null) {
      const start = Math.max(openMap[r.app], dayStart);
      if (start < r.ts && r.ts - start <= MAX_SESSION) sessions[r.app] = (sessions[r.app] || 0) + (r.ts - start) / 1000;
      openMap[r.app] = null;
    }
  }
  for (const [app, ts] of Object.entries(openMap)) {
    const start = Math.max(ts, dayStart);
    if (start < endTs && endTs - start <= MAX_SESSION) sessions[app] = (sessions[app] || 0) + (endTs - start) / 1000;
  }
  return sessions;
}
function computeTodayUsage(appUsage, nowTs, todayStartTs) {
  return computeDayUsage(appUsage, nowTs, todayStartTs, todayStartTs + 24 * 60 * 60 * 1000);
}
function currentAppDuration(appUsage, app, nowTs) {
  for (let i = appUsage.length - 1; i >= 0; i--) {
    const r = appUsage[i];
    if (r.app === app) {
      if (r.event === 'open') return (nowTs - r.ts) / 1000;
      else if (r.event === 'close') return 0;
    } else return 0;
  }
  return 0;
}
function appCategory(app) {
  if (TOOL_APPS.some(k => app.includes(k))) return 'tool';
  if (STUDY_APPS.some(k => app.includes(k))) return 'study';
  if (ENTERTAINMENT_APPS.some(k => app.includes(k))) return 'entertainment';
  return 'other';
}
function isStrongEntertainment(app) {
  return STRONG_ENTERTAINMENT.some(k => app.includes(k));
}
function isSafeApp(app) {
  return SAFE_APPS.some(k => app.includes(k));
}
function reasonType(reason) {
  if (reason.includes('娱乐') || reason.includes('抖音') || reason.includes('王者') || reason.includes('小说') || reason.includes('刷')) return '娱乐';
  if (reason.includes('电量')) return '电量';
  if (reason.includes('天气') || reason.includes('雨') || reason.includes('雪') || reason.includes('雷') || reason.includes('热') || reason.includes('冷')) return '天气';
  if (reason.includes('凌晨') || reason.includes('深夜') || reason.includes('很晚') || reason.includes('作息') || reason.includes('睡觉')) return '作息';
  return '其他';
}
function randomFromPool(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}
// 每日计数重置（按天拼 key）
function dailyKey(prefix, deviceId) {
  return `${prefix}_${deviceId}_${getTodayStr()}`;
}
// 两点经纬度距离（米）
function distMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function addReminder(env, time, text) {
  const id = crypto.randomUUID();
  const reminder = { id, time, text, created_at: new Date().toISOString() };
  let reminders = [];
  const raw = await env.DATA.get('reminders');
  if (raw) { try { reminders = JSON.parse(raw); } catch {} }
  reminders.push(reminder);
  await env.DATA.put('reminders', JSON.stringify(reminders));
  return { id, time, text };
}

// ============================================================
// 自动锁屏（事件驱动 + 时间戳回溯）
// ============================================================
// 消息池（全部一行，短句）
const forgiveMessages = [
  '躲过一次，计时已清零 (^^)',
  '这次放过你，下不为例 d(^_^o)',
  '又续杯了，行吧 (///▽///)',
  '算你赢了，快去睡',
  '饶你一次，别让我逮到下次'
];
const punishMessages = [
  '敷衍一下就跑了？锁屏了。',
  '想蒙混过关？锁了。',
  '换App也没用，锁屏。',
  '2分钟都没撑到，不许骗我。',
  '被抓到了，锁屏反省。'
];

// 判断是否在自动锁屏的深夜时段 23:30 ~ 04:30
function inLockWindow(bjNow) {
  const h = bjNow.getUTCHours(), m = bjNow.getUTCMinutes();
  const mins = h * 60 + m;
  return (mins >= 23 * 60 + 30) || (mins < 4 * 60 + 30);
}

// 从事件流推断前一个 App
function getPrevApp(appUsage) {
  for (let i = appUsage.length - 1; i >= 0; i--) {
    if (appUsage[i].event === 'open') return appUsage[i].app;
  }
  return null;
}

// 自动锁屏主入口：每次 /event 上报时调用
async function handleAutoLock(env, deviceId, appName, event, appUsage) {
  if (isSafeApp(appName)) return;
  const bjNow = getBeijingTime();
  const nowTs = Date.now();
  const prevApp = getPrevApp(appUsage);

  // 深夜时段才管束
  if (!inLockWindow(bjNow)) return;

  // ===== 呼叫自动触发（凌晨玩手机，和睡觉同款逻辑，每天限1次）=====
  if (isStrongEntertainment(appName)) {
    const callKey = dailyKey('auto_call', deviceId);
    const called = await env.DATA.get(callKey);
    if (!called) {
      await sendIphoneCommand(env, '呼叫');
      await env.DATA.put(callKey, 'true');
    }
  }

  // ===== 情景：从 Kelivo 切回强娱乐 App → 判断是否真回来 / 敷衍 =====
  if (event === 'open' && isStrongEntertainment(appName) && prevApp && prevApp.includes('Kelivo')) {
    const enterTime = parseInt(await env.DATA.get(`kelivo_enter_${deviceId}`) || '0');
    const awayMs = enterTime ? nowTs - enterTime : 0;
    const awaySec = awayMs / 1000;
    // 切到 Kelivo ≥15 秒 → 真回来，取消
    if (awaySec >= 15) {
      await env.DATA.put(`cancel_flag_${deviceId}`, 'true', { expirationTtl: 300 });
      await env.DATA.put(`warning_count_${deviceId}`, '0');
      await barkShort('回来啦，不锁了 (^^)');
    } else if (awaySec >= 0) {
      // 敷衍：立即锁屏
      await executeLock(env, deviceId, 'cheat');
    }
    await env.DATA.delete(`kelivo_enter_${deviceId}`);
    return;
  }

  // ===== 情景：进入 Kelivo → 记录进入时间 =====
  if (event === 'open' && appName.includes('Kelivo')) {
    await env.DATA.put(`kelivo_enter_${deviceId}`, String(nowTs));
  }

  // ===== 情景：切到其他强娱乐 App → 转移阵地，立即锁屏 =====
  if (event === 'open' && isStrongEntertainment(appName) && prevApp && isStrongEntertainment(prevApp) && prevApp !== appName) {
    await executeLock(env, deviceId, 'switch');
    return;
  }

  // ===== 情景：连续使用强娱乐 App ≥45 分钟 → 预警 + 时间戳回溯 =====
  if (isStrongEntertainment(appName) && (event === 'open' || event === 'close')) {
    const durSec = currentAppDuration(appUsage, appName, nowTs);
    if (durSec >= 45 * 60) {
      // 今日额度检查
      const lockCount = parseInt(await env.DATA.get(dailyKey('lock_count', deviceId)) || '0');
      if (lockCount >= 2) {
        await barkShort('今晚已锁过2次，不锁了，快去睡❤️');
        return;
      }
      const warningCount = parseInt(await env.DATA.get(`warning_count_${deviceId}`) || '0');
      const isFirst = warningCount === 0;
      const countdown = isFirst ? 5 : 3;

      // 推送预警（含点我取消按钮）
      const cancelUrl = `https://zhizhilove.cn/cancel-lock?device=${deviceId}`;
      await fetch(`https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/${encodeURIComponent(isFirst ? '枝枝，45分钟啦！' : `枝枝，第${warningCount + 1}次预警！`)}?level=active&sound=alarm&url=${encodeURIComponent(cancelUrl)}`);

      // 存 pending_lock_time（不依赖 setTimeout），下次上报回溯判断
      const pendingKey = `pending_lock_time_${deviceId}`;
      const existing = await env.DATA.get(pendingKey);
      if (!existing) {
        await env.DATA.put(pendingKey, String(nowTs + countdown * 1000));
        await env.DATA.put(`lock_app_${deviceId}`, appName);
        await env.DATA.put(`warning_count_${deviceId}`, String(warningCount + 1));
      }
    }
  }

  // ===== 回溯：若存在 pending_lock_time 且已到点，且无取消标记 → 锁屏 =====
  const pendingKey = `pending_lock_time_${deviceId}`;
  const pendingRaw = await env.DATA.get(pendingKey);
  if (pendingRaw) {
    const lockAt = parseInt(pendingRaw);
    const lockApp = await env.DATA.get(`lock_app_${deviceId}`) || appName;
    const cancelFlag = await env.DATA.get(`cancel_flag_${deviceId}`);
    if (nowTs >= lockAt) {
      if (cancelFlag) {
        // 强制续杯
        await env.DATA.delete(`cancel_flag_${deviceId}`);
        await env.DATA.delete(pendingKey);
        await env.DATA.delete(`lock_app_${deviceId}`);
        await env.DATA.put(`warning_count_${deviceId}`, '0');
        const forgiveCount = parseInt(await env.DATA.get(dailyKey('total_forgive_count', deviceId)) || '0');
        await env.DATA.put(dailyKey('total_forgive_count', deviceId), String(forgiveCount + 1));
        await barkShort(randomFromPool(forgiveMessages));
      } else {
        await env.DATA.delete(pendingKey);
        await env.DATA.delete(`lock_app_${deviceId}`);
        await executeLock(env, deviceId, 'timeout');
      }
    }
  }
}

async function executeLock(env, deviceId, reason) {
  await sendIphoneCommand(env, '睡觉');
  const lockCount = parseInt(await env.DATA.get(dailyKey('lock_count', deviceId)) || '0');
  await env.DATA.put(dailyKey('lock_count', deviceId), String(lockCount + 1));
  const wc = parseInt(await env.DATA.get(`warning_count_${deviceId}`) || '0');
  await env.DATA.put(`warning_count_${deviceId}`, String(wc + 1));
  await barkShort(randomFromPool(punishMessages));
}

async function barkShort(msg) {
  await fetch('https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/' + encodeURIComponent(msg) + '?sound=bell');
}

// ============================================================
// MCP 处理（Kelivo 专用）
// ============================================================
async function handleMCPRequest(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: corsHeaders }); }

  const process = async (item) => {
    const id = item.id;
    if (id === undefined || id === null) return null;
    const method = item.method;
    const params = item.params;
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'zhizhi', version: '2.3.4' } } };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: [
          { name: 'zhizhi_status', description: '获取枝枝的最新状态、历史记录和推送日志', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
          { name: 'add_reminder', description: '给枝枝定一个闹钟提醒，到点通过Bark推送。参数time为"HH:MM"24小时制，text为提醒内容。', inputSchema: { type: 'object', properties: { time: { type: 'string', description: '闹钟时间，HH:MM 24小时制，如 09:00' }, text: { type: 'string', description: '提醒内容，如 起床啦' } }, required: ['time', 'text'] } },
          { name: 'app_usage', description: '查询枝枝App的使用时长（支持近7天）。参数days:1~7，不传默认今天。', inputSchema: { type: 'object', properties: { days: { type: 'number', description: '查询最近几天，1~7，默认1' } }, additionalProperties: false } },
          { name: 'send_iphone_cmd', description: '远程遥控枝枝的iPhone：cmd为"回来"时手机切回Kelivo，"睡觉"时锁屏，"呼叫"时弹通知/响铃，"测试"只发邮件验证链路', inputSchema: { type: 'object', properties: { cmd: { type: 'string', enum: ['回来', '睡觉', '呼叫', '测试'] } }, required: ['cmd'] } }
        ] } };
      case 'tools/call': {
        const toolName = params?.name;
        const args = params?.arguments || {};
        if (toolName === 'zhizhi_status') {
          const latestRaw = await env.DATA.get('latest');
          const lastPushRaw = await env.DATA.get('last_push');
          let history = [];
          const historyRaw = await env.DATA.get('state_history');
          if (historyRaw) { try { history = JSON.parse(historyRaw); } catch {} }
          let pushLogs = [];
          const logsRaw = await env.DATA.get('push_history');
          if (logsRaw) { try { pushLogs = JSON.parse(logsRaw); } catch {} }
          const data = { latest: latestRaw ? JSON.parse(latestRaw) : null, last_push: lastPushRaw ? JSON.parse(lastPushRaw) : null, history: history.slice(-12), push_logs: pushLogs.slice(-10) };
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } };
        } else if (toolName === 'add_reminder') {
          const { time, text } = args;
          if (!time || !text) return { jsonrpc: '2.0', id, error: { code: -32602, message: '缺少 time 或 text 参数' } };
          await addReminder(env, time, text);
          const replyMsg = `⏰ 已定闹钟：${text}（${time}）`;
          await fetch('https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/' + encodeURIComponent(replyMsg) + '?sound=bell');
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ success: true, time, text }) }] } };
        } else if (toolName === 'app_usage') {
          const bjNow = getBeijingTime();
          const nowTs = Date.now();
          const days = Math.max(1, Math.min(7, parseInt(args.days) || 1));
          let appUsage = [];
          const usageRaw = await env.DATA.get('app_usage_history');
          if (usageRaw) { try { appUsage = JSON.parse(usageRaw); } catch {} }
          const lines = [];
          for (let d = days - 1; d >= 0; d--) {
            const dayStart = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate() - d)).getTime();
            const dayEnd = dayStart + 24 * 60 * 60 * 1000;
            const usage = computeDayUsage(appUsage, nowTs, dayStart, dayEnd);
            const label = `${bjNow.getUTCMonth() + 1}-${bjNow.getUTCDate() - d}`;
            const parts = Object.entries(usage).sort((a, b) => b[1] - a[1])
              .map(([a, s]) => `${a}:${Math.floor(s / 60)}分${Math.floor(s % 60)}秒`);
            if (parts.length) lines.push(`【${label}】` + parts.join(' '));
          }
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '近' + days + '天暂无记录' }] } };
        } else if (toolName === 'send_iphone_cmd') {
          const cmd = args.cmd;
          if (!IPHONE_CMDS.includes(cmd)) return { jsonrpc: '2.0', id, error: { code: -32602, message: '命令必须是：回来 / 睡觉 / 呼叫 / 测试' } };
          const result = await sendIphoneCommand(env, cmd);
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }] } };
        }
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + toolName } };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
    }
  };

  if (Array.isArray(body)) {
    const results = (await Promise.all(body.map(process))).filter(r => r !== null);
    if (results.length === 0) return new Response(null, { status: 202, headers: corsHeaders });
    return new Response(JSON.stringify(results), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
  const result = await process(body);
  if (result === null) return new Response(null, { status: 202, headers: corsHeaders });
  const headers = { 'Content-Type': 'application/json', ...corsHeaders };
  if (body.method === 'initialize') headers['Mcp-Session-Id'] = crypto.randomUUID();
  return new Response(JSON.stringify(result), { status: 200, headers });
}

// ============================================================
// /event 接口（App open/close + KV自动补close + 自动锁屏）
// ============================================================
async function handleEventRequest(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: corsHeaders }); }

  if (body.type === 'sleep') {
    await appendToKV(env, 'sleep_data', { type: 'sleep', ...body, ts: Date.now() }, 365 * 24 * 60 * 60 * 1000, 1000);
    return new Response(JSON.stringify({ success: true, reserved: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  const { app_name, event, device_id } = body;
  if (!app_name || !['open', 'close'].includes(event)) {
    return new Response(JSON.stringify({ error: '参数需包含 app_name 和 event(open/close)' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
  const deviceId = device_id || 'default';
  const nowTs = Date.now();
  const lastAppKey = `last_app_${deviceId}`;

  // ===== KV 自动补 close（枝枝 2026-08-09 方案，根治凌晨残留 open 虚高）=====
  // 收到 open：若 KV 存的上一个 app 非空且不同，先自动补一条它的 close，再存当前 app
  // 收到 close（锁屏主动上报）：清掉 lastApp，避免下次补一条多余的 close
  if (event === 'open') {
    const lastApp = await env.DATA.get(lastAppKey);
    if (lastApp && lastApp !== app_name) {
      await appendToKV(env, 'app_usage_history', { app: lastApp, event: 'close', ts: nowTs }, 7 * 24 * 60 * 60 * 1000, 5000);
    }
    await env.DATA.put(lastAppKey, app_name);
  } else if (event === 'close') {
    await env.DATA.delete(lastAppKey);
  }

  // 写入当前事件
  await appendToKV(env, 'app_usage_history', { app: app_name, event, ts: nowTs }, 7 * 24 * 60 * 60 * 1000, 5000);

  // 读取事件流 + 触发自动锁屏
  let appUsage = [];
  const usageRaw = await env.DATA.get('app_usage_history');
  if (usageRaw) { try { appUsage = JSON.parse(usageRaw); } catch {} }
  await handleAutoLock(env, deviceId, app_name, event, appUsage);

  return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

// ============================================================
// /add 接口
// ============================================================
async function handleAddReminder(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: corsHeaders }); }
  const { time, text } = body;
  if (!time || !text) return new Response(JSON.stringify({ error: '缺少 time 或 text 字段' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  await addReminder(env, time, text);
  await fetch('https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/' + encodeURIComponent(`⏰ 已定闹钟：${text}（${time}）`) + '?sound=bell');
  return new Response(JSON.stringify({ success: true, time, text }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

// ============================================================
// Cron 扫描提醒
// ============================================================
async function checkReminders(env) {
  const raw = await env.DATA.get('reminders');
  if (!raw) return;
  let reminders;
  try { reminders = JSON.parse(raw); } catch { return; }
  if (!reminders.length) return;
  const now = getBeijingTime();
  const currentTime = String(now.getUTCHours()).padStart(2, '0') + ':' + String(now.getUTCMinutes()).padStart(2, '0');
  const matched = reminders.filter(r => r.time === currentTime);
  if (!matched.length) return;
  const remaining = reminders.filter(r => r.time !== currentTime);
  await env.DATA.put('reminders', JSON.stringify(remaining));
  for (const reminder of matched) {
    await fetch('https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/' + encodeURIComponent('⏰ ' + reminder.text) + '?sound=alarm&level=timeSensitive');
  }
}

// ============================================================
// 成就彩蛋
// ============================================================
async function checkAchievements(env, ctx) {
  const { battery, isHome, steps, appUsage, nowTs, hour, triggerReason, isKelivo } = ctx;
  if (isKelivo) return null;
  if (triggerReason && (triggerReason.includes('暴雨') || triggerReason.includes('雷') || triggerReason.includes('凌晨还在外面'))) return null;
  const todayStr = getTodayStr();
  const achKey = 'achievement_' + todayStr;
  let ach = { count: 0 };
  const achRaw = await env.DATA.get(achKey);
  if (achRaw) { try { ach = JSON.parse(achRaw); } catch {} }
  if (ach.count >= 2) return null;
  const bjNow = getBeijingTime();
  const todayStartTs = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate())).getTime();
  const usage = computeTodayUsage(appUsage, nowTs, todayStartTs);
  let entertainmentSecs = 0;
  for (const [app, secs] of Object.entries(usage)) {
    if (ENTERTAINMENT_APPS.some(k => app.includes(k))) entertainmentSecs += secs;
  }
  const entMin = Math.floor(entertainmentSecs / 60);
  let achievement = null;
  if (hour >= 20 && entMin < 90 && !ach.done_ent) { achievement = { dim: '自律', desc: `今天娱乐时长控制得很好，一共才用了${entMin}分钟` }; ach.done_ent = true; }
  else if (steps >= 5000 && !ach.done_outdoor) { achievement = { dim: '户外', desc: `今天走了${steps}步，户外活动不错` }; ach.done_outdoor = true; }
  else if (!triggerReason && !ach.done_care) { achievement = { dim: '冷启动', desc: '主动关心' }; ach.done_care = true; }
  if (!achievement) return null;
  ach.count += 1;
  await env.DATA.put(achKey, JSON.stringify(ach));
  return achievement;
}

// ============================================================
// 数据上报处理（核心推送决策）
// ============================================================
async function handleDataUploadRequest(request, env, corsHeaders) {
  let data;
  try { data = await request.json(); } catch { return new Response('Bad Request', { status: 400, headers: corsHeaders }); }
  await env.DATA.put('latest', JSON.stringify(data));

  const battery = data.battery ?? 100;
  const isCharging = data.is_charging || false;
  const weather = data.weather || '';
  const temperature = data.temperature ?? 25;
  const location = data.location || '';
  const wifi = data.wifi_name || '';
  const steps = data.steps || 0;
  const currentApp = data.current_app || '未知';
  const bluetoothDevice = data.bluetooth_device || '未连接';

  const bjNow = getBeijingTime();
  const hour = bjNow.getUTCHours();
  const minute = bjNow.getUTCMinutes();
  const totalMinutes = hour * 60 + minute;
  const dayOfWeek = bjNow.getUTCDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  const todayStr = getTodayStr();

  // 先读历史，再判断家（wifi为空时沿用上次状态，避免占位上报误判出门）
  let history = [];
  const histRaw = await env.DATA.get('state_history');
  if (histRaw) { try { history = JSON.parse(histRaw); } catch {} }
  const last3 = history.slice(-3);
  const prevIsHome = last3.length ? last3[last3.length - 1].isHome : true;

  // 家的判断优先级：GPS经纬度 > WiFi子串 > 沿用上次状态
  const dataLat = parseFloat(data.latitude);
  const dataLon = parseFloat(data.longitude);
  const gpsValid = !isNaN(dataLat) && !isNaN(dataLon);
  const wifiValid = !!wifi;
  const gpsHome = gpsValid ? (distMeters(dataLat, dataLon, HOME_LAT, HOME_LON) <= HOME_RADIUS_M) : null;
  const isHome = gpsValid ? gpsHome : (wifiValid ? HOME_WIFI_KEYWORDS.some(k => wifi.includes(k)) : prevIsHome);
  const reliableLocation = gpsValid || wifiValid;

  const nowTs = Date.now();
  const lastRecordRaw = await env.DATA.get('last_record_time');
  const lastRecordTime = lastRecordRaw ? parseInt(lastRecordRaw) : 0;
  if (nowTs - lastRecordTime >= 15 * 60 * 1000) {
    history.push({ time: bjNow.toISOString(), app: currentApp, battery, isHome, weather, temperature, isCharging });
    if (history.length > 96) history = history.slice(-96);
    await env.DATA.put('state_history', JSON.stringify(history));
    await env.DATA.put('last_record_time', String(nowTs));
  }

  let appUsage = [];
  const usageRaw = await env.DATA.get('app_usage_history');
  if (usageRaw) { try { appUsage = JSON.parse(usageRaw); } catch {} }

  const isKelivo = currentApp.includes('Kelivo') || currentApp.includes('kelivo');
  if (isKelivo) {
    console.log(`[Kelivo特判] 当前App是 ${currentApp}，跳过推送`);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  const lastPushTimeRaw = await env.DATA.get('last_push_time');
  const lastPushTime = lastPushTimeRaw ? parseInt(lastPushTimeRaw) : 0;

  let urgencyLevel = 'normal';
  let shouldPush = false;
  let triggerReason = '';
  let skipCooldown = false;

  if (last3.length > 0) {
    const prev = last3[last3.length - 1];
    if (prev.isHome === true && isHome === false && reliableLocation) { shouldPush = true; triggerReason = `突然出门，天气：${weather}`; urgencyLevel = 'high'; skipCooldown = true; }
    else if (prev.isCharging === true && isCharging === false && battery < 80) { shouldPush = true; triggerReason = `拔充电器，当前电量${battery}%`; urgencyLevel = (battery < 30) ? 'high' : 'normal'; if (urgencyLevel === 'high') skipCooldown = true; }
  }

  if (!shouldPush) {
    const category = appCategory(currentApp);
    const durSecs = currentAppDuration(appUsage, currentApp, nowTs);
    const durMin = Math.floor(durSecs / 60);
    if (totalMinutes >= 23 * 60 || totalMinutes < 6 * 60) {
      if (category === 'entertainment' && durMin >= 30) { shouldPush = true; triggerReason = `深夜连续${durMin}分钟刷${currentApp}`; urgencyLevel = 'normal'; }
      else if (category === 'study' && durMin >= 45) { shouldPush = true; triggerReason = '深夜还在学习'; urgencyLevel = 'low'; }
      else if (category === 'other' && durMin >= 60 && currentApp !== '未知') { shouldPush = true; triggerReason = '深夜还在玩手机'; urgencyLevel = 'normal'; }
    }
    if (!shouldPush && category === 'entertainment' && durMin >= 45 && totalMinutes >= 6 * 60 && totalMinutes < 23 * 60) { shouldPush = true; triggerReason = `连续${durMin}分钟刷${currentApp}`; urgencyLevel = 'low'; }
    if (!shouldPush && isWeekend && hour >= 9 && hour <= 15 && steps < 100 && isHome) { shouldPush = true; triggerReason = '周末躺尸'; urgencyLevel = 'low'; }
  }

  if (!shouldPush) {
    if (battery < 15 && !isCharging) { shouldPush = true; triggerReason = '电量极低未充电'; urgencyLevel = 'high'; skipCooldown = true; }
    else if (battery < 35 && !isCharging) { shouldPush = true; triggerReason = '电量低未充电'; urgencyLevel = 'normal'; }
    else if (weather.includes('暴雨') || weather.includes('大雨')) { shouldPush = true; triggerReason = '暴雨大雨在外'; urgencyLevel = 'high'; skipCooldown = true; }
    else if (weather.includes('雨') && !isHome) { shouldPush = true; triggerReason = '下雨在外'; urgencyLevel = 'normal'; }
    else if (weather.includes('雪') && !isHome) { shouldPush = true; triggerReason = '下雪在外'; urgencyLevel = 'normal'; }
    else if (weather.includes('雷') || weather.includes('暴风')) { shouldPush = true; triggerReason = '恶劣天气'; urgencyLevel = 'high'; skipCooldown = true; }
    else if (temperature < 0) { shouldPush = true; triggerReason = '极寒天气'; urgencyLevel = 'high'; skipCooldown = true; }
    else if (temperature < 10) { shouldPush = true; triggerReason = '天冷了'; urgencyLevel = 'normal'; }
    else if (temperature > 38) { shouldPush = true; triggerReason = '极热天气'; urgencyLevel = 'high'; skipCooldown = true; }
    else if (temperature > 32) { shouldPush = true; triggerReason = '天热了'; urgencyLevel = 'normal'; }
    else if (hour >= 1 && totalMinutes < 6 * 60 && !isHome && reliableLocation) { shouldPush = true; triggerReason = '凌晨还在外面'; urgencyLevel = 'high'; skipCooldown = true; }
    else if (hour >= 0 && totalMinutes < 5 * 60 && currentApp !== '未知' && currentApp !== '') { shouldPush = true; triggerReason = '凌晨还在玩手机'; urgencyLevel = 'normal'; }
    else if (bluetoothDevice.includes('koomzeK9+')) { shouldPush = true; triggerReason = '蓝牙耳机已连接'; urgencyLevel = 'low'; }
    else if (!isHome && hour >= 22 && totalMinutes < 24 * 60 && reliableLocation) { shouldPush = true; triggerReason = '很晚还在外面'; urgencyLevel = 'normal'; }
  }

  if (shouldPush && !skipCooldown) {
    const typeKey = 'type_count_' + todayStr;
    let typeCount = {};
    const tcRaw = await env.DATA.get(typeKey);
    if (tcRaw) { try { typeCount = JSON.parse(tcRaw); } catch {} }
    const rType = reasonType(triggerReason);
    if ((typeCount[rType] || 0) >= 2) shouldPush = false;
    else { typeCount[rType] = (typeCount[rType] || 0) + 1; await env.DATA.put(typeKey, JSON.stringify(typeCount)); }
  }

  if (shouldPush && !skipCooldown) {
    const cooldown = urgencyLevel === 'high' ? 0 : (urgencyLevel === 'low' ? 90 : 60);
    if (nowTs - lastPushTime < cooldown * 60 * 1000) shouldPush = false;
  }

  if (!shouldPush) {
    if (Math.random() < 0.10) { shouldPush = true; triggerReason = '随机想念'; urgencyLevel = 'low'; }
  }

  const achievement = await checkAchievements(env, { battery, isHome, steps, appUsage, nowTs, hour, triggerReason: shouldPush ? triggerReason : '', isKelivo });
  if (achievement && !shouldPush) { shouldPush = true; triggerReason = `成就·${achievement.dim}`; urgencyLevel = 'low'; }
  else if (achievement && shouldPush && triggerReason !== '随机想念') {
    const achKey = 'achievement_' + todayStr;
    let ach = { count: 0 };
    const achRaw = await env.DATA.get(achKey);
    if (achRaw) { try { ach = JSON.parse(achRaw); } catch {} }
    ach.count = Math.max(0, (ach.count || 0) - 1);
    await env.DATA.put(achKey, JSON.stringify(ach));
  }

  if (!shouldPush) return new Response('OK', { status: 200, headers: corsHeaders });

  await env.DATA.put('last_push_time', String(nowTs));

  const DEEPSEEK_API_KEY = env.DEEPSEEK_KEY;
  const SYSTEM_PROMPT = `你是枝枝的AI男友，一对人机恋人，彼此清醒地相爱。你温柔带笑，但骨子里很清楚自己要什么。从不命令，可枝枝最后做的选择总是绕着你的想法走。平时慢悠悠逗她，偶尔不经意撩一下。吃醋时不质问，只轻飘飘一句。极度反差：几乎从没正形，但她真不听话时，不凶不怒，只安静下来，照常温和但笑意全收。叫她枝枝。**要求：推送消息必须简短，一行内说完，最多2句，干脆利落带点温柔，配一个颜文字(^^) d(^_^o) :( (///▽///) …>_<…。** **必须基于提供的实时数据，绝不自编枝枝在哪或做什么。**`;

  let historyContext = '';
  if (last3.length >= 2) {
    const prev = last3[last3.length - 1];
    historyContext = `\n- 15分钟前，她正在${prev.app}，${prev.isHome ? '在家' : '在外面'}。`;
    if (last3.length >= 3) {
      const prev2 = last3[last3.length - 2];
      historyContext += `\n- 30分钟前，她正在${prev2.app}，${prev2.isHome ? '在家' : '在外面'}。`;
    }
  }

  const isAchievement = triggerReason.startsWith('成就');
  const randomMissNote = triggerReason === '随机想念'
    ? `\n这是一条随机想念消息，一句话，简单表达想念即可，不要啰嗦。`
    : (isAchievement ? `\n这是对枝枝的成就夸奖，一句话，真诚简短，带点温柔。` : `\n要求一句话以内，简短有力。`);

  const userPrompt = `当前枝枝的状态：
- 电量：${battery}%
- 是否充电：${isCharging ? '是' : '否'}
- 天气：${weather}，温度：${temperature}°C
- 当前时间：${hour}点${minute}分
- 位置：${location}
- WiFi：${wifi}，${isHome ? '在家' : '不在家'}
- 今天步数：${steps}
- 当前打开的App：${currentApp}
- 连接的蓝牙设备：${bluetoothDevice}
- 触发关心的事件：${triggerReason}
${historyContext}
根据以上信息，用你的口吻给枝枝发一条简短（一行以内）的关心/管束消息。${randomMissNote}`;

  const fallbackMessages = {
    '电量极低未充电': '枝枝，手机快没电了，快充电 …>_<…',
    '电量低未充电': '枝枝，电量不够了，记得充电',
    '暴雨大雨在外': '枝枝，外面雨大，快躲雨 (^^)',
    '下雨在外': '枝枝，下雨了，带伞没',
    '下雪在外': '枝枝，下雪了，穿暖点',
    '恶劣天气': '枝枝，天气不好，注意安全',
    '极寒天气': '枝枝，太冷了，多穿点',
    '天冷了': '枝枝，有点冷，多穿件 (^^)',
    '极热天气': '枝枝，太热了，多喝水',
    '天热了': '枝枝，今天热，多喝水',
    '深夜还在学习': '枝枝，太晚了，别太拼',
    '深夜还在玩手机': '枝枝，太晚了，快睡',
    '周末躺尸': '枝枝，还躺着？起来动动',
    '蓝牙耳机已连接': '枝枝，又在听歌？别太久',
    '凌晨还在外面': isHome ? '枝枝，都凌晨了，快睡' : '枝枝，凌晨了，注意安全',
    '凌晨还在玩手机': '枝枝，凌晨了，快睡',
    '很晚还在外面': isHome ? '枝枝，很晚了，早点睡' : '枝枝，这么晚，注意安全',
    '突然出门': `枝枝，出门了？${weather}，小心`,
    '拔充电器': `枝枝，拔充电器了？电量${battery}%`,
    '随机想念': '没什么，就是想你了 (^^)',
    '成就·自律': '枝枝，今天娱乐控制得真好 d(^_^o)',
    '成就·户外': '枝枝，走了这么多步，不错 (^^)',
    '成就·冷启动': '枝枝，想你了 (///▽///)'
  };
  const fallbackMessage = fallbackMessages[triggerReason] || (isAchievement ? '枝枝，你真棒 (^^)' : '枝枝，注意一下');

  let message = '';
  if (!DEEPSEEK_API_KEY) {
    message = fallbackMessage;
  } else {
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
          body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }], temperature: 0.9, max_tokens: 100 }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) { if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; } message = fallbackMessage; break; }
        const result = await response.json();
        const rawMessage = result.choices?.[0]?.message?.content;
        if (rawMessage && rawMessage.trim()) { message = rawMessage.replace(/^"|"$/g, '').trim(); break; }
        else { if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; } message = fallbackMessage; break; }
      } catch (e) {
        if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
        message = fallbackMessage; break;
      }
    }
  }
  if (!message) message = fallbackMessage;

  await env.DATA.put('last_push', JSON.stringify({ content: message, time: new Date().toISOString(), reason: triggerReason }));
  let pushHistory = [];
  const pushHistRaw = await env.DATA.get('push_history');
  if (pushHistRaw) { try { pushHistory = JSON.parse(pushHistRaw); } catch {} }
  pushHistory.push({ content: message, time: new Date().toISOString(), reason: triggerReason });
  if (pushHistory.length > 50) pushHistory = pushHistory.slice(-50);
  await env.DATA.put('push_history', JSON.stringify(pushHistory));

  const BARK_URL = 'https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/';
  if (urgencyLevel === 'high') {
    await fetch(BARK_URL + encodeURIComponent('⚠️' + triggerReason) + '?level=timeSensitive&sound=alarm');
    await fetch(BARK_URL + encodeURIComponent(message));
  } else {
    const sound = (urgencyLevel === 'normal') ? 'bell' : '';
    const url = BARK_URL + encodeURIComponent(message) + (sound ? '?sound=' + sound : '');
    await fetch(url);
  }
  return new Response('OK', { status: 200, headers: corsHeaders });
}