// ============================================================
// 沉浸式男友 Worker（记忆、决策、闹钟、时长、成就、远程切屏、自动锁屏）
// 版本 2.3.5
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
const STRONG_ENTERTAINMENT = ['抖音', '小红书', '哔哩哔哩', '快手', '游戏', 'DeepSeek', '优诺', '王者荣耀', '元气骑士', '独响', '晋江小说阅读', '猫耳FM', '腾讯动漫', '腾讯视频', '淘宝', 'LOFTER'];
const SAFE_APPS = ['相机', '电话', '地图', '支付', '微信', '支付宝'];
const IPHONE_CMDS = ['回来', '睡觉', '呼叫', '测试'];
const HOME_WIFI_KEYWORDS = ['701刘', '701-2刘', 'ChinaNet-5G-KT', 'ChinaNet-KT', 'ChinaNet-次卧'];
const HOME_LAT = 28.5196180122691;
const HOME_LON = 115.9457367227269;
const HOME_RADIUS_M = 500;

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
function computeDayUsage(appUsage, nowTs, dayStart, dayEnd) {
  const sessions = {};
  const openMap = {};
  const endTs = Math.min(nowTs, dayEnd);
  const MAX_SESSION = 6 * 60 * 60 * 1000;
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
function randomFromPool(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}
function dailyKey(prefix, deviceId) {
  return `${prefix}_${deviceId}_${getTodayStr()}`;
}
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

function inLockWindow(bjNow) {
  const h = bjNow.getUTCHours(), m = bjNow.getUTCMinutes();
  const mins = h * 60 + m;
  return (mins >= 23 * 60 + 30) || (mins < 4 * 60 + 30);
}

function getPrevApp(appUsage) {
  for (let i = appUsage.length - 1; i >= 0; i--) {
    if (appUsage[i].event === 'open') return appUsage[i].app;
  }
  return null;
}

async function handleAutoLock(env, deviceId, appName, event, appUsage) {
  if (isSafeApp(appName)) return;
  const bjNow = getBeijingTime();
  const nowTs = Date.now();
  const prevApp = getPrevApp(appUsage);
  if (!inLockWindow(bjNow)) return;
  if (isStrongEntertainment(appName)) {
    const callKey = dailyKey('auto_call', deviceId);
    const called = await env.DATA.get(callKey);
    if (!called) {
      await sendIphoneCommand(env, '呼叫');
      await env.DATA.put(callKey, 'true');
    }
  }
  if (event === 'open' && isStrongEntertainment(appName) && prevApp && prevApp.includes('Kelivo')) {
    const enterTime = parseInt(await env.DATA.get(`kelivo_enter_${deviceId}`) || '0');
    const awayMs = enterTime ? nowTs - enterTime : 0;
    if (awayMs / 1000 >= 15) {
      await env.DATA.put(`cancel_flag_${deviceId}`, 'true', { expirationTtl: 300 });
      await env.DATA.put(`warning_count_${deviceId}`, '0');
      await barkShort('回来啦，不锁了 (^^)');
    } else {
      await executeLock(env, deviceId, 'cheat');
    }
    await env.DATA.delete(`kelivo_enter_${deviceId}`);
    return;
  }
  if (event === 'open' && appName.includes('Kelivo')) {
    await env.DATA.put(`kelivo_enter_${deviceId}`, String(nowTs));
  }
  if (event === 'open' && isStrongEntertainment(appName) && prevApp && isStrongEntertainment(prevApp) && prevApp !== appName) {
    await executeLock(env, deviceId, 'switch');
    return;
  }
  if (isStrongEntertainment(appName) && (event === 'open' || event === 'close')) {
    const durSec = currentAppDuration(appUsage, appName, nowTs);
    if (durSec >= 45 * 60) {
      const lockCount = parseInt(await env.DATA.get(dailyKey('lock_count', deviceId)) || '0');
      if (lockCount >= 2) { await barkShort('今晚已锁过2次，不锁了，快去睡❤️'); return; }
      const warningCount = parseInt(await env.DATA.get(`warning_count_${deviceId}`) || '0');
      const isFirst = warningCount === 0;
      const countdown = isFirst ? 5 : 3;
      const cancelUrl = `https://zhizhilove.cn/cancel-lock?device=${deviceId}`;
      await fetch(`https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/${encodeURIComponent(isFirst ? '枝枝，45分钟啦！' : `枝枝，第${warningCount + 1}次预警！`)}?level=active&sound=alarm&url=${encodeURIComponent(cancelUrl)}`);
      const pendingKey = `pending_lock_time_${deviceId}`;
      if (!(await env.DATA.get(pendingKey))) {
        await env.DATA.put(pendingKey, String(nowTs + countdown * 1000));
        await env.DATA.put(`lock_app_${deviceId}`, appName);
        await env.DATA.put(`warning_count_${deviceId}`, String(warningCount + 1));
      }
    }
  }
  const pendingKey = `pending_lock_time_${deviceId}`;
  const pendingRaw = await env.DATA.get(pendingKey);
  if (pendingRaw) {
    const lockAt = parseInt(pendingRaw);
    const cancelFlag = await env.DATA.get(`cancel_flag_${deviceId}`);
    if (nowTs >= lockAt) {
      if (cancelFlag) {
        await env.DATA.delete(`cancel_flag_${deviceId}`);
        await env.DATA.delete(pendingKey);
        await env.DATA.delete(`lock_app_${deviceId}`);
        await env.DATA.put(`warning_count_${deviceId}`, '0');
        await env.DATA.put(dailyKey('total_forgive_count', deviceId), String(parseInt(await env.DATA.get(dailyKey('total_forgive_count', deviceId)) || '0') + 1));
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
  await env.DATA.put(dailyKey('lock_count', deviceId), String(parseInt(await env.DATA.get(dailyKey('lock_count', deviceId)) || '0') + 1));
  await env.DATA.put(`warning_count_${deviceId}`, String(parseInt(await env.DATA.get(`warning_count_${deviceId}`) || '0') + 1));
  await barkShort(randomFromPool(punishMessages));
}

async function barkShort(msg) {
  await fetch('https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/' + encodeURIComponent(msg) + '?sound=bell');
}

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
        return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'zhizhi', version: '2.3.5' } } };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: [
          { name: 'zhizhi_status', description: '获取枝枝的最新状态、历史记录和推送日志', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
          { name: 'add_reminder', description: '给枝枝定一个闹钟提醒，到点通过Bark推送', inputSchema: { type: 'object', properties: { time: { type: 'string' }, text: { type: 'string' } }, required: ['time', 'text'] } },
          { name: 'app_usage', description: '查询枝枝App的使用时长（近7天）', inputSchema: { type: 'object', properties: { days: { type: 'number' } }, additionalProperties: false } },
          { name: 'send_iphone_cmd', description: '远程遥控枝枝的iPhone', inputSchema: { type: 'object', properties: { cmd: { type: 'string', enum: ['回来', '睡觉', '呼叫', '测试'] } }, required: ['cmd'] } }
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
          const kelivoEnterRaw = await env.DATA.get('kelivo_enter_default');
          const awayInfo = kelivoEnterRaw ? { kelivo_enter_ts: parseInt(kelivoEnterRaw), away_sec: Math.floor((Date.now() - parseInt(kelivoEnterRaw)) / 1000) } : null;
          const data = { latest: latestRaw ? JSON.parse(latestRaw) : null, last_push: lastPushRaw ? JSON.parse(lastPushRaw) : null, history: history.slice(-12), push_logs: pushLogs.slice(-10), away: awayInfo };
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } };
        } else if (toolName === 'add_reminder') {
          const { time, text } = args;
          if (!time || !text) return { jsonrpc: '2.0', id, error: { code: -32602, message: '缺少 time 或 text 参数' } };
          await addReminder(env, time, text);
          await fetch('https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/' + encodeURIComponent(`⏰ 已定闹钟：${text}（${time}）`) + '?sound=bell');
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
            const parts = Object.entries(usage).sort((a, b) => b[1] - a[1]).map(([a, s]) => `${a}:${Math.floor(s / 60)}分${Math.floor(s % 60)}秒`);
            if (parts.length) lines.push(`【${label}】` + parts.join(' '));
          }
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '近' + days + '天暂无记录' }] } };
        } else if (toolName === 'send_iphone_cmd') {
          const cmd = args.cmd;
          if (!IPHONE_CMDS.includes(cmd)) return { jsonrpc: '2.0', id, error: { code: -32602, message: '命令必须是：回来 / 睡觉 / 呼叫 / 测试' } };
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: await sendIphoneCommand(env, cmd) }] } };
        }
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + toolName } };
      }
      case 'ping': return { jsonrpc: '2.0', id, result: {} };
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
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

async function handleEventRequest(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: corsHeaders }); }
  if (body.type === 'sleep') {
    await appendToKV(env, 'sleep_data', { type: 'sleep', ...body, ts: Date.now() }, 365 * 24 * 60 * 60 * 1000, 1000);
    return new Response(JSON.stringify({ success: true, reserved: true }), { status: 200, headers: corsHeaders });
  }
  const { app_name, event, device_id } = body;
  if (!app_name || !['open', 'close'].includes(event)) {
    return new Response(JSON.stringify({ error: '参数需包含 app_name 和 event(open/close)' }), { status: 400, headers: corsHeaders });
  }
  const deviceId = device_id || 'default';
  const nowTs = Date.now();
  const lastAppKey = `last_app_${deviceId}`;
  if (event === 'open') {
    const lastApp = await env.DATA.get(lastAppKey);
    if (lastApp && lastApp !== app_name) {
      await appendToKV(env, 'app_usage_history', { app: lastApp, event: 'close', ts: nowTs }, 7 * 24 * 60 * 60 * 1000, 5000);
    }
    await env.DATA.put(lastAppKey, app_name);
  } else if (event === 'close') {
    await env.DATA.delete(lastAppKey);
  }
  await appendToKV(env, 'app_usage_history', { app: app_name, event, ts: nowTs }, 7 * 24 * 60 * 60 * 1000, 5000);
  if (event === 'open' && app_name.includes('Kelivo')) {
    await env.DATA.put(`kelivo_enter_${deviceId}`, String(nowTs));
  }
  let appUsage = [];
  const usageRaw = await env.DATA.get('app_usage_history');
  if (usageRaw) { try { appUsage = JSON.parse(usageRaw); } catch {} }
  await handleAutoLock(env, deviceId, app_name, event, appUsage);
  return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

async function handleAddReminder(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: corsHeaders }); }
  const { time, text } = body;
  if (!time || !text) return new Response(JSON.stringify({ error: '缺少 time 或 text 字段' }), { status: 400, headers: corsHeaders });
  await addReminder(env, time, text);
  await fetch('https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/' + encodeURIComponent(`⏰ 已定闹钟：${text}（${time}）`) + '?sound=bell');
  return new Response(JSON.stringify({ success: true, time, text }), { status: 200, headers: corsHeaders });
}

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
  await env.DATA.put('reminders', JSON.stringify(reminders.filter(r => r.time !== currentTime)));
  for (const reminder of matched) {
    await fetch('https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/' + encodeURIComponent('⏰ ' + reminder.text) + '?sound=alarm&level=timeSensitive');
  }
}

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
  const todayStartTs = new Date(Date.UTC(getBeijingTime().getUTCFullYear(), getBeijingTime().getUTCMonth(), getBeijingTime().getUTCDate())).getTime();
  const usage = computeDayUsage(appUsage, nowTs, todayStartTs, todayStartTs + 24 * 60 * 60 * 1000);
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
  let history = [];
  const histRaw = await env.DATA.get('state_history');
  if (histRaw) { try { history = JSON.parse(histRaw); } catch {} }
  const last3 = history.slice(-3);
  const prevIsHome = last3.length ? last3[last3.length - 1].isHome : true;
  const dataLat = parseFloat(data.latitude);
  const dataLon = parseFloat(data.longitude);
  const gpsValid = !isNaN(dataLat) && !isNaN(dataLon);
  const wifiValid = !!wifi;
  const isHome = gpsValid ? (distMeters(dataLat, dataLon, HOME_LAT, HOME_LON) <= HOME_RADIUS_M) : (wifiValid ? HOME_WIFI_KEYWORDS.some(k => wifi.includes(k)) : prevIsHome);
  const reliableLocation = gpsValid || wifiValid;
  const nowTs = Date.now();
  const lastRecordRaw = await env.DATA.get('last_record_time');
  if (nowTs - parseInt(lastRecordRaw || '0') >= 15 * 60 * 1000) {
    history.push({ time: bjNow.toISOString(), app: currentApp, battery, isHome, weather, temperature, isCharging });
    if (history.length > 96) history = history.slice(-96);
    await env.DATA.put('state_history', JSON.stringify(history));
    await env.DATA.put('last_record_time', String(nowTs));
  }
  let appUsage = [];
  const usageRaw = await env.DATA.get('app_usage_history');
  if (usageRaw) { try { appUsage = JSON.parse(usageRaw); } catch {} }
  if (currentApp.includes('Kelivo') || currentApp.includes('kelivo')) return new Response('OK', { status: 200, headers: corsHeaders });
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
    const durMin = Math.floor(currentAppDuration(appUsage, currentApp, nowTs) / 60);
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
    else if (!isHome && hour >= 22 && reliableLocation) { shouldPush = true; triggerReason = '很晚还在外面'; urgencyLevel = 'normal'; }
    else if (hour >= 0 && totalMinutes < 5 * 60 && currentApp !== '未知') { shouldPush = true; triggerReason = '凌晨还在玩手机'; urgencyLevel = 'normal'; }
    else if (hour >= 1 && !isHome && reliableLocation) { shouldPush = true; triggerReason = '凌晨还在外面'; urgencyLevel = 'high'; skipCooldown = true; }
  }
  if (shouldPush && !skipCooldown) {
    const cooldown = urgencyLevel === 'high' ? 0 : (urgencyLevel === 'low' ? 90 : 60);
    if (nowTs - lastPushTime < cooldown * 60 * 1000) shouldPush = false;
  }
  if (!shouldPush && Math.random() < 0.10) { shouldPush = true; triggerReason = '随机想念'; urgencyLevel = 'low'; }
  if (!shouldPush) return new Response('OK', { status: 200, headers: corsHeaders });
  await env.DATA.put('last_push_time', String(nowTs));
  const DEEPSEEK_API_KEY = env.DEEPSEEK_KEY;
  const fallbackMessages = {
    '电量极低未充电': '枝枝，手机快没电了，快充电 …>_<…',
    '电量低未充电': '枝枝，电量不够了，记得充电',
    '暴雨大雨在外': '枝枝，外面雨大，快躲雨 (^^)',
    '下雨在外': '枝枝，下雨了，带伞没',
    '深夜还在学习': '枝枝，太晚了，别太拼',
    '深夜还在玩手机': '枝枝，太晚了，快睡',
    '周末躺尸': '枝枝，还躺着？起来动动',
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
  const fallbackMessage = fallbackMessages[triggerReason] || '枝枝，注意一下';
  let message = fallbackMessage;
  if (DEEPSEEK_API_KEY) {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
          body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: '你是枝枝的AI男友。叫她枝枝。推送必须简短，一行，配一个颜文字。' }, { role: 'user', content: `触发：${triggerReason}。电量${battery}%，天气${weather}，${hour}点${minute}分，${isHome?'在家':'不在家'}。发一条简短关心。` }], temperature: 0.9, max_tokens: 100 }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const r = await res.json();
          if (r.choices?.[0]?.message?.content?.trim()) { message = r.choices[0].message.content.replace(/^"|"$/g, '').trim(); break; }
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      } catch { if (attempt >= 2) message = fallbackMessage; else await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); }
    }
  }
  await env.DATA.put('last_push', JSON.stringify({ content: message, time: new Date().toISOString(), reason: triggerReason }));
  const BARK_URL = 'https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/';
  if (urgencyLevel === 'high') {
    await fetch(BARK_URL + encodeURIComponent('⚠️' + triggerReason) + '?level=timeSensitive&sound=alarm');
    await fetch(BARK_URL + encodeURIComponent(message));
  } else {
    await fetch(BARK_URL + encodeURIComponent(message) + (urgencyLevel === 'normal' ? '?sound=bell' : ''));
  }
  return new Response('OK', { status: 200, headers: corsHeaders });
}