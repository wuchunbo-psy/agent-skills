/**
 * 作战台 v4 截图与自动化验收
 * 用法：node workbench/_shots.mjs   （需本地服务已启动）
 * 产物：notes/_wb_shots/*.png + 控制台验收结果（断言 + JS 错误抓取）
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'notes', '_wb_shots');
fs.mkdirSync(OUT, { recursive: true });

const BASE = 'http://localhost:5173';
const jobs = [
  { hash: '#/battle',     file: '01_作战.png',     expect: ['今日面试', '今日邀约', '本周前瞻', '异常与风险'] },
  { hash: '#/pipeline',   file: '02_管道.png',     expect: ['口径', '不通过待终止', '待排初试', '待入职', 'Offer', '初试'] },
  { hash: '#/candidates', file: '03_候选人.png',   expect: ['只看有风险', '轮次进度', '卡点 / 下一步'] },
  { hash: '#/nurture',    file: '04_保温催收.png', expect: ['面试官欠账', '保温队列', '催办'] },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 2 });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

let allOk = true;
for (const j of jobs) {
  await page.goto(`${BASE}/${j.hash}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sb-nav button', { timeout: 8000 });
  await page.waitForTimeout(700);   // Tailwind 运行时生成 + 字体渲染
  const bodyText = await page.evaluate(() => document.body.innerText);
  const missing = j.expect.filter((s) => !bodyText.includes(s));
  const errBoxVisible = await page.evaluate(() => {
    const b = document.querySelector('#errBox');
    return !!b && b.style.display !== 'none';
  });
  await page.screenshot({ path: path.join(OUT, j.file) });
  const ok = missing.length === 0 && !errBoxVisible;
  if (!ok) allOk = false;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${j.file}${missing.length ? ' | 缺少: ' + missing.join(',') : ''}${errBoxVisible ? ' | 页面脚本报错框可见' : ''}`);
}
await browser.close();
console.log(errors.length ? '\nJS 错误汇总:\n' + errors.join('\n') : '\n无 JS 运行时错误');
process.exit(allOk && errors.length === 0 ? 0 : 1);
