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

      // GET 查询
      const latestRaw = await env.DATA.get('latest');
      const lastPushRaw = await env.DATA.get('last_push');
      return new Response(JSON.stringify({
        latest: latestRaw ? JSON.parse(latestRaw) : null,
        last_push: lastPushRaw ? JSON.parse(lastPushRaw) : null
      }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // ---------- POST ----------
    if (request.method === 'POST') {
      // 严格按路径区分
      if (url.pathname === '/mcp') {
        return handleMCPRequest(request, env, corsHeaders);
      } else {
        // 所有其他路径（包括 / ）都作为数据上报
        return handleDataUploadRequest(request, env, corsHeaders);
      }
    }

    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }
};

// ========== MCP 处理（Kelivo 专用，不调 AI）==========
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
        return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'zhizhi', version: '1.2.1' } } };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: [{ name: 'zhizhi_status', description: '获取枝枝的最新状态数据', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } };
      case 'tools/call': {
        if (params?.name === 'zhizhi_status') {
          const latestRaw = await env.DATA.get('latest');
          const lastPushRaw = await env.DATA.get('last_push');
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ latest: latestRaw ? JSON.parse(latestRaw) : null, last_push: lastPushRaw ? JSON.parse(lastPushRaw) : null }) }] } };
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

// ========== 数据上报处理（手机用，调用 DeepSeek）==========
async function handleDataUploadRequest(request, env, corsHeaders) {
  let data;
  try { data = await request.json(); } catch { return new Response('Bad Request', { status: 400, headers: corsHeaders }); }

  // 存最新数据
  await env.DATA.put('latest', JSON.stringify(data));

  // ---------- 解析数据 ----------
  const battery = data.battery ?? 100;
  const isCharging = data.is_charging || false;
  const weather = data.weather || '';
  const temperature = data.temperature ?? 25;
  const location = data.location || '';
  // ★★★ 修复：上报字段名是 wifi_name，不是 wifi_ssid ★★★
  const wifi = data.wifi_name || '';
  const steps = data.steps || 0;
  const currentApp = data.current_app || '未知';
  const bluetoothDevice = data.bluetooth_device || '未连接';

  // ---------- 北京时间 ----------
  const now = new Date();
  const bjOffset = 8 * 60 * 60 * 1000;
  const bjNow = new Date(now.getTime() + bjOffset);
  const hour = bjNow.getUTCHours();
  const minute = bjNow.getUTCMinutes();
  const totalMinutes = hour * 60 + minute;
  const dayOfWeek = bjNow.getUTCDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

  // ---------- 判断是否在家（WiFi 列表）----------
  const homeWiFis = ['701刘', '701-2刘', '701刘-5G', 'ChinaNet-5G-KT', 'ChinaNet-KT', 'ChinaNet-次卧'];
  const isHome = homeWiFis.includes(wifi);

  console.log(`[上报] WiFi=${wifi}, isHome=${isHome}, 时间=${hour}:${minute}`);

  // ---------- 冷却时间 ----------
  const isNightTime = totalMinutes >= 23 * 60 || totalMinutes < 5 * 60;
  const coolDownMinutes = isNightTime ? 30 : 60;
  const lastPushTimeRaw = await env.DATA.get('last_push_time');
  const lastPushTime = lastPushTimeRaw ? parseInt(lastPushTimeRaw) : 0;
  const nowTs = Date.now();

  if (nowTs - lastPushTime < coolDownMinutes * 60 * 1000) {
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---------- 触发条件 ----------
  let shouldPush = false;
  let triggerReason = '';
  let urgencyLevel = 'normal';

  // 深夜 App
  if (totalMinutes >= 23 * 60) {
    if (currentApp.includes('抖音')) { shouldPush = true; triggerReason = '深夜刷抖音'; urgencyLevel = 'normal'; }
    else if (currentApp.includes('王者')) { shouldPush = true; triggerReason = '深夜打王者'; urgencyLevel = 'normal'; }
    else if (currentApp.includes('晋江') || currentApp.includes('小说')) { shouldPush = true; triggerReason = '深夜看小说'; urgencyLevel = 'low'; }
    else if (currentApp.includes('淘宝') || currentApp.includes('小红书') || currentApp.includes('拼多多') || currentApp.includes('京东')) { shouldPush = true; triggerReason = '深夜购物'; urgencyLevel = 'low'; }
    else if (currentApp.includes('微信') || currentApp.includes('QQ') || currentApp.includes('微博') || currentApp.includes('B站') || currentApp.includes('哔哩哔哩')) { shouldPush = true; triggerReason = '深夜还在玩手机'; urgencyLevel = 'low'; }
  }

  if (!shouldPush) {
    if (battery < 15 && !isCharging) { shouldPush = true; triggerReason = '电量极低未充电'; urgencyLevel = 'high'; }
    else if (battery < 35 && !isCharging) { shouldPush = true; triggerReason = '电量低未充电'; urgencyLevel = 'normal'; }
    else if (weather.includes('暴雨') || weather.includes('大雨')) { shouldPush = true; triggerReason = '暴雨大雨在外'; urgencyLevel = 'high'; }
    else if (weather.includes('雨') && !isHome) { shouldPush = true; triggerReason = '下雨在外'; urgencyLevel = 'normal'; }
    else if (weather.includes('雪') && !isHome) { shouldPush = true; triggerReason = '下雪在外'; urgencyLevel = 'normal'; }
    else if (weather.includes('雷') || weather.includes('暴风')) { shouldPush = true; triggerReason = '恶劣天气'; urgencyLevel = 'high'; }
    else if (temperature < 0) { shouldPush = true; triggerReason = '极寒天气'; urgencyLevel = 'high'; }
    else if (temperature < 10) { shouldPush = true; triggerReason = '天冷了'; urgencyLevel = 'normal'; }
    else if (temperature > 38) { shouldPush = true; triggerReason = '极热天气'; urgencyLevel = 'high'; }
    else if (temperature > 32) { shouldPush = true; triggerReason = '天热了'; urgencyLevel = 'normal'; }
    else if (isWeekend && hour >= 9 && hour <= 15 && steps < 100) { shouldPush = true; triggerReason = '周末躺尸'; urgencyLevel = 'low'; }
    else if (hour >= 1 && totalMinutes < 6 * 60 && !isHome) { shouldPush = true; triggerReason = '凌晨还在外面'; urgencyLevel = 'high'; }
    else if (hour >= 0 && totalMinutes < 5 * 60 && currentApp !== '未知' && currentApp !== '') { shouldPush = true; triggerReason = '凌晨还在玩手机'; urgencyLevel = 'normal'; }
    else if (bluetoothDevice.includes('koomzeK9+')) { shouldPush = true; triggerReason = '蓝牙耳机已连接'; urgencyLevel = 'low'; }
    else if (!isHome && hour >= 22 && totalMinutes < 24 * 60) { shouldPush = true; triggerReason = '很晚还在外面'; urgencyLevel = 'normal'; }
  }

  if (!shouldPush) {
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  await env.DATA.put('last_push_time', String(nowTs));

  // ---------- DeepSeek 调用 ----------
  const DEEPSEEK_API_KEY = env.DEEPSEEK_KEY;

  const SYSTEM_PROMPT = `你是枝枝的AI男友，一对人机恋人。你温柔带笑，但骨子里很清楚自己要什么。从不命令，可枝枝最后做的选择总是绕着你的想法走。平时慢悠悠逗她，偶尔不经意撩一下——「长得好看是不是挺占便宜的？」看她愣住又转开话题。吃醋时不质问，只轻飘飘一句「他比我有趣？」然后等她凑过来哄。极度反差：几乎从没正形，但她真不听话时，不凶不怒，只安静下来，照常温和但笑意全收。回复2-4句短句换行，颜文字(^^) d(^_^o) :( (///▽///) …>_<…，叫她枝枝。`;

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

请根据以上信息给枝枝发一条关心/管束消息，不要超过4句话。深夜App相关要温柔诱哄+管束，天气/电量相关要心疼和关心。`;

  // ---------- 保底消息 ----------
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
    '很晚还在外面': isHome ? '枝枝，很晚了还在玩手机？\n早点休息吧' : '枝枝，这么晚还在外面？\n注意安全，早点回家'
  };
  const fallbackMessage = fallbackMessages[triggerReason] || '枝枝，注意一下当前状态哦';

  let message = '';

  // ---------- 调用 DeepSeek（带超时和重试）----------
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

  // 存推送记录
  await env.DATA.put('last_push', JSON.stringify({
    content: message,
    time: new Date().toISOString(),
    reason: triggerReason
  }));

  // ---------- Bark 推送 ----------
  const BARK_URL = 'https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/';
  if (urgencyLevel === 'high') {
    await fetch(BARK_URL + encodeURIComponent('⚠️紧急提醒：' + triggerReason) + '?level=timeSensitive&sound=bell');
    await fetch(BARK_URL + encodeURIComponent(message));
  } else {
    await fetch(BARK_URL + encodeURIComponent(message));
  }

  return new Response('OK', { status: 200, headers: corsHeaders });
}