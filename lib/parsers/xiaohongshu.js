'use strict';

import { get, parseJSON, extract, PC_UA } from '../http.js';

function match(text) {
  return /xiaohongshu\.com|xhslink\.com/i.test(text);
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s，,、"']*(?:xiaohongshu\.com|xhslink\.com)[^\s，,、"']*/i);
  return m ? m[0].replace(/[\\]$/, '') : null;
}

function extractId(url) {
  const patterns = [/\/explore\/([a-f0-9]{24})/, /\/discovery\/item\/([a-f0-9]{24})/, /source=([a-f0-9]{24})/];
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

  if (/xhslink\.com/i.test(url)) {
    try {
      const r = await get(url, { ua: PC_UA, timeout: 12000 });
      finalUrl = r.finalUrl || url;
      id = extractId(finalUrl);
    } catch (e) {}
  }
  if (!id) throw new Error('无法解析出小红书笔记 ID');

  const res = await get(`https://www.xiaohongshu.com/explore/${id}`, {
    ua: PC_UA,
    headers: { Accept: 'text/html' },
  });
  const html = res.body || '';

  const videos = [];
  const images = [];

  // 优先解析内嵌状态
  const raw = extract(html, /__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (raw) {
    try {
      const jsonTxt = raw
        .replace(/undefined/g, 'null')
        .replace(/:\s*!0/g, ':true')
        .replace(/:\s*!1/g, ':false');
      const data = JSON.parse(jsonTxt);
      const note = data?.note?.noteDetailMap?.[id]?.note;
      if (note) {
        (note.imageList || []).forEach((img) => {
          const u = img?.urlDefault || img?.url || img?.infoList?.[0]?.url;
          if (u) images.push(u);
        });
        const stream = note.video?.media?.stream;
        if (stream) {
          const h264 = stream.h264 || stream.av1 || [];
          h264.forEach((s) => {
            if (s?.masterUrl) videos.push(s.masterUrl);
          });
        }
        return {
          id,
          platform: 'xiaohongshu',
          type: videos.length ? 'video' : 'images',
          title: note.title || note.desc?.slice(0, 60) || '小红书笔记',
          author: note.user?.nickname || '',
          authorId: note.user?.userId || '',
          cover: images[0] || note.imageList?.[0]?.urlDefault || '',
          duration: 0,
          videos,
          images,
          sourceUrl: finalUrl,
        };
      }
    } catch (e) {}
  }

  // 兜底正则
  const ogVideo = extract(html, /<meta property="og:video" content="([^"]+)"/);
  if (ogVideo) videos.push(ogVideo.replace(/&amp;/g, '&'));
  const ogTitle = extract(html, /<meta property="og:title" content="([^"]+)"/);
  const ogImg = extract(html, /<meta property="og:image" content="([^"]+)"/);

  if (!videos.length && !images.length) {
    throw new Error('小红书解析失败：平台风控较严，建议在设置中填入第三方解析 API');
  }

  return {
    id,
    platform: 'xiaohongshu',
    type: videos.length ? 'video' : 'images',
    title: ogTitle || '小红书笔记',
    author: '',
    authorId: '',
    cover: ogImg || images[0] || '',
    duration: 0,
    videos,
    images,
    sourceUrl: finalUrl,
  };
}

export { match, parse };
export const name = '小红书';
export const platforms = ['xiaohongshu'];
