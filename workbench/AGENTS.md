# 招聘作战台 · 接手开发须知

一句话定位：本地单人 Web 工具，把每日招聘对账数据渲染成四页指挥台（作战 / 管道 / 候选人 / 保温催收），支持决策与保温触达的写回闭环。

## 跑起来

```bash
node workbench/server.mjs        # 或双击项目根「启动招聘工作台.bat」
# → http://localhost:5173（自动开浏览器）
```

前置：`notes/_daily_review.json` 存在（由 `python notes/_daily_review.py` 生成）。

## 技术栈与架构

- **前端** `index.html` 单文件：vanilla JS + 内联 CSS/SVG sprite；`vendor/` 内是本地化的 Tailwind 浏览器版 + daisyUI5 CSS，离线可用——**禁止引入需联网的 CDN**。v4.3 起组件层实际使用 daisyUI（btn/badge/input/tab/alert/checkbox），主题色经 `:root` 的 `--color-*` 令牌映射到纸墨体系；布局密度与行清单仍以自定义类为主，模板内联样式改用 Tailwind 工具类
- **后端** `server.mjs` 零依赖 Node http：静态托管 + `/api/data|status` 只读 + 写回端点（decide / touch / response / nurture-reset / refresh 异步对账）
- **数据** 只读三个契约文件：`notes/_daily_review.json`、`_signals.json`、`_nurture_state.json`（字段契约见 `../docs/` 与 daily-recruit-report skill 的 review-contract.md）
- **与 skill 相互独立**：server 不调用 `~/.agents/skills/` 下任何脚本；保温升降级与 decisions 合并语义在 **server.mjs、前端 localTouch/localResp、skill 原脚本三处各有一份同语义实现——改语义必须三处同步**

## 硬性约定（违反即回归）

1. **设计纪律**（v4.2 修订，2026-08-26 与用户逐条讨论定稿）：气质句「晨间纸质作战简报——墨迹、批注、印章，冷静果断」不变。OKLCH 暖纸底禁纯白；墨色主色，禁蓝紫渐变；层级靠字号字重间距对齐不靠框卡片；正文行高≥1.75；动效≤200ms；图标可辅助扫读但禁 emoji 装饰。**对比三层**（取代旧「语义三色只做色点」条款）：
   - **①背景分层**：侧栏 `--paper-side` 压深 / 分组头 `--paper-3` / 内容区暖纸——空间先分出块；
   - **②工作室色系**：6 工作室各绑低饱和色相令牌 `--hue-*`（项目A靛蓝/项目B蓝青/项目C青/产品堇紫/运营金褐/社区品红），只用于归堆标记（泳道头色块、矩阵卡片左条、候选人页分组头左条），色相避开语义三色(30/75/155)；
   - **③状态色加重**：管道列头色带加浓、Offer/待入职苔绿、通过/不通过粗色字、风险行 ≤6% 透明度整行轻染、重点场整行赭意底。
   - 语义三色（朱砂/赭石/苔绿）仍是唯三语义载体，纯装饰性用色仍禁。字号阶梯基线：正文 15 / 辅助 13 / 表格 14 / 时间数字 15 / 微标签 12。
2. **核心成败约束（最高优先级）**：「30 秒扫读闭环」——异常必须长得异常（质量/颜色/位置三载体）；行动与信息同位（无死端信息）；状态变化可见（不止 toast）；不让用户脑内拼装（跨页对账=缺陷）；为 2 分钟一瞥设计而非 30 分钟阅读。任何改动先过这条再谈美观。
3. **写回 = 乐观更新**：改 IDX 本地缓存 + `rerenderKeepScroll()` 保滚动局部重绘；禁止全量拉取 + 整页重建 + 回顶（体验税）
4. **改版必跑三脚本且全绿**：`_shots.mjs`（四页断言+截图）、`_probe.mjs`（布局 16 项）、`_audit.mjs`（对比度/键盘/写回路径取证）
5. **拆分触发线**：加第 5 个页面或 index.html 超 2500 行 → 先拆多文件再继续加功能
6. Windows/git-bash 环境：路径一律正斜杠；lark-cli 用全路径 + `MSYS_NO_PATHCONV=1`

## 当前状态（2026-08-26 v4.3）与下一步

v4.2 已落地（议题 1–5 讨论定稿当日全量交付）：字号整体抬一档；作战页今日面试**按时段分栏**（上午/下午/傍晚，1A 规则移植）+ 复试及以上整行强化；管道改**岗位×阶段矩阵**（行=岗位、列=六阶段，**初筛列移除**——通过初筛才进管道；未进面试流程者在泳道下方「另 N 人待排初试」标注，不入列）；配色对比三层（背景分层+工作室色系+状态色加重，见纪律 1）；修复 `$('#main')` 选择器错写、候选人页筛选计数不更新、response 写回缺 name 三 bug。

v4.3 增量（同日）：**组件层接入 daisyUI**（btn/badge/input/tab/alert/checkbox + 主题令牌映射，`--color-success/warning/error` = 苔绿/赭石/朱砂）；模板内联样式换 Tailwind 工具类；抽屉属性行 `.dw-row` 补齐样式（此前裸 div 无样式）；**抽屉焦点陷阱**（开聚焦首元素、Tab 循环、Esc 关闭并还原焦点）；`post()` 网络异常统一 toast 兜底（服务重启不再静默进 errBox）。

v4.3.1 增量（08-27，用户指正）：管道格子定位从 `stage_bucket`（「下一目标轮次」语义，会虚置一格）改为 **`reachedStage()` 从 rounds_display 推实际已到达的最后一轮**（✅已过/⏳已面待结论，HR复试→HR面、欠N天剥除；无记录且 bucket 非面试阶段→待排初试；Offer/待入职按 ATS）——当日 33 在途修正 21 处错位；保温队列表加 colgroup 固定列宽+姓名列 nowrap（三字名不再被压成两行）。

已知缺口：①「盯什么」本场关注点——对账 JSON 无此字段（review-contract 亦未定义），需 daily-recruit-report 侧先定契约并写入，工作台才能渲染；②upcoming_interviews 含非负责岗位兜底，周前瞻数字偏大——属 `_daily_review.py` 数据层问题，非工作台侧可修；③工作室色相待用户看截图确认。

建议下一步：工作室色相微调；候选功能=评估结论索引接入人员抽屉、泳道列宽按内容自适应；「盯什么」需先在 daily-recruit-report 定字段契约。
