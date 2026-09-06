'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parse, listPlatforms } from './lib/parsers/index.js';
import { guessReferer, MOBILE_UA } from './lib/referer.js';

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');

// 运行时配置（第三方解析 API）
const CONFIG_FILE = path.join(import.meta.dirname, 'config.json');
let config = { thirdPartyApi: process.env.THIRD_PARTY_API || '' };
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

/** 第三方解析 API 调用（用户可在设置中配置） */
async function thirdPartyApi(url, api) {
  if (!api) return null;
  const endpoint = api.includes('{{url}}')
    ? api.replace('{{url}}', encodeURIComponent(url))
    : `${api}${api.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`;

  const res = await fetch(endpoint, { headers: { 'User-Agent': MOBILE_UA }, redirect: 'follow' });
  const data = await res.json();

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
      id: '', platform: 'third-party', type: 'images',
      title: data?.data?.title || '解析结果', author: data?.data?.author || '',
      authorId: '', cover: data?.data?.images[0] || '', duration: 0,
      videos, images: data.data.images, raw: 'third-party',
    };
  }
  if (videos.length) {
    return {
      id: '', platform: 'third-party', type: 'video',
      title: data?.data?.title || data?.title || '解析结果', author: data?.data?.author || '',
      authorId: '', cover: data?.data?.cover || data?.cover || '', duration: 0,
      videos, images: [], raw: 'third-party',
    };
  }
  return null;
}

/** 代理下载：用全局 fetch 拉取上游，流式转发，绕过防盗链 */
async function proxyDownload(req, res, targetUrl, filename, inline) {
  const headers = {
    'User-Agent': MOBILE_UA,
    Referer: guessReferer(targetUrl),
    Accept: '*/*',
  };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(targetUrl, { headers, redirect: 'follow' });
  } catch (e) {
    return sendJSON(res, 502, { error: '下载失败: ' + e.message });
  }

  if (process.env.DEBUG) {
    console.error('[dl] upstream', upstream.status, 'type=', upstream.headers.get('content-type'));
  }
  // 如实传递上游状态码（403/404/206 等），便于前端定位盗链/失效问题
  if (upstream.status >= 400) {
    const text = await upstream.text().catch(() => '');
    return sendJSON(res, upstream.status, { error: '源站返回 ' + upstream.status + (text ? ': ' + text.slice(0, 200) : '') });
  }

  const outHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': '*',
    'Cache-Control': 'no-store',
  };
  const ct = upstream.headers.get('content-type');
  if (ct) outHeaders['Content-Type'] = ct;
  const cl = upstream.headers.get('content-length');
  if (cl) outHeaders['Content-Length'] = cl;
  const cr = upstream.headers.get('content-range');
  if (cr) outHeaders['Content-Range'] = cr;
  const ar = upstream.headers.get('accept-ranges');
  if (ar) outHeaders['Accept-Ranges'] = ar;

  const disposition = inline ? 'inline' : 'attachment';
  const safeName = encodeURIComponent(filename || 'download.mp4');
  outHeaders['Content-Disposition'] = `${disposition}; filename*=UTF-8''${safeName}`;

  res.writeHead(upstream.status || 200, outHeaders);

  if (!upstream.body) return res.end();
  // Web ReadableStream -> Node Readable -> http 响应
  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.on('error', () => res.destroy());
  nodeStream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;

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
        const { url, thirdPartyApi } = JSON.parse(body || '{}');
        if (!url) return sendJSON(res, 400, { error: '请输入视频链接' });
        const t0 = Date.now();
        const api = thirdPartyApi || config.thirdPartyApi || process.env.THIRD_PARTY_API || '';
        const result = await parse(url, api ? { thirdPartyApi: api } : {});
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

  if (pathname === '/api/download') {
    const target = reqUrl.searchParams.get('url');
    const name = reqUrl.searchParams.get('name') || 'video.mp4';
    const inline = reqUrl.searchParams.get('inline') === '1';
    if (!target) return sendJSON(res, 400, { error: '缺少 url 参数' });
    if (process.env.DEBUG) console.error('[dl] target', target.slice(0, 60));
    return proxyDownload(req, res, target, name, inline);
  }

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
