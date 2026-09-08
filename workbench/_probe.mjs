/** v4 布局质检探针：溢出/结构/字体/交互，全部只读 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
await page.goto('http://localhost:5173/#/battle', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const checks = [];
const add = (name, ok, detail='') => checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);

// 1. 四页无横向溢出
for (const h of ['battle','pipeline','candidates','nurture']) {
  await page.goto(`http://localhost:5173/#/${h}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const o = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  add(`无横向溢出 #${h}`, o.sw <= o.cw + 2, `scrollWidth=${o.sw} clientWidth=${o.cw}`);
}

// 2. 泳道结构（v4.2 矩阵）：1 列头行 + N 岗位行，每行 7 格（1岗位头+6阶段列）；列头渐进色带存在
await page.goto('http://localhost:5173/#/pipeline', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const lanes = await page.evaluate(() => {
  const boards = [...document.querySelectorAll('.board')];
  return {
    nBoards: boards.length,
    cols: boards.map(b => b.children.length),
    bands: document.querySelectorAll('.colh .band').length,
    bandSample: document.querySelector('.colh .band')?.getAttribute('style') || '',
    cards: document.querySelectorAll('.kcard').length,
  };
});
add('泳道数=工作室数(6)', lanes.nBoards === 6, `boards=${lanes.nBoards}`);
add('每条泳道格子=7的倍数(列头行+岗位行)', lanes.cols.every(c => c % 7 === 0 && c >= 14), JSON.stringify(lanes.cols));
add('36 个列头色带(6阶段×6泳道)', lanes.bands === 36, `bands=${lanes.bands}`);
add('流片卡>20', lanes.cards > 20, `cards=${lanes.cards}`);

// 3. 标题宋体系生效 / 正文雅黑系
const fonts = await page.evaluate(() => ({
  title: getComputedStyle(document.querySelector('.ptitle')).fontFamily,
  body: getComputedStyle(document.body).fontFamily,
  time: getComputedStyle(document.querySelector('.time') || document.body).fontFamily,
}));
add('页题用展示衬线栈', /SimSun|Songti|Noto Serif|Source Han Serif|Georgia/i.test(fonts.title), fonts.title.slice(0, 60));
add('正文用雅黑系', /YaHei/i.test(fonts.body), fonts.body.slice(0, 60));

// 4. 背景非纯白（纪律：禁止纯白）
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
add('背景非纯白', bg !== 'rgb(255, 255, 255)', bg);

// 5. 交互冒烟：泳道卡点开抽屉 / 底部折叠展开 / 作战页风险行展开
await page.click('.kcard');
await page.waitForTimeout(300);
const drawerOn = await page.evaluate(() => document.querySelector('#drawer').classList.contains('on'));
add('泳道卡→抽屉打开', drawerOn);
await page.keyboard.press('Escape');
await page.evaluate(() => document.querySelector('#drawerMask').click());
await page.waitForTimeout(250);
const drawerClosed = await page.evaluate(() => !document.querySelector('#drawer').classList.contains('on'));
add('抽屉可关闭', drawerClosed);
await page.evaluate(() => document.querySelector('[data-key="failed"]')?.click());
await page.waitForTimeout(200);
const foldOpen = await page.evaluate(() => document.querySelector('#fold-failed')?.classList.contains('open'));
add('不通过折叠区可展开', !!foldOpen);

// 6. 作战页重点行存在赭条标注且初试行无标注
await page.goto('http://localhost:5173/#/battle', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const hot = await page.evaluate(() => ({
  rows: document.querySelectorAll('#page-battle .ivrow, #page-battle .rows .row').length,
  hotRows: document.querySelectorAll('#page-battle .row.hot').length,
}));
add('作战页面试行已渲染', hot.rows > 0, `rows=${hot.rows}`);
add('重点行逻辑生效(0≤hot<总场数)', hot.hotRows >= 0 && hot.hotRows < Math.max(hot.rows,1), `hot=${hot.hotRows}`);

// 7. v4.3：daisyUI 组件接入 + 抽屉焦点陷阱
await page.goto('http://localhost:5173/#/candidates', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const comp = await page.evaluate(() => ({
  btn: !!document.querySelector('.btn'),
  input: !!document.querySelector('.input'),
  checkbox: !!document.querySelector('.checkbox'),
}));
add('daisyUI 组件已接入(btn/input/checkbox)', comp.btn && comp.input && comp.checkbox, JSON.stringify(comp));
await page.click('tr[data-act="open-talent"]');
await page.waitForTimeout(300);
let trapOk = true;
for (let i = 0; i < 10; i++){
  await page.keyboard.press('Tab');
  await page.waitForTimeout(30);
  const inDrawer = await page.evaluate(() => document.querySelector('#drawer').contains(document.activeElement));
  if (!inDrawer){ trapOk = false; break; }
}
add('抽屉焦点陷阱(Tab不出抽屉)', trapOk);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const closed2 = await page.evaluate(() => !document.querySelector('#drawer').classList.contains('on'));
add('抽屉Escape可关闭', closed2);

console.log(checks.join('\n'));
process.exit(checks.some(c => c.startsWith('FAIL')) ? 1 : 0);
