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