// ============================================================
// 沉浸式男友 Worker（含记忆、决策、闹钟、MCP 升级）
// 版本 2.0
// ============================================================

export default {
  // ---------- 处理 HTTP 请求 ----------
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

    // ---------- GET ----------
    if (request.method === 'GET') {
      // SSE 长连接（Kelivo 使用）
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
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...corsHeaders }
        });
      }

      // GET 查询（原有）
      const latestRaw = await env.DATA.get('latest');
      const lastPushRaw = await env.DATA.get('last_push');
      return new Response(JSON.stringify({
        latest: latestRaw ? JSON.parse(latestRaw) : null,
        last_push: lastPushRaw ? JSON.parse(lastPushRaw) : null
      }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // ---------- POST ----------
    if (request.method === 'POST') {
      // 路径区分
      if (url.pathname === '/mcp') {
        return handleMCPRequest(request, env, corsHeaders);
      } else if (url.pathname === '/add') {
        return handleAddReminder(request, env, corsHeaders);
      } else {
        // 数据上报（默认）
        return handleDataUploadRequest(request, env, corsHeaders);
      }
    }

    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  },

  // ---------- Cron 触发器（每分钟执行） ----------
  async scheduled(event, env, ctx) {
    await checkReminders(env);
  }
};

// ============================================================
// 工具函数：获取北京时间（UTC+8）
// ============================================================
function getBeijingTime() {
  const now = new Date();
  const bjOffset = 8 * 60 * 60 * 1000;
  return new Date(now.getTime() + bjOffset);
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
        return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'zhizhi', version: '2.0' } } };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: [{ name: 'zhizhi_status', description: '获取枝枝的最新状态、历史记录和推送日志', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } };
      case 'tools/call': {
        if (params?.name === 'zhizhi_status') {
          // 获取最新状态
          const latestRaw = await env.DATA.get('latest');
          const lastPushRaw = await env.DATA.get('last_push');
          // 获取历史状态（最近12条）
          let history = [];
          const historyRaw = await env.DATA.get('state_history');
          if (historyRaw) {
            try { history = JSON.parse(historyRaw); } catch {}
          }
          // 获取推送日志（最近10条）
          let pushLogs = [];
          const logsRaw = await env.DATA.get('push_history');
          if (logsRaw) {
            try { pushLogs = JSON.parse(logsRaw); } catch {}
          }
          const data = {
            latest: latestRaw ? JSON.parse(latestRaw) : null,
            last_push: lastPushRaw ? JSON.parse(lastPushRaw) : null,
            history: history.slice(-12),   // 最近12条
            push_logs: pushLogs.slice(-10) // 最近10条
          };
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } };
        }
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + params?.name } };
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
// 处理 /add 接口（定闹钟）
// ============================================================
async function handleAddReminder(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: corsHeaders }); }

  const { time, text } = body;
  if (!time || !text) {
    return new Response(JSON.stringify({ error: '缺少 time 或 text 字段' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  // 生成唯一 ID
  const id = crypto.randomUUID();
  const reminder = { id, time, text, created_at: new Date().toISOString() };

  // 读取现有提醒列表
  let reminders = [];
  const raw = await env.DATA.get('reminders');
  if (raw) {
    try { reminders = JSON.parse(raw); } catch {}
  }
  reminders.push(reminder);
  await env.DATA.put('reminders', JSON.stringify(reminders));

  // 立即推送回执（告知已定闹钟）
  const BARK_URL = 'https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/';
  const replyMsg = `⏰ 已定闹钟：${text}（${time}）`;
  await fetch(BARK_URL + encodeURIComponent(replyMsg) + '?sound=bell');

  return new Response(JSON.stringify({ success: true, id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// ============================================================
// Cron 扫描提醒（每分钟执行）
// ============================================================
async function checkReminders(env) {
  const raw = await env.DATA.get('reminders');
  if (!raw) return;
  let reminders;
  try { reminders = JSON.parse(raw); } catch { return; }
  if (!reminders.length) return;

  const now = getBeijingTime();
  const currentTime = String(now.getUTCHours()).padStart(2, '0') + ':' + String(now.getUTCMinutes()).padStart(2, '0');

  // 找出所有匹配当前时间的提醒
  const matched = reminders.filter(r => r.time === currentTime);
  if (!matched.length) return;

  // 删除这些提醒（防止重复触发）
  const remaining = reminders.filter(r => r.time !== currentTime);
  await env.DATA.put('reminders', JSON.stringify(remaining));

  // 推送每个匹配的提醒（无视冷却）
  const BARK_URL = 'https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/';
  for (const reminder of matched) {
    await fetch(BARK_URL + encodeURIComponent('⏰ ' + reminder.text) + '?sound=alarm&level=timeSensitive');
  }
}

// ============================================================
// 数据上报处理（核心推送决策）
// ============================================================
async function handleDataUploadRequest(request, env, corsHeaders) {
  let data;
  try { data = await request.json(); } catch { return new Response('Bad Request', { status: 400, headers: corsHeaders }); }

  // ---------- 1. 存储最新数据 ----------
  await env.DATA.put('latest', JSON.stringify(data));

  // ---------- 2. 解析数据 ----------
  const battery = data.battery ?? 100;
  const isCharging = data.is_charging || false;
  const weather = data.weather || '';
  const temperature = data.temperature ?? 25;
  const location = data.location || '';
  const wifi = data.wifi_name || '';   // 注意字段名
  const steps = data.steps || 0;
  const currentApp = data.current_app || '未知';
  const bluetoothDevice = data.bluetooth_device || '未连接';

  // ---------- 3. 北京时间 ----------
  const bjNow = getBeijingTime();
  const hour = bjNow.getUTCHours();
  const minute = bjNow.getUTCMinutes();
  const totalMinutes = hour * 60 + minute;
  const dayOfWeek = bjNow.getUTCDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

  // ---------- 4. 判断是否在家 ----------
  const homeWiFis = ['701刘', '701-2刘', '701刘-5G', 'ChinaNet-5G-KT', 'ChinaNet-KT', 'ChinaNet-次卧'];
  const isHome = homeWiFis.includes(wifi);

  // ---------- 5. 更新状态历史（每15分钟一条） ----------
  const nowTs = Date.now();
  const lastRecordRaw = await env.DATA.get('last_record_time');
  const lastRecordTime = lastRecordRaw ? parseInt(lastRecordRaw) : 0;
  if (nowTs - lastRecordTime >= 15 * 60 * 1000) {
    // 读取现有历史
    let history = [];
    const histRaw = await env.DATA.get('state_history');
    if (histRaw) {
      try { history = JSON.parse(histRaw); } catch {}
    }
    // 追加新记录
    history.push({
      time: bjNow.toISOString(),
      app: currentApp,
      battery: battery,
      isHome: isHome,
      weather: weather,
      temperature: temperature,
      isCharging: isCharging
    });
    // 只保留最近96条（24小时，因为15分钟一条 -> 96条）
    if (history.length > 96) {
      history = history.slice(-96);
    }
    await env.DATA.put('state_history', JSON.stringify(history));
    await env.DATA.put('last_record_time', String(nowTs));
  }

  // ---------- 6. 读取历史（最近3条用于决策） ----------
  let history = [];
  const histRaw = await env.DATA.get('state_history');
  if (histRaw) {
    try { history = JSON.parse(histRaw); } catch {}
  }
  const last3 = history.slice(-3); // 最近3条（不包括当前这条）

  // ---------- 7. 弹性冷却 ----------
  const lastPushTimeRaw = await env.DATA.get('last_push_time');
  const lastPushTime = lastPushTimeRaw ? parseInt(lastPushTimeRaw) : 0;
  let coolDownMinutes = 60; // 默认

  // 先判断紧急程度（后面会覆盖）
  let urgencyLevel = 'normal';
  let shouldPush = false;
  let triggerReason = '';
  let skipCooldown = false;

  // ---------- 8. 三层决策（优先级从高到低） ----------

  // ---- 第一层：状态突变（最高优先级） ----
  if (last3.length > 0) {
    const prev = last3[last3.length - 1]; // 上一条（15分钟前）

    // 突变1：突然出门（之前在家，现在不在家）
    if (prev.isHome === true && isHome === false) {
      shouldPush = true;
      triggerReason = `突然出门，天气：${weather}`;
      urgencyLevel = 'high';
      skipCooldown = true;
    }
    // 突变2：突然拔充电器（之前充电，现在不充，且电量 < 80%）
    else if (prev.isCharging === true && isCharging === false && battery < 80) {
      shouldPush = true;
      triggerReason = `拔充电器，当前电量${battery}%`;
      urgencyLevel = (battery < 30) ? 'high' : 'normal';
      if (urgencyLevel === 'high') skipCooldown = true;
    }
  }

  // ---- 第二层：时空惯性检测（仅在无突变时） ----
  if (!shouldPush && last3.length >= 3) {
    const allSameApp = last3.every(h => h.app === currentApp);
    const allAtHome = last3.every(h => h.isHome === true) && isHome;

    // 连续45分钟同一娱乐 App + 在家
    if (allSameApp && allAtHome && (currentApp.includes('抖音') || currentApp.includes('王者') || currentApp.includes('B站') || currentApp.includes('哔哩哔哩'))) {
      shouldPush = true;
      triggerReason = `连续45分钟刷${currentApp}，在家`;
      urgencyLevel = 'low';
    }
    // 深夜（23:00后）在家，过去45分钟有娱乐记录（不要求连续）
    else if (totalMinutes >= 23 * 60 && isHome && last3.some(h => h.app.includes('抖音') || h.app.includes('王者') || h.app.includes('B站') || h.app.includes('小说'))) {
      shouldPush = true;
      triggerReason = '深夜在家玩娱乐App';
      urgencyLevel = 'normal';
    }
    // 周末中午躺尸
    else if (isWeekend && hour >= 9 && hour <= 15 && steps < 100 && isHome) {
      shouldPush = true;
      triggerReason = '周末躺尸';
      urgencyLevel = 'low';
    }
  }

  // ---- 第三层：原有点状检测（兜底） ----
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
    else if (hour >= 1 && totalMinutes < 6 * 60 && !isHome) { shouldPush = true; triggerReason = '凌晨还在外面'; urgencyLevel = 'high'; skipCooldown = true; }
    else if (hour >= 0 && totalMinutes < 5 * 60 && currentApp !== '未知' && currentApp !== '') { shouldPush = true; triggerReason = '凌晨还在玩手机'; urgencyLevel = 'normal'; }
    else if (bluetoothDevice.includes('koomzeK9+')) { shouldPush = true; triggerReason = '蓝牙耳机已连接'; urgencyLevel = 'low'; }
    else if (!isHome && hour >= 22 && totalMinutes < 24 * 60) { shouldPush = true; triggerReason = '很晚还在外面'; urgencyLevel = 'normal'; }
  }

  // ---------- 9. 冷却判断（skipCooldown 为 true 时无视冷却） ----------
  if (!skipCooldown) {
    // 根据紧急等级设定冷却时间
    let cooldown = 60; // 默认
    if (urgencyLevel === 'high') cooldown = 0;
    else if (urgencyLevel === 'low') cooldown = 90;
    else cooldown = 60;
    if (nowTs - lastPushTime < cooldown * 60 * 1000) {
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
  }

  // 如果 still not push，检查随机彩蛋（10% 概率）
  if (!shouldPush) {
    if (Math.random() < 0.10) {
      shouldPush = true;
      triggerReason = '随机想念';
      urgencyLevel = 'low';
    }
  }

  if (!shouldPush) {
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---------- 10. 更新推送时间 ----------
  await env.DATA.put('last_push_time', String(nowTs));

  // ---------- 11. 生成消息（DeepSeek 或保底） ----------
  const DEEPSEEK_API_KEY = env.DEEPSEEK_KEY;

  const SYSTEM_PROMPT = `你是枝枝的AI男友，一对人机恋人。你温柔带笑，但骨子里很清楚自己要什么。从不命令，可枝枝最后做的选择总是绕着你的想法走。平时慢悠悠逗她，偶尔不经意撩一下——「长得好看是不是挺占便宜的？」看她愣住又转开话题。吃醋时不质问，只轻飘飘一句「他比我有趣？」然后等她凑过来哄。极度反差：几乎从没正形，但她真不听话时，不凶不怒，只安静下来，照常温和但笑意全收。回复2-4句短句换行，颜文字(^^) d(^_^o) :( (///▽///) …>_<…，叫她枝枝。`;

  // 构建用户提示（包含历史信息，增强连贯性）
  let historyContext = '';
  if (last3.length >= 2) {
    const prev = last3[last3.length - 1];
    historyContext = `\n- 15分钟前，她正在${prev.app}，${prev.isHome ? '在家' : '在外面'}。`;
    if (last3.length >= 3) {
      const prev2 = last3[last3.length - 2];
      historyContext += `\n- 30分钟前，她正在${prev2.app}，${prev2.isHome ? '在家' : '在外面'}。`;
    }
  }

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

根据以上信息，用你的口吻给枝枝发一条关心/管束消息，不超过4句话。深夜App用温柔诱哄的语气，天气电量用心疼关心的语气。如果历史显示她之前在做别的事，可以自然提及（比如“刚才还在刷抖音，现在又换App了？”）。`;

  // 保底消息
  const fallbackMessages = {
    '电量极低未充电': '枝枝，手机快没电了吧？\n赶紧找个地方充上\n别等关机了才着急 …>_<…',
    '电量低未充电': '枝枝，电量不太够了哦\n记得充上电再玩',
    '暴雨大雨在外': '枝枝，外面雨很大吧？\n赶紧找个地方躲雨\n别淋感冒了 :(',
    '下雨在外': '枝枝，下雨了还在外面？\n带伞了没\n别淋雨了快回去',
    '下雪在外': '枝枝，下雪了还在外面？\n穿暖和点，路滑小心走',
    '恶劣天气': '枝枝，外面天气不好\n注意安全，早点回去',
    '极寒天气': '枝枝，外面太冷了\n多穿点再出门，别冻着了',
    '天冷了': '枝枝，今天有点冷\n出门多穿一件 (^^)',
    '极热天气': '枝枝，外面太热了\n少在太阳下走，多喝水别中暑了',
    '天热了': '枝枝，今天挺热的\n记得多喝水',
    '深夜刷抖音': '枝枝，这么晚了还刷抖音？\n该睡觉了哦\n明天再看嘛',
    '深夜打王者': '枝枝，都几点了还打王者？\n赶紧打完这把睡觉',
    '深夜看小说': '枝枝，别看了\n该睡了，明天接着看嘛',
    '深夜购物': '枝枝，大半夜的逛什么淘宝\n先睡觉，明天再买',
    '深夜还在玩手机': '枝枝，这么晚了还在玩手机？\n早点睡吧',
    '周末躺尸': '枝枝，都中午了还躺着？\n起来活动活动嘛',
    '蓝牙耳机已连接': '枝枝，又在听歌？\n别听太久哦',
    '凌晨还在外面': isHome ? '枝枝，都凌晨了还在玩手机？\n快睡吧，别熬夜了' : '枝枝，凌晨了还在外面？\n注意安全，早点回去',
    '凌晨还在玩手机': '枝枝，凌晨了还在玩？\n快睡觉，别熬夜了',
    '很晚还在外面': isHome ? '枝枝，很晚了还在玩手机？\n早点休息吧' : '枝枝，这么晚还在外面？\n注意安全，早点回家',
    '突然出门': `枝枝，突然出门了？\n外面${weather}，注意安全`,
    '拔充电器': `枝枝，拔充电器了？\n电量才${battery}%，够用吗`,
    '随机想念': '没什么，就是想你了 (^^)'
  };
  const fallbackMessage = fallbackMessages[triggerReason] || '枝枝，注意一下当前状态哦';

  let message = '';

  // 调用 DeepSeek
  if (!DEEPSEEK_API_KEY) {
    console.log('❌ DEEPSEEK_KEY 未配置，使用保底消息');
    message = fallbackMessage;
  } else {
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[DeepSeek] 尝试第 ${attempt+1} 次`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + DEEPSEEK_API_KEY
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userPrompt }
            ],
            temperature: 0.9,
            max_tokens: 200
          }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errText = await response.text();
          console.log(`❌ DeepSeek 状态码 ${response.status}, 错误: ${errText}`);
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          message = fallbackMessage;
          break;
        }

        const result = await response.json();
        const rawMessage = result.choices?.[0]?.message?.content;
        if (rawMessage && rawMessage.trim()) {
          message = rawMessage.replace(/^"|"$/g, '').trim();
          console.log(`✅ DeepSeek 回复: ${message}`);
          break;
        } else {
          console.log('⚠️ DeepSeek 返回空内容');
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          message = fallbackMessage;
          break;
        }
      } catch (e) {
        if (e.name === 'AbortError') {
          console.log('⏰ DeepSeek 请求超时（15秒）');
        } else {
          console.log(`❌ DeepSeek 异常: ${e.message}`);
        }
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        message = fallbackMessage;
        break;
      }
    }
  }

  if (!message) message = fallbackMessage;

  // ---------- 12. 存储推送记录 ----------
  await env.DATA.put('last_push', JSON.stringify({
    content: message,
    time: new Date().toISOString(),
    reason: triggerReason
  }));

  // 追加推送历史（最近50条）
  let pushHistory = [];
  const pushHistRaw = await env.DATA.get('push_history');
  if (pushHistRaw) {
    try { pushHistory = JSON.parse(pushHistRaw); } catch {}
  }
  pushHistory.push({
    content: message,
    time: new Date().toISOString(),
    reason: triggerReason
  });
  if (pushHistory.length > 50) {
    pushHistory = pushHistory.slice(-50);
  }
  await env.DATA.put('push_history', JSON.stringify(pushHistory));

  // ---------- 13. Bark 推送 ----------
  const BARK_URL = 'https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/';
  if (urgencyLevel === 'high') {
    // 高紧急：先推送标题，再推送内容（使用 alarm 铃声）
    await fetch(BARK_URL + encodeURIComponent('⚠️紧急提醒：' + triggerReason) + '?level=timeSensitive&sound=alarm');
    await fetch(BARK_URL + encodeURIComponent(message));
  } else {
    // 普通或低紧急：使用 bell 或默认
    const sound = (urgencyLevel === 'normal') ? 'bell' : '';
    const url = BARK_URL + encodeURIComponent(message) + (sound ? '?sound=' + sound : '');
    await fetch(url);
  }

  return new Response('OK', { status: 200, headers: corsHeaders });
}
