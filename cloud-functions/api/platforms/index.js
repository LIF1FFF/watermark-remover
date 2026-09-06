import { listPlatforms } from '../../../lib/parsers/index.js';

export async function onRequest() {
  return Response.json({ ok: true, data: listPlatforms() });
}
