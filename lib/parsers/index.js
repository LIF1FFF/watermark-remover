'use strict';

import * as douyin from './douyin.js';
import * as bilibili from './bilibili.js';
import { callThirdParty } from '../thirdparty.js';

// 仅保留实测可稳定解析的平台（快手/小红书/微博受平台风控拦截，已下线）
const PARSERS = [douyin, bilibili];

/** 通用直链接解析：输入本身就是视频/图片地址 */
function parseDirectUrl(input) {
  const text = input.trim();
  const videoM = text.match(/https?:\/\/[^\s"']+\.(?:mp4|m3u8|webm|mov)(?:\?[^\s"']*)?/i);
  if (videoM) {
    return {
      id: '',
      platform: 'direct',
      type: 'video',
      title: '直链视频',
      author: '',
      authorId: '',
      cover: '',
      duration: 0,
      videos: [videoM[0]],
      images: [],
      sourceUrl: text,
    };
  }
  const imgM = text.match(/https?:\/\/[^\s"']+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^\s"']*)?/i);
  if (imgM) {
    return {
      id: '',
      platform: 'direct',
      type: 'images',
      title: '直链图片',
      author: '',
      authorId: '',
      cover: imgM[0],
      duration: 0,
      videos: [],
      images: [imgM[0]],
      sourceUrl: text,
    };
  }
  return null;
}

/** 识别平台 */
function detectPlatform(text) {
  for (const p of PARSERS) {
    if (p.match(text)) return p;
  }
  return null;
}

/**
 * 解析入口
 * @param {string} input 用户粘贴的链接或口令
 * @param {object} ctx { thirdPartyApi: string } 第三方解析 API 模板（内置解析失败时自动兜底）
 */
async function parse(input, ctx = {}) {
  if (!input || !input.trim()) throw new Error('请输入视频链接');

  // 1. 直链优先
  const direct = parseDirectUrl(input);
  if (direct) return direct;

  // 2. 平台匹配
  const parser = detectPlatform(input);
  if (!parser) {
    throw new Error('暂不支持该平台。目前已支持：抖音、哔哩哔哩');
  }

  try {
    return await parser.parse(input, ctx);
  } catch (e) {
    // 3. 内置解析失败 -> 第三方 API 兜底（对所有平台生效）
    const api =
      typeof ctx.thirdPartyApi === 'string' ? ctx.thirdPartyApi.trim() : '';
    if (api) {
      try {
        const tp = await callThirdParty(input, api);
        if (tp && (tp.videos.length || tp.images.length)) return tp;
      } catch (e2) {}
    }
    throw e;
  }
}

/** 支持的平台列表（给前端展示） */
function listPlatforms() {
  return PARSERS.map((p) => ({ name: p.name, key: p.platforms[0] }));
}

export { parse, listPlatforms, detectPlatform };
