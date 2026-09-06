'use strict';

const { get, post, parseJSON, extract, MOBILE_UA, PC_UA } = require('../http');

const UA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

// ttwid 设备凭证：抖音风控必需，缓存复用避免频繁注册
let ttwidCache = { value: '', ts: 0 };
const TTWID_TTL = 30 * 60 * 1000;

async function getTtwid() {
  if (ttwidCache.value && Date.now() - ttwidCache.ts < TTWID_TTL) return ttwidCache.value;
  try {
    const res = await post(
      'https://ttwid.bytedance.com/ttwid/union/register/',
      {
        region: 'cn',
        aid: 1768,
        needFid: false,
        service: 'www.iesdouyin.com',
        migrate_info: { ticket: '', source: 'node' },
        cbUrlProtocol: 'https',
        union: true,
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 12000 }
    );
    const sc = res.headers && res.headers['set-cookie'];
    const arr = Array.isArray(sc) ? sc : [sc].filter(Boolean);
    for (const c of arr) {
      const m = String(c).match(/ttwid=([^;]+)/);
      if (m) {
        ttwidCache = { value: m[1], ts: Date.now() };
        return m[1];
      }
    }
  } catch (e) {}
  return ttwidCache.value || '';
}

/** 判断是否为抖音链接 */
function match(text) {
  return /douyin\.com|iesdouyin\.com|v\.douyin/i.test(text);
}

/** 从任意文本/口令中提取链接 */
function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s，,、"']*(?:douyin\.com|iesdouyin\.com)[^\s，,、"']*/i);
  return m ? m[0].replace(/[\\]$/, '') : null;
}

/** 从链接中提取 aweme_id */
function extractId(url) {
  const patterns = [
    /\/video\/(\d+)/,
    /\/note\/(\d+)/,
    /\/slide\/(\d+)/,
    /modal_id=(\d+)/,
    /\/share\/video\/(\d+)/,
    /item_ids=(\d+)/,
    /aweme_id=(\d+)/,
    /\/(\d{15,25})(?:\/?$|\?)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

/** 短链还原成长链并取出 ID */
async function resolveShort(url) {
  try {
    const res = await get(url, { ua: UA_IOS, timeout: 12000 });
    // 重定向后的最终 URL 里通常带 ID
    let id = extractId(res.finalUrl || '');
    if (id) return { id, finalUrl: res.finalUrl };
    // 有些情况 ID 藏在页面脚本里
    id = extract(res.body || '', /"aweme_id"\s*:\s*"(\d+)"/);
    if (!id) id = extract(res.body || '', /aweme\/v1\/play\?video_id=(\d+)/);
    if (!id) id = extract(res.body || '', /\/video\/(\d{15,25})/);
    return { id, finalUrl: res.finalUrl };
  } catch (e) {
    return { id: null, finalUrl: url, error: e.message };
  }
}

/** 策略A：iesdouyin 老版 iteminfo 接口 */
async function viaItemInfo(id) {
  try {
    const res = await get(
      `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${id}`,
      { ua: UA_IOS, headers: { Referer: `https://www.iesdouyin.com/share/video/${id}/` } }
    );
    const data = parseJSON(res.body);
    const item = data && data.item_list && data.item_list[0];
    if (!item) return null;
    return normalize(item, id);
  } catch (e) {
    return null;
  }
}

/** 策略B：分享页 HTML 提取内嵌数据（需带 ttwid 绕过风控） */
async function viaSharePage(id) {
  try {
    const ttwid = await getTtwid();
    const headers = { Accept: 'text/html,application/xhtml+xml' };
    if (ttwid) headers.Cookie = `ttwid=${ttwid}`;

    const res = await get(`https://www.iesdouyin.com/share/video/${id}/`, {
      ua: UA_IOS,
      headers,
      timeout: 15000,
    });
    const html = res.body || '';

    // 尝试 _ROUTER_DATA
    let raw = extract(html, /_ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
    if (raw) {
      const data = parseJSON(raw);
      const ld = data?.loaderData || {};
      // 路径可能为 video_(id)/page 或 note_(id)/page，遍历容错
      let item = null;
      for (const key of Object.keys(ld)) {
        const page = ld[key];
        if (!page || typeof page !== 'object') continue;
        for (const k2 of Object.keys(page)) {
          const list = page[k2]?.item_list;
          if (Array.isArray(list) && list.length) {
            item = list[0];
            break;
          }
        }
        if (item) break;
      }
      if (item) return normalize(item, id);
    }

    // 尝试 RENDER_DATA（URL 编码）
    const rd = extract(html, /RENDER_DATA\s*=\s*([^<]+)<\/script>/);
    if (rd) {
      try {
        const data = JSON.parse(decodeURIComponent(rd));
        const item = data?.app?.videoInfoRes?.item_list?.[0];
        if (item) return normalize(item, id);
      } catch (e) {}
    }

    // 兜底：直接从 HTML 里抠视频地址
    const mp4 = html.match(/https?:\\u002F\\u002F[^"\\]+\.mp4[^"\\]*/);
    if (mp4) {
      const url = mp4[0].replace(/\\u002F/g, '/').replace(/&amp;/g, '&');
      return {
        id,
        platform: 'douyin',
        type: 'video',
        title: extract(html, /<title>([^<]+)<\/title>/) || '抖音视频',
        author: '',
        cover: '',
        videos: [url],
        images: [],
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/** 策略C：移动端播放接口直取（拿不到详情时兜底） */
async function viaPlayApi(id) {
  const urls = [
    `https://aweme.snssdk.com/aweme/v1/play/?video_id=${id}&radio=0&line=0`,
    `https://api.douyinvod.com/aweme/v1/play/?video_id=${id}&radio=0&line=0`,
  ];
  for (const u of urls) {
    try {
      const res = await get(u, { ua: UA_IOS, maxRedirects: 0, timeout: 10000 });
      if (res.status === 302 || res.status === 301) {
        const loc = res.headers.location;
        if (loc && /\.mp4|video\/tos|aweme/i.test(loc)) {
          return {
            id,
            platform: 'douyin',
            type: 'video',
            title: '抖音视频',
            author: '',
            cover: '',
            videos: [loc],
            images: [],
            raw: 'play-api',
          };
        }
      }
    } catch (e) {}
  }
  return null;
}

/** 统一数据结构 */
function normalize(item, id) {
  const video = item.video || {};
  const author = item.author || {};

  // 视频地址：playwm -> play 去掉水印
  let videos = [];
  const playAddr = video.play_addr || {};
  if (Array.isArray(playAddr.url_list)) {
    videos = playAddr.url_list
      .map((u) => String(u).replace(/playwm/g, 'play').replace(/&amp;/g, '&'))
      .filter(Boolean);
  }
  if (!videos.length && video.download_addr?.url_list) {
    videos = video.download_addr.url_list.map((u) => String(u).replace(/&amp;/g, '&'));
  }

  // 图集
  let images = [];
  if (Array.isArray(item.images)) {
    images = item.images
      .map((img) => {
        const list = img.url_list || [];
        return list[0] ? String(list[0]).replace(/&amp;/g, '&') : null;
      })
      .filter(Boolean);
  }

  const cover = (video.origin_cover || video.cover || {}).url_list?.[0] || '';

  return {
    id,
    platform: 'douyin',
    type: images.length ? 'images' : 'video',
    title: (item.desc || '').trim() || '抖音作品',
    author: author.nickname || '',
    authorId: author.uid || '',
    cover: String(cover).replace(/&amp;/g, '&'),
    duration: video.duration ? Math.round(video.duration / 1000) : 0,
    videos,
    images,
  };
}

/** 主入口 */
async function parse(input, ctx = {}) {
  const url = extractUrl(input) || input.trim();
  if (!url) throw new Error('未找到抖音链接');

  let id = extractId(url);
  let finalUrl = url;

  // 短链需要还原
  if (!id || /v\.douyin\.com/i.test(url)) {
    const r = await resolveShort(url);
    if (r.id) id = r.id;
    if (r.finalUrl) finalUrl = r.finalUrl;
  }

  if (!id) {
    throw new Error('无法解析出视频 ID（链接可能已失效或格式不受支持）');
  }

  // 依次尝试各策略（ttwid 分享页方案实测有效，优先）
  const strategies = [viaSharePage, viaItemInfo, viaPlayApi];
  for (const fn of strategies) {
    try {
      const result = await fn(id);
      if (result && (result.videos?.length || result.images?.length)) {
        result.sourceUrl = finalUrl;
        return result;
      }
    } catch (e) {}
  }

  // 官方接口全挂 -> 尝试使用用户配置的第三方 API
  if (ctx.thirdPartyApi) {
    try {
      const tp = await ctx.thirdPartyApi(url, 'douyin');
      if (tp) return { ...tp, sourceUrl: finalUrl };
    } catch (e) {}
  }

  throw new Error(
    '抖音解析失败：官方接口需要国内 IP 环境且风控较严。可尝试：① 换用 App 分享的完整链接 ② 在设置中填入第三方解析 API'
  );
}

module.exports = { match, parse, name: '抖音', platforms: ['douyin'] };
