// 下载/图片代理：用全局 fetch 拉取上游并流式透传，绕过防盗链与跨域
import { guessReferer, MOBILE_UA } from '../../lib/referer.js';

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

export async function proxyDownload(request, { forceInline = false } = {}) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) return jsonError(400, '缺少 url 参数');

  const params = new URLSearchParams(url.search);
  const inline = forceInline || params.get('inline') === '1';

  const headers = {
    'User-Agent': MOBILE_UA,
    Referer: guessReferer(target),
    Accept: '*/*',
  };
  const range = request.headers.get('range');
  if (range) headers.Range = range;

  let upstream;
  try {
    upstream = await fetch(target, { headers, redirect: 'follow' });
  } catch (e) {
    return jsonError(502, '下载失败: ' + e.message);
  }

  const out = new Headers();
  out.set('Access-Control-Allow-Origin', '*');
  out.set('Access-Control-Expose-Headers', '*');
  out.set('Cache-Control', 'no-store');
  const ct = upstream.headers.get('content-type');
  if (ct) out.set('content-type', ct);
  const cl = upstream.headers.get('content-length');
  if (cl) out.set('content-length', cl);
  const cr = upstream.headers.get('content-range');
  if (cr) out.set('content-range', cr);
  const ar = upstream.headers.get('accept-ranges');
  if (ar) out.set('accept-ranges', ar);

  const name = params.get('name') || 'download';
  out.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"`);

  // upstream.body 已是 Web ReadableStream，直接透传，支持 Range / 大文件
  return new Response(upstream.body, { status: upstream.status || 200, headers: out });
}
