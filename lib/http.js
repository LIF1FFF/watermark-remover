'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 发起 HTTP(S) 请求
 * 自动跟随重定向、自动解压、支持自定义 header
 */
function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 15000,
    maxRedirects = 5,
    redirectCount = 0,
    ua = MOBILE_UA,
  } = options;

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(new Error('URL 格式无效: ' + url));
    }

    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;

    const finalHeaders = {
      'User-Agent': ua,
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive',
      ...headers,
    };

    if (body && !finalHeaders['Content-Type']) {
      finalHeaders['Content-Type'] = 'application/json';
    }
    if (body) {
      finalHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: finalHeaders,
        timeout,
      },
      (res) => {
        const status = res.statusCode;

        // 处理重定向
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (redirectCount >= maxRedirects) {
            return resolve({ status, headers: res.headers, body: '', finalUrl: url });
          }
          let next = res.headers.location;
          if (next.startsWith('/')) {
            next = parsed.origin + next;
          }
          return request(next, { ...options, redirectCount: redirectCount + 1 })
            .then(resolve)
            .catch(reject);
        }

        // 处理压缩
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          resolve({
            status,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            finalUrl: url,
          });
        });
        stream.on('error', reject);
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

/** GET 请求，返回 body 文本 */
async function get(url, options = {}) {
  const res = await request(url, { ...options, method: 'GET' });
  return res;
}

/** POST JSON */
async function post(url, data, options = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return request(url, { ...options, method: 'POST', body });
}

/** 只获取最终重定向地址（用于短链还原） */
async function resolveRedirect(url, options = {}) {
  const res = await request(url, { ...options, method: 'GET' });
  return res.finalUrl || url;
}

/** 安全解析 JSON */
function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/** 从 HTML 中提取指定 pattern 的第一个捕获组 */
function extract(html, pattern) {
  const m = html.match(pattern);
  return m ? m[1] : null;
}

module.exports = {
  request,
  get,
  post,
  resolveRedirect,
  parseJSON,
  extract,
  MOBILE_UA,
  PC_UA,
};
