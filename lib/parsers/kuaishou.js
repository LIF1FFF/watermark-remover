'use strict';

import { get, post, parseJSON, extract, MOBILE_UA } from '../http.js';

const UA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

function match(text) {
  return /kuaishou\.com|chenzhongtech\.com|gifshow\.com/i.test(text);
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s，,、"']*(?:kuaishou\.com|chenzhongtech\.com|gifshow\.com)[^\s，,、"']*/i);
  return m ? m[0].replace(/[\\]$/, '') : null;
}

/** 提取作品 ID（快手为字符串 ID） */
function extractId(url) {
  const patterns = [
    /\/short-video\/([A-Za-z0-9_-]+)/,
    /\/f\/([A-Za-z0-9_-]+)/,
    /\/profile\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]+)/,
    /photoId=([A-Za-z0-9_-]+)/,
    /\/l\/([A-Za-z0-9_-]+)/,
    /v\.kuaishou\.com\/([A-Za-z0-9_-]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

/** 生成快手需要的 did cookie */
function genDid() {
  const chars = '0123456789abcdef';
  let s = 'web_';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

/** 策略A：分享页 / 作品页 HTML 提取 */
async function viaPage(id, url) {
  const candidates = [
    `https://www.kuaishou.com/short-video/${id}`,
    `https://www.kuaishou.com/f/${id}`,
    url,
  ];
  for (const u of candidates) {
    try {
      const res = await get(u, {
        ua: UA_IOS,
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      const html = res.body || '';
      if (!html || html.length < 500) continue;

      // 快手页面内嵌 window.INITIAL_STATE 或 __APOLLO_STATE__
      let data = null;
      const apollo = extract(html, /__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
      if (apollo) data = parseJSON(apollo);
      if (!data) {
        const init = extract(html, /INITIAL_STATE\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
        if (init) data = parseJSON(init);
      }

      if (data) {
        const photo =
          data?.['defaultClient']?.[`Photo:${id}`] ||
          data?.[`Photo:${id}`] ||
          Object.values(data).find((v) => v && v.__typename === 'Photo' && v.photoUrl);
        if (photo && photo.photoUrl) {
          return normalize(photo, id);
        }
      }

      // 兜底：直接抠 photoUrl
      const pu = html.match(/"photoUrl"\s*:\s*"([^"]+)"/);
      if (pu) {
        const videoUrl = pu[1].replace(/\\u002F/g, '/').replace(/&amp;/g, '&');
        const cap = html.match(/"caption"\s*:\s*"([^"]*)"/);
        const cov = html.match(/"coverUrl"\s*:\s*"([^"]+)"/);
        return {
          id,
          platform: 'kuaishou',
          type: 'video',
          title: cap ? decodeCaption(cap[1]) : '快手作品',
          author: '',
          cover: cov ? cov[1].replace(/\\u002F/g, '/').replace(/&amp;/g, '&') : '',
          videos: [videoUrl],
          images: [],
          raw: 'page-regex',
        };
      }
    } catch (e) {}
  }
  return null;
}

/** 策略B：graphql 接口 */
async function viaGraphql(id) {
  const did = genDid();
  const query = `query visionVideoDetail($photoId: String, $type: String) {
    visionVideoDetail(photoId: $photoId, type: $type) {
      photo {
        id caption realLikeCount viewCount photoUrl coverUrl
        timestamp
        author { id name }
      }
    }
  }`;
  try {
    const res = await post(
      'https://www.kuaishou.com/graphql',
      { operationName: 'visionVideoDetail', variables: { photoId: id, type: 'video' }, query },
      {
        ua: MOBILE_UA,
        headers: {
          'Content-Type': 'application/json',
          Cookie: `did=${did}`,
          Referer: `https://www.kuaishou.com/short-video/${id}`,
          Origin: 'https://www.kuaishou.com',
        },
      }
    );
    const data = parseJSON(res.body);
    const photo = data?.data?.visionVideoDetail?.photo;
    if (photo && photo.photoUrl) return normalize(photo, id);
  } catch (e) {}
  return null;
}

function decodeCaption(s) {
  try {
    return JSON.parse('"' + s.replace(/"/g, '\\"') + '"');
  } catch (e) {
    return s;
  }
}

function normalize(photo, id) {
  const videos = [];
  if (photo.photoUrl) videos.push(String(photo.photoUrl).replace(/&amp;/g, '&'));
  const images = [];
  if (Array.isArray(photo.imgUrls)) {
    photo.imgUrls.forEach((u) => images.push(String(u).replace(/&amp;/g, '&')));
  }
  return {
    id,
    platform: 'kuaishou',
    type: images.length ? 'images' : 'video',
    title: (photo.caption || '').trim() || '快手作品',
    author: photo.author?.name || '',
    authorId: photo.author?.id || '',
    cover: photo.coverUrl ? String(photo.coverUrl).replace(/&amp;/g, '&') : '',
    duration: 0,
    videos,
    images,
  };
}

async function parse(input, ctx = {}) {
  const url = extractUrl(input) || input.trim();
  if (!url) throw new Error('未找到快手链接');

  let id = extractId(url);
  let finalUrl = url;

  if (!id || /v\.kuaishou\.com/i.test(url)) {
    try {
      const res = await get(url, { ua: UA_IOS, timeout: 12000 });
      finalUrl = res.finalUrl || url;
      id = extractId(finalUrl) || extract(res.body || '', /"photoId"\s*:\s*"([^"]+)"/);
      if (!id) id = extract(res.body || '', /\/short-video\/([A-Za-z0-9_-]+)/);
    } catch (e) {}
  }

  if (!id) throw new Error('无法解析出快手作品 ID');

  const strategies = [(i) => viaPage(i, finalUrl), viaGraphql];
  for (const fn of strategies) {
    try {
      const r = await fn(id);
      if (r && (r.videos?.length || r.images?.length)) {
        r.sourceUrl = finalUrl;
        return r;
      }
    } catch (e) {}
  }

  if (ctx.thirdPartyApi) {
    try {
      const tp = await ctx.thirdPartyApi(url, 'kuaishou');
      if (tp) return { ...tp, sourceUrl: finalUrl };
    } catch (e) {}
  }

  throw new Error('快手解析失败：可能需要国内 IP 环境。可尝试在设置中填入第三方解析 API');
}

export { match, parse };
export const name = '快手';
export const platforms = ['kuaishou'];
