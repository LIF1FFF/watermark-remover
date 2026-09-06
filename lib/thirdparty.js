'use strict';

import { get, MOBILE_UA } from './http.js';

/**
 * 第三方解析 API 兜底（供所有平台共用）
 *
 * @param {string} input 用户粘贴的链接/口令
 * @param {string} api   API 模板地址：
 *   - 含 {{url}} 占位符：直接替换（ encodeURIComponent 编码）
 *   - 否则自动拼接 ?url=（或 &url=）
 * @returns {Promise<object|null>} 标准化解析结果，失败返回 null
 */
async function callThirdParty(input, api) {
  if (!api || typeof api !== 'string') return null;

  // 从口令中提取第一个 URL；没有则原样传
  const m = String(input).match(/https?:\/\/[^\s，,、"'）)]+/);
  const url = m ? m[0].replace(/[\\]$/, '') : String(input).trim();
  if (!url) return null;

  const endpoint = api.includes('{{url}}')
    ? api.replace('{{url}}', encodeURIComponent(url))
    : `${api}${api.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`;

  let data;
  try {
    const res = await get(endpoint, { ua: MOBILE_UA, timeout: 15000 });
    data = JSON.parse(res.body);
  } catch (e) {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  const payload = pickPayload(data);
  if (!payload) return null;

  return normalize(payload, url);
}

/** 兼容各种 code 约定，取出真正承载数据的部分 */
function pickPayload(data) {
  const code = data.code ?? data.status ?? data.Code ?? data.code_num;
  const okCodes = [0, 1, 200, '0', '1', '200', '0001', 'success', true, undefined, null];
  if (code !== undefined && !okCodes.includes(code)) return null;
  return data.data ?? data.result ?? data.info ?? data;
}

const VIDEO_KEYS = [
  'url', 'play_url', 'playUrl', 'video_url', 'nwm_video_url',
  'wm_video_url', 'videoUrl', 'playAddr', 'play_addr', 'link',
];
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|gif|bmp)(\?|#|$)/i;

/** 递归找第一个疑似视频直链 */
function findVideoUrl(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const k of VIDEO_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && /^https?:\/\//.test(v) && !IMAGE_EXT.test(v)) return v;
  }
  for (const k of Object.keys(obj)) {
    const r = findVideoUrl(obj[k], depth + 1);
    if (r) return r;
  }
  return null;
}

/** 递归找图集数组（pics / images / img_urls / imageList 等） */
function findImages(obj, depth = 0, found = []) {
  if (!obj || typeof obj !== 'object' || depth > 6) return found;
  for (const key of ['pics', 'images', 'img_urls', 'imgUrls', 'imageList']) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      for (const it of arr) {
        const u =
          typeof it === 'string'
            ? it
            : typeof it === 'object' && it !== null
              ? (it.urlDefault || it.url || it.infoList?.[0]?.url || '')
              : '';
        if (typeof u === 'string' && /^https?:\/\//.test(u) && !found.includes(u)) found.push(u);
      }
    }
  }
  for (const k of Object.keys(obj)) findImages(obj[k], depth + 1, found);
  return found;
}

/** 取第一个非空字符串字段（author 可能是 {name} 对象，做一层展开） */
function firstStr(obj, keys) {
  for (const k of keys) {
    let v = obj?.[k];
    if (v && typeof v === 'object') v = v.name || v.nickname || v.title || '';
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 标准化为站点统一的结果结构 */
function normalize(payload, sourceUrl) {
  const video = findVideoUrl(payload);
  const images = findImages(payload);
  if (!video && !images.length) return null;

  return {
    id: '',
    platform: 'third-party',
    type: video ? 'video' : 'images',
    title:
      firstStr(payload, ['title', 'desc', 'caption', 'name']) || '解析结果',
    author: firstStr(payload, ['authorName', 'author', 'nickname', 'userName']),
    authorId: '',
    cover:
      firstStr(payload, ['photo', 'cover', 'coverUrl', 'pic', 'picUrl', 'thumbnail']) ||
      images[0] ||
      '',
    duration: 0,
    videos: video ? [video] : [],
    images,
    sourceUrl,
    raw: 'third-party',
  };
}

export { callThirdParty };
