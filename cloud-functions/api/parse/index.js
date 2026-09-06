import { parse } from '../../../lib/parsers/index.js';

export async function onRequest(ctx) {
  const request = ctx?.request ?? ctx;
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: '需要 POST 请求' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const url = body?.url;
  if (!url) return Response.json({ error: '请输入视频链接' }, { status: 400 });

  const t0 = Date.now();
  try {
    const thirdPartyApi = body.thirdPartyApi || process.env.THIRD_PARTY_API || '';
    const result = await parse(url, thirdPartyApi ? { thirdPartyApi } : {});
    result.cost = Date.now() - t0;
    return Response.json({ ok: true, data: result });
  } catch (e) {
    return Response.json({ ok: false, error: e.message || '解析失败' });
  }
}
