'use strict';

const { get, parseJSON, PC_UA } = require('../http');

function match(text) {
  return /bilibili\.com|b23\.tv/i.test(text);
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s，,、"']*(?:bilibili\.com|b23\.tv)[^\s，,、"']*/i);
  return m ? m[0].replace(/[\\]$/, '') : null;
}

function extractId(url) {
  const bv = url.match(/(BV[0-9A-Za-z]{10})/);
  if (bv) return { type: 'bvid', value: bv[1] };
  const av = url.match(/\bav(\d+)/i);
  if (av) return { type: 'aid', value: av[1] };
  return null;
}

async function parse(input, ctx = {}) {
  const url = extractUrl(input) || input.trim();
  let finalUrl = url;

  // b23.tv 短链还原
  if (/b23\.tv/i.test(url)) {
    try {
      const r = await get(url, { ua: PC_UA, timeout: 10000 });
      finalUrl = r.finalUrl || url;
    } catch (e) {}
  }

  const id = extractId(finalUrl) || extractId(url);
  if (!id) throw new Error('无法解析出 B站视频 ID（需要 BV 号或 av 号）');

  const param = id.type === 'bvid' ? `bvid=${id.value}` : `aid=${id.value}`;

  // 视频信息
  const infoRes = await get(`https://api.bilibili.com/x/web-interface/view?${param}`, {
    ua: PC_UA,
    headers: { Referer: 'https://www.bilibili.com/' },
  });
  const info = parseJSON(infoRes.body);
  if (!info || info.code !== 0 || !info.data) {
    throw new Error('B站视频信息获取失败：' + (info?.message || '接口无响应'));
  }
  const d = info.data;

  // 视频流地址（qn 越高越清晰，未登录通常最高 360P）
  let videos = [];
  const cid = d.cid;
  for (const qn of [80, 64, 32, 16]) {
    try {
      const playRes = await get(
        `https://api.bilibili.com/x/player/playurl?${param}&cid=${cid}&qn=${qn}&fnval=1&fourk=1`,
        { ua: PC_UA, headers: { Referer: 'https://www.bilibili.com/' } }
      );
      const pd = parseJSON(playRes.body);
      if (pd && pd.code === 0 && pd.data?.durl?.length) {
        videos = pd.data.durl.map((x) => x.url).filter(Boolean);
        if (videos.length) break;
      }
    } catch (e) {}
  }

  return {
    id: id.value,
    platform: 'bilibili',
    type: 'video',
    title: d.title || 'B站视频',
    author: d.owner?.name || '',
    authorId: String(d.owner?.mid || ''),
    cover: d.pic || '',
    duration: d.duration || 0,
    videos,
    images: [],
    sourceUrl: finalUrl,
    note: videos.length ? '' : '清晰度受限（未登录状态最高 360P，部分视频需登录）',
  };
}

module.exports = { match, parse, name: '哔哩哔哩', platforms: ['bilibili'] };
