'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { parse: parseMedia, listPlatforms } = require('./lib/parsers');
const { request } = require('./lib/http');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// 运行时配置（第三方解析 API）
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = { thirdPartyApi: '', proxyDownload: true };
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  }
} catch (e) {}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {}
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/** 根据域名生成合适的 Referer，绕过部分防盗链 */
function guessReferer(url) {
  if (/douyin|iesdouyin|amemv|douyinvod|snssdk|byteimg|ixigua|zjcdn/i.test(url)) return 'https://www.douyin.com/';
  if (/kuaishou|chenzhongtech|gifshow|ksyun|ks-cdn|yximgs/i.test(url)) return 'https://www.kuaishou.com/';
  if (/bilibili|hdslb|bilivideo|biliapi/i.test(url)) return 'https://www.bilibili.com/';
  if (/weibo|sinaimg|weibocdn|miaopai/i.test(url)) return 'https://weibo.com/';
  if (/xiaohongshu|xhscdn|xhslink/i.test(url)) return 'https://www.xiaohongshu.com/';
  try {
    return new URL(url).origin + '/';
  } catch (e) {
    return '';
  }
}

/** 第三方解析 API 调用（用户可在设置中配置） */
async function thirdPartyApi(url, platform) {
  if (!config.thirdPartyApi) return null;
  const api = config.thirdPartyApi.includes('{{url}}')
    ? config.thirdPartyApi.replace('{{url}}', encodeURIComponent(url))
    : `${config.thirdPartyApi}${config.thirdPartyApi.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`;

  const res = await request(api, { timeout: 20000 });
  const data = JSON.parse(res.body);

  // 兼容常见返回结构
  const findUrl = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const keys = ['url', 'play_url', 'playUrl', 'video_url', 'nwm_video_url', 'wm_video_url', 'videoUrl', 'link'];
    for (const k of keys) {
      if (typeof obj[k] === 'string' && /^https?:\/\//.test(obj[k])) return obj[k];
    }
    for (const k of Object.keys(obj)) {
      const r = findUrl(obj[k]);
      if (r) return r;
    }
    return null;
  };

  const videos = [];
  const direct = findUrl(data);
  if (direct) videos.push(direct);
  if (Array.isArray(data?.data?.images)) {
    return {
      id: '',
      platform,
      type: 'images',
      title: data?.data?.title || '解析结果',
      author: data?.data?.author || '',
      authorId: '',
      cover: data?.data?.images[0] || '',
      duration: 0,
      videos,
      images: data.data.images,
      raw: 'third-party',
    };
  }
  if (videos.length) {
    return {
      id: '',
      platform,
      type: 'video',
      title: data?.data?.title || data?.title || '解析结果',
      author: data?.data?.author || '',
      authorId: '',
      cover: data?.data?.cover || data?.cover || '',
      duration: 0,
      videos,
      images: [],
      raw: 'third-party',
    };
  }
  return null;
}

/** 代理下载：流式转发，绕过防盗链 */
function proxyDownload(req, res, targetUrl, filename, inline, depth = 0) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return sendJSON(res, 400, { error: '下载地址无效' });
  }
  if (depth > 5) return sendJSON(res, 502, { error: '重定向次数过多' });

  const isHttps = parsed.protocol === 'https:';
  const client = isHttps ? https : http;

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    Referer: guessReferer(targetUrl),
    Accept: '*/*',
  };
  // 支持断点续传
  if (req.headers.range) headers.Range = req.headers.range;

  const proxyReq = client.request(
    {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
      timeout: 30000, // 仅限制首字节等待时间，响应开始后会被取消
    },
    (proxyRes) => {
      // 收到响应头后取消超时限制，避免大文件下载被中断
      try { proxyReq.setTimeout(0); } catch (e) {}
      if (process.env.DEBUG) {
        console.error('[dl] upstream', proxyRes.statusCode, 'len=', proxyRes.headers['content-length'], 'type=', proxyRes.headers['content-type']);
      }

      // 跟随重定向（抖音 play 地址会 302 到真实 CDN）
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        proxyRes.resume();
        let next = proxyRes.headers.location;
        if (next.startsWith('/')) next = parsed.origin + next;
        return proxyDownload(req, res, next, filename, inline, depth + 1);
      }

      const outHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
      };
      if (proxyRes.headers['content-type']) outHeaders['Content-Type'] = proxyRes.headers['content-type'];
      if (proxyRes.headers['content-length']) outHeaders['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range']) outHeaders['Content-Range'] = proxyRes.headers['content-range'];

      const disposition = inline ? 'inline' : 'attachment';
      const safeName = encodeURIComponent(filename || 'download.mp4');
      outHeaders['Content-Disposition'] = `${disposition}; filename*=UTF-8''${safeName}`;

      // 如实传递状态码，便于定位盗链/失效等问题
      res.writeHead(proxyRes.statusCode, outHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (e) => {
    if (process.env.DEBUG) console.error('[dl] ERROR', e.message);
    if (!res.headersSent) sendJSON(res, 502, { error: '下载失败: ' + e.message });
    else res.end();
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy(new Error('连接超时（源站无响应）'));
  });
  // 客户端中断时同步销毁上游请求
  res.on('close', () => {
    try { proxyReq.destroy(); } catch (e) {}
  });
  proxyReq.end();
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ---------- API ----------
  if (pathname === '/api/parse' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body || '{}');
        if (!url) return sendJSON(res, 400, { error: '请输入视频链接' });
        const t0 = Date.now();
        const result = await parseMedia(url, { thirdPartyApi });
        result.cost = Date.now() - t0;
        sendJSON(res, 200, { ok: true, data: result });
      } catch (e) {
        sendJSON(res, 200, { ok: false, error: e.message || '解析失败' });
      }
    });
    return;
  }

  if (pathname === '/api/platforms') {
    return sendJSON(res, 200, { ok: true, data: listPlatforms() });
  }

  if (pathname === '/api/config') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const d = JSON.parse(body || '{}');
          if (typeof d.thirdPartyApi === 'string') config.thirdPartyApi = d.thirdPartyApi.trim();
          saveConfig();
          sendJSON(res, 200, { ok: true, config: { thirdPartyApi: config.thirdPartyApi } });
        } catch (e) {
          sendJSON(res, 400, { error: '配置保存失败' });
        }
      });
      return;
    }
    return sendJSON(res, 200, { ok: true, config: { thirdPartyApi: config.thirdPartyApi } });
  }

  // 下载代理 /api/download?url=...&name=...&inline=1
  if (pathname === '/api/download') {
    const target = reqUrl.searchParams.get('url');
    const name = reqUrl.searchParams.get('name') || 'video.mp4';
    const inline = reqUrl.searchParams.get('inline') === '1';
    if (!target) return sendJSON(res, 400, { error: '缺少 url 参数' });
    if (process.env.DEBUG) console.error('[dl] target len', target.length, target.slice(0, 60));
    return proxyDownload(req, res, target, name, inline);
  }

  // 图片/封面代理（避免前端跨域）
  if (pathname === '/api/image') {
    const target = reqUrl.searchParams.get('url');
    if (!target) return sendJSON(res, 400, { error: '缺少 url 参数' });
    return proxyDownload(req, res, target, 'image.jpg', true);
  }

  // ---------- 静态文件 ----------
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404</h1><a href="/">返回首页</a>');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`去水印服务已启动: http://localhost:${PORT}`);
});

module.exports = server;
