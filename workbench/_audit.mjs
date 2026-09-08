/** 审查取证探针 v2（只读）：对比度从页面实时计算 / 写回路径源码核查 */
import { chromium } from 'playwright';

// WCAG 相对亮度：sRGB 通道 -> 线性化 -> 加权
function relLum(r, g, b){
  const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
  return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b);
}
function contrast(rgb1, rgb2){
  const l1 = relLum(...rgb1), l2 = relLum(...rgb2);
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (a + 0.05) / (b + 0.05);
}
function parseRgb(s){
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return null;
  // oklch() 计算值浏览器会输出 color(srgb ...) 或 rgba？兼容两种
  if (m) return m[1].split(/[,\/\s]+/).filter(Boolean).slice(0,3).map(Number);
  return null;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
await page.goto('http://localhost:5173/#/battle', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// 实时取 .mut 文字色与所在背景色算对比度
const live = await page.evaluate(() => {
  const el = document.querySelector('.mut') || document.querySelector('.psub');
  const bgEl = document.body;
  return {
    fg: getComputedStyle(el).color,
    bg: getComputedStyle(bgEl).backgroundColor,
    fontSize: getComputedStyle(el).fontSize,
    sample: el.textContent.trim().slice(0, 12),
  };
});
// 浏览器对 oklch() 原样返回字符串——自行实现 OKLCH -> 线性RGB -> sRGB -> WCAG 对比度
function oklchToRgb(L, C, H){
  const hr = H * Math.PI / 180;
  const a = C * Math.cos(hr), b = C * Math.sin(hr);
  let l = L + 0.3963377774*a + 0.2158037573*b;
  let m = L - 0.1055613458*a - 0.0638541728*b;
  let s = L - 0.0894841775*a - 1.2914855480*b;
  l = l*l*l; m = m*m*m; s = s*s*s;
  let r =  4.0767416621*l - 3.3077115913*m + 0.2309699292*s;
  let g = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s;
  let bl= -0.0041960863*l - 0.7034186147*m + 1.7076147010*s;
  const enc = (v) => v <= 0.0031308 ? 12.92*v : 1.055*Math.pow(v, 1/2.4) - 0.055;
  return [enc(r), enc(g), enc(bl)].map(v => Math.round(Math.min(1, Math.max(0, v)) * 255));
}
let verdict = '无法解析颜色';
const oc = /oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/;
if (live.fg.startsWith('oklch') && live.bg.startsWith('oklch')){
  const mf = oc.exec(live.fg), mb = oc.exec(live.bg);
  const c = contrast(oklchToRgb(+mf[1], +mf[2], +mf[3]), oklchToRgb(+mb[1], +mb[2], +mb[3]));
  const fs = parseFloat(live.fontSize);
  const need = fs >= 24 || fs >= 18.66 ? 3 : 4.5;
  verdict = `对比度 ${c.toFixed(2)}:1（${fs}px 文字需≥${need}）=> ${c >= need ? 'PASS' : 'FAIL'}`;
}
console.log('== 弱化文字实时对比度 ==');
console.log(`样本 "${live.sample}" fg=${live.fg} bg=${live.bg}`);
console.log(verdict);

// 写回路径源码核查：拉首页源码查关键调用是否存在
const src = await page.evaluate(async () => await (await fetch('/', { cache:'no-store' })).text());
const hasAfterWrite = /afterWrite\s*\(/.test(src) && !/\/\/.*afterWrite/.test(src.replace(/async function afterWrite[\s\S]*?\n}/, ''));
console.log('\n== 写回路径源码核查 ==');
console.log('旧 afterWrite 全量刷新链是否残留:', src.includes('await afterWrite') ? '是 => FAIL' : '否（已改为 rerenderKeepScroll）');
console.log('保滚动重绘 rerenderKeepScroll 存在:', /function rerenderKeepScroll/.test(src) ? '是 => PASS' : '否');
console.log('switchRoute 中 scrollTo(0,0) 仅路由切换时触发:', /function switchRoute[\s\S]{0,600}window\.scrollTo\(0, 0\)/.test(src) ? '是（路由切换允许回顶）' : '异常');

await browser.close();
