'use strict';

const { get, parseJSON, extract, MOBILE_UA } = require('../http');

function match(text) {
  return /weibo\.com|weibo\.cn/i.test(text);
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s，,、"']*(?:weibo\.com|weibo\.cn)[^\s，,、"']*/i);
  return m ? m[0].replace(/[\\]$/, '') : null;
}

function extractId(url) {
  const patterns = [/\/status(?:es)?\/(\d+)/, /[?&]id=(\d+)/, /\/(\d{16,20})(?:\/?$|\?)/];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function parse(input, ctx = {}) {
  const url = extractUrl(input) || input.trim();
  let finalUrl = url;
  let id = extractId(url);

  if (!id && /t\.cn|video\.weibo/.test(url)) {
    try {
      const r = await get(url, { ua: MOBILE_UA, timeout: 12000 });
      finalUrl = r.finalUrl || url;
      id = extractId(finalUrl);
    } catch (e) {}
  }
  if (!id) throw new Error('无法解析出微博 ID（请用 m.weibo.cn/status/数字ID 形式的链接）');

  const res = await get(`https://m.weibo.cn/statuses/show?id=${id}`, {
    ua: MOBILE_UA,
    headers: { Referer: 'https://m.weibo.cn/', 'X-Requested-With': 'XMLHttpRequest' },
  });
  const data = parseJSON(res.body);
  if (!data || !data.data) throw new Error('微博内容获取失败（可能已删除或仅粉丝可见）');
  const d = data.data;

  const videos = [];
  const images = [];

  // 视频
  const mi = d.page_info?.media_info;
  if (mi) {
    const cands = [mi.mp4_720p_mp4, mi.mp4_hd_url, mi.mp4_sd_url, mi.stream_url_hd, mi.stream_url];
    cands.forEach((u) => {
      if (u && !videos.includes(u)) videos.push(u);
    });
  }
  // 有些结构里在 url_struct
  if (!videos.length && Array.isArray(d.url_struct)) {
    d.url_struct.forEach((s) => {
      const mi2 = s?.page_info?.media_info;
      if (mi2) {
        [mi2.mp4_720p_mp4, mi2.mp4_hd_url, mi2.stream_url].forEach((u) => {
          if (u && !videos.includes(u)) videos.push(u);
        });
      }
    });
  }

  // 图集
  if (Array.isArray(d.pics)) {
    d.pics.forEach((p) => {
      const u = p?.large?.url || p?.url;
      if (u) images.push(u);
    });
  }

  return {
    id,
    platform: 'weibo',
    type: videos.length ? 'video' : 'images',
    title: stripHtml(d.text || '').slice(0, 100) || '微博内容',
    author: d.user?.screen_name || '',
    authorId: String(d.user?.id || ''),
    cover: images[0] || d.page_info?.page_pic?.url || '',
    duration: 0,
    videos,
    images,
    sourceUrl: finalUrl,
  };
}

function stripHtml(s) {
  return String(s)
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

module.exports = { match, parse, name: '微博', platforms: ['weibo'] };
