// 根据资源 URL 猜测合适的 Referer，绕过抖音/快手/B站等 CDN 的防盗链校验
export function guessReferer(url) {
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

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
