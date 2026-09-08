// SVG → PNG 3x 渲染（2026-09-02 定稿：对话内联标准 = PNG 3 倍分辨率，SVG 留作矢量原稿）
// 用法: node svg2png.js <in.svg> <out.png>
// 要点: setContent 内嵌 SVG（勿用 file:// 中文路径）；playwright 优先取调用方 NODE_PATH，
//       兜底走项目 node_modules（skill 自身目录上游没有依赖）。
const fs = require('fs');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  ({ chromium } = require('<PROJECT_ROOT>/node_modules/playwright'));
}

(async () => {
  const [,, inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('用法: node svg2png.js <in.svg> <out.png>');
    process.exit(2);
  }
  const svg = fs.readFileSync(inPath, 'utf-8');
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;background:#FBFAF6}</style></head>
<body>${svg}</body></html>`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 800 }, deviceScaleFactor: 3 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.locator('svg').screenshot({ path: outPath });
  await browser.close();
  console.log('PNG 已生成:', outPath);
})();
