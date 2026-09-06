// 构建脚本：把静态页 + 云函数 + 函数依赖 组装成 EdgeOne 部署目录 dist/
// EdgeOne 要求：静态文件在部署目录根，云函数在 cloud-functions/，函数依赖(lib/)随包携带
import { cpSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const copyDir = (srcRel, destRel) => {
  const src = join(root, srcRel);
  if (!existsSync(src)) {
    console.warn('⚠️  跳过(不存在):', srcRel);
    return;
  }
  cpSync(src, join(dist, destRel), { recursive: true });
  console.log('✅', srcRel, '→', destRel);
};

// 1) 静态文件放到 dist 根（EdgeOne 直接作为站点根目录）
const pub = join(root, 'public');
for (const e of readdirSync(pub, { withFileTypes: true })) {
  cpSync(join(pub, e.name), join(dist, e.name), { recursive: true });
}
console.log('✅ public/* → dist/');

// 2) 云函数（相对路径 ../../lib 解析依赖 dist/lib）
copyDir('cloud-functions', 'cloud-functions');

// 3) 函数依赖 lib/（被 cloud-functions/api/_proxy.js 引用）
copyDir('lib', 'lib');

// 4) package.json（声明 type:module，EdgeOne 据此用 ESM 加载函数）
copyDir('package.json', 'package.json');

console.log('\n🎉 构建完成 ->', dist);
