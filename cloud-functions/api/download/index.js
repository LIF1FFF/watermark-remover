import { proxyDownload } from '../_proxy.js';

export async function onRequest(ctx) {
  const request = ctx?.request ?? ctx;
  return proxyDownload(request, { forceInline: false });
}
