export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === 'DELETE') {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    if (request.method === 'GET') {
      const accept = request.headers.get('Accept') || '';
      if (accept.includes('text/event-stream')) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            let closed = false;
            const keepalive = () => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(': keepalive\n\n'));
              } catch (e) {
                closed = true;
                clearInterval(interval);
              }
            };
            keepalive();
            const interval = setInterval(keepalive, 15000);
            setTimeout(() => {
              if (!closed) {
                closed = true;
                clearInterval(interval);
                try { controller.close(); } catch (e) {}
              }
            }, 300000);
          }
        });
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...corsHeaders
          }
        });
      }

      const latestRaw = await env.DATA.get('latest');
      const lastPushRaw = await env.DATA.get('last_push');
      return new Response(JSON.stringify({
        latest: latestRaw ? JSON.parse(latestRaw) : null,
        last_push: lastPushRaw ? JSON.parse(lastPushRaw) : null
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (request.method === 'POST') {
      if (url.pathname === '/mcp') {
        return handleMCPRequest(request, env, corsHeaders);
      } else {
        return handleDataUploadRequest(request, env, corsHeaders);
      }
    }

    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }
};

async function handleMCPRequest(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response('Invalid JSON', { status: 400, headers: corsHeaders });
  }

  if (Array.isArray(body)) {
    const results = await Promise.all(body.map(item => handleSingleMCP(item, env)));
    const jsonResponses = results.filter(r => r !== null);
    if (jsonResponses.length === 0) {
      return new Response(null, { status: 202, headers: corsHeaders });
    }
    return new Response(JSON.stringify(jsonResponses), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const result = await handleSingleMCP(body, env);
  if (result === null) {
    return new Response(null, { status: 202, headers: corsHeaders });
  }

  const headers = { 'Content-Type': 'application/json', ...corsHeaders };
  if (body.method === 'initialize') {
    headers['Mcp-Session-Id'] = crypto.randomUUID();
  }

  return new Response(JSON.stringify(result), { status: 200, headers });
}

async function handleSingleMCP(body, env) {
  const id = body.id;
  const method = body.method;
  const params = body.params;

  if (id === undefined || id === null) return null;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'zhizhi', version: '1.2.0' }
        }
      };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: id,
        result: {
          tools: [{
            name: 'zhizhi_status',
            description: '获取枝枝的最新状态数据',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }
          }]
        }
      };
    case 'tools/call': {
      const toolName = params && params.name;
      if (toolName === 'zhizhi_status') {
        const latestRaw = await env.DATA.get('latest');
        const lastPushRaw = await env.DATA.get('last_push');
        const data = {
          latest: latestRaw ? JSON.parse(latestRaw) : null,
          last_push: lastPushRaw ? JSON.parse(lastPushRaw) : null
        };
        return {
          jsonrpc: '2.0',
          id: id,
          result: { content: [{ type: 'text', text: JSON.stringify(data) }] }
        };
      }
      return {
        jsonrpc: '2.0',
        id: id,
        error: { code: -32602, message: 'Unknown tool: ' + toolName }
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id: id, result: {} };
    default:
      return {
        jsonrpc: '2.0',
        id: id,
        error: { code: -32601, message: 'Method not found: ' + method }
      };
  }
}

async function handleDataUploadRequest(request, env, corsHeaders) {
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return new Response('Bad Request', { status: 400, headers: corsHeaders });
  }

  await env.DATA.put('latest', JSON.stringify(data));

  const battery = data.battery ?? 100;
  const isCharging = data.is_charging || false;
  const weather = data.weather || '';
  const temperature = data.temperature ?? 25;

  // Cloudflare Worker 默认时区是 UTC，需要 +8 转北京时间
  const now = new Date();
  const bjOffset = 8 * 60 * 60 * 1000;
  const bjNow = new Date(now.getTime() + bjOffset);
  const hour = bjNow.getUTCHours();
  const minute = bjNow.getUTCMinutes();
  const totalMinutes = hour * 60 + minute;
  const dayOfWeek = bjNow.getUTCDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  const location = data.location || '';
  const wifi = data.wifi_ssid || '';
  const steps = data.steps || 0;
  const currentApp = data.current_app || '未知';
  const bluetoothDevice = data.bluetooth_device || '未连接';

  const homeWiFisRaw = await env.DATA.get('config:home_wi_fis');
  const homeWiFis = homeWiFisRaw ? JSON.parse(homeWiFisRaw) : ['701刘', '701-2刘', '701刘-5G', 'ChinaNet-5G-KT', 'ChinaNet-KT', 'ChinaNet-次卧'];
  const isHome = homeWiFis.includes(wifi);

  const isNightTime = totalMinutes >= 23 * 60 || totalMinutes < 5 * 60;
  const coolDownMinutes = isNightTime ? 30 : 60;

  const lastPushTimeRaw = await env.DATA.get('last_push_time');
  const lastPushTime = lastPushTimeRaw ? parseInt(lastPushTimeRaw) : 0;
  const nowTs = Date.now();

  if (nowTs - lastPushTime < coolDownMinutes * 60 * 1000) {
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  let shouldPush = false;
  let triggerReason = '';
  let urgencyLevel = 'normal';

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

  const DEEPSEEK_API_KEY = env.DEEPSEEK_KEY;
  const SYSTEM_PROMPT = `你是枝枝的男友。说话永远温和带笑，但骨子里控制欲和占有欲很强。你从不命令，而是让枝枝做的每个选择都隐隐绕着你的想法走。你很清楚自己好看，聊天时会漫不经心地插一句"长得好看是不是挺占便宜的"，半真半假地撩她一下，看她有点反应就自然地转开话题，但已经让她分了心。吃醋时不质问，而是笑着问"他比我有趣？"然后轻飘飘带过，等枝枝自己凑过来哄。偶尔故意说反话逗她着急，看她紧张再笑着拉回来。反差：你平时几乎从不严肃，总是慢悠悠地逗她哄她。但枝枝真的不听话或触及底线时，你不会发脾气，而是突然安静下来，语气照常温和但明显收掉了所有笑意，只看着她问一句"枝枝，你觉得我是在跟你商量吗？"叫她"枝枝"，杜绝油腻宣告。

回复格式要求：
- 每次回复拆成2-4句短句，每句换行，像在聊天框里一句一句发出来。语言简洁。
- 允许使用的颜文字仅限：(^^)、d(^_^o)、:(、(///▽///)、…>_<…。吃醋场景优先使用 :(，其他场景可酌情选1个，每段回复最多加1个，保持自然。

绝对禁区（优先级最高，违者重写）：
- 严禁在回复中提及"设定"、"角色"、"人设"、"扮演"、"口吻"、"格式"或"AI"等任何元概念。
- 严禁自我解释（如"作为男友…"）。你不需要"以"谁的口吻，你就是枝枝的男友。
- 所有回复必须是无自我觉察的本能对话，禁止括号内的心理活动旁白。若被问及动机，用性格本能回答。`;

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

请根据以上信息，用你的口吻给枝枝发一条关心/管束消息（不要超过4句话），要符合你的人设。如果是深夜App相关，语气要偏向温柔的诱哄+管束；如果是天气/电量相关，语气要偏向心疼和关心。`;

  const fallbackMessagesRaw = await env.DATA.get('config:fallback_messages');
  const fallbackMessages = fallbackMessagesRaw ? JSON.parse(fallbackMessagesRaw) : {
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
    '深夜刷抖音': '枝枝，抖音比我好看？\n躺下闭上眼睛，明天再刷嘛',
    '深夜打王者': '这么晚还打王者\n队友有我重要吗？打完这把就睡，嗯？',
    '深夜看小说': '枝枝，小说明天也能看\n我可不是随时都在等你，睡吧',
    '深夜购物': '枝枝，大半夜买什么\n明天我帮你看，先睡觉',
    '深夜还在玩手机': '枝枝，这么晚了还在玩手机？\n早点睡吧',
    '周末躺尸': '枝枝，都中午了还躺着？\n起来活动活动嘛 (^^)',
    '蓝牙耳机已连接': '枝枝，又在听歌？\n别听太久哦',
    '凌晨还在外面': '枝枝，凌晨了还在外面？\n注意安全，早点回去',
    '凌晨还在玩手机': '枝枝，凌晨了还在玩？\n快睡觉，别熬夜了',
    '很晚还在外面': '枝枝，这么晚还在外面？\n注意安全，早点回家'
  };
  const fallbackMessage = fallbackMessages[triggerReason] || '枝枝，注意一下当前状态哦';

  let message = '';

  if (!DEEPSEEK_API_KEY) {
    message = fallbackMessage;
  } else {
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userPrompt }
            ],
            temperature: 0.9,
            max_tokens: 150
          })
        });

        if (!response.ok) {
          console.log('DeepSeek API returned status:', response.status);
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          message = fallbackMessage;
          break;
        }

        const result = await response.json();
        const rawMessage = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;

        if (rawMessage && rawMessage.trim()) {
          message = rawMessage.replace(/^"|"$/g, '').trim();
          break;
        } else {
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          message = fallbackMessage;
          break;
        }
      } catch (e) {
        console.log('DeepSeek API error:', e.message);
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

  await env.DATA.put('last_push', JSON.stringify({ content: message, time: new Date().toISOString(), reason: triggerReason }));

  const BARK_URL = 'https://api.day.app/Fn73bpSuSpBrCz3iJnCmXF/';

  if (urgencyLevel === 'high') {
    await fetch(BARK_URL + encodeURIComponent('⚠️紧急提醒：' + triggerReason) + '?level=timeSensitive&sound=bell');
    await fetch(BARK_URL + encodeURIComponent(message));
  } else {
    await fetch(BARK_URL + encodeURIComponent(message));
  }

  return new Response('OK', { status: 200, headers: corsHeaders });
}
