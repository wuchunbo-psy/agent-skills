---
name: position-retro
version: 0.1.0
description: 岗位卡点复盘：把「群推送简历→面试→过/挂→拒因」join 成事实层，按五类分诊产出分诊卡（病因+分侧动作+可证伪预测+复验）。用于单岗卡点诊断；不覆盖整体管道进展（pipeline-dashboard）、不重跑对账/signals/保温（daily-recruit-report）。触发词：复盘岗位、岗位复盘、卡点分析、为什么挂、岗位健康度。
metadata:
  requires:
    bins: ["lark-cli"]
  cliHelp: "lark-cli im --help"
---

# position-retro — 岗位卡点复盘

**事实层脚本 + 判断层 LLM 分离**：`scripts/retro_facts.py`（确定性，可测）拉六源产出事实 JSON；本 SKILL.md 指挥 LLM 在事实之上做分诊。事实 JSON 字段/预测台账格式不确定时读数据契约 [`references/retro-contract.md`](references/retro-contract.md)。

## 何时用

- 用户点名某岗复盘（模式A：该岗建岗以来全量）
- 用户要「本周卡点信号」（模式B：卡住预警岗∪点名岗，增量+预测到期复验）

## 模式A 按需全量复盘（流程）

1. 跑事实层：`cd …/position-retro && PYTHONIOENCODING=utf-8 python scripts/retro_facts.py --position {岗位} [--group oc_xxx] [--since YYYY-MM-DD]`
2. Read 产出 `<PROJECT_ROOT>/notes/retro/_facts_{岗位}_{M.D}.json`；**先看 `meta.data_gaps`：非空则分诊卡顶部「数据缺口」节逐条明示，缺源维度的结论标「待验证」**
2.5 **`group_excerpt` 是泛化业务口径语料**（无候选人名的口头 bar 表述，如「主要是做过肉鸽和帧同步」）——证据三角·群原话优先从中引用，不要只在 feedback_texts 里找人级引文
3. **N<5 硬纪律**：`meta.n_rule=false` → 只出调查卡（列证据缺口与数据源建议），禁止分诊结论
4. 按「五类分诊」判据归类（可多选，标主次）
5. 按模板产出分诊卡 → `<PROJECT_ROOT>/notes/retro/{岗位}_全量_{M.D}.md`
6. 每卡必落一条可证伪预测进 `notes/retro/_predictions.json`
7. 发现金句级业务原话（隐性 bar）→ 提示用户走面评反哺流程回灌评估要点（**人工授权，不自动改**）

## 模式B 定期增量信号（流程）

1. 岗位集 = `_daily_review.json` 卡住预警岗 ∪ 用户当次点名岗
2. 先扫 `_predictions.json`：`verify_by ≤ 今天 且 result=null` 的条目置顶（到期未核=最高优先）
3. 逐岗跑事实层 → 与上次分诊卡比对，只报变化点（新推送/新面试/新拒因/异常变化）
4. 产出 `notes/retro/_signal_{M.D}.md`
5. 节奏纪律：**周产信号、双周核预测、月动策略**——周度回顾绝不等于周度改策略

## 五类分诊判据

| 类型 | 判据（多源印证才算实，单源标「待验证」） |
|---|---|
| 画像错 | 面评拒因跨候选人一致指向同一缺口；进面率低；过的人与推的人有系统性差异 |
| 门槛错 | 同岗不同面试官通过率悬殊；挂的全是市场合理画像；口头 bar 与 JD 字面相反 |
| 吸引力错 | 约面成功率低/拒 offer 多/进面全低配（逆向选择） |
| 流程错 | 推送→首面间隔长、面评欠（unreported 但无口头结论）、整批静默拒无逐人反馈 |
| 样本不够 | n_rule=false，只调查不动作 |

**证据等级**：面评总评文字 > 群内业务原话 > 结论枚举（1过/2挂）。三者全缺的挂场标「原因缺失」，不脑补。

## 分诊卡模板（固定结构）

```
# {岗位} 分诊卡 {M.D}
## 漏斗：推 N → 进面 M → 过 P / 挂 F / 未交 U（+同人多岗重推说明）
## 分诊：{五类，标主次}
## 证据三角
- 群原话：{引用+日期+说话人}
- 面评书面：{每人拒因摘录，标注跨人一致性}
- ATS 结构：{轮次分布/通过画像/面试官对比}
## 核对异常：{anomalies 命中项}
## 分侧动作
- 招聘侧（我）：{画像/渠道/卡简历标准，指向评估要点条目}
- 业务侧（二期证据包素材，当前仅记录）：{需对齐的门槛/反馈机制}
## 可证伪预测：{若改X，Y应到Z} 复验日 {date}
## 跨周追踪：{引用预测台账上次结果}
```

## Golden Example（结构基准）

# 战斗客户端程序 分诊卡 9.2
## 漏斗：推 18 → 进面 6 → 过 2 / 挂 3 / 未交 1（杨某 8-3 战斗→9-2 系统转岗重推）
## 分诊：画像错（主）+ 流程错（次）
## 证据三角
- 群原话：8-3 钟某「这几个战斗的都不行……主要是做过肉鸽和帧同步、状态同步之类的战斗经验」
- 面评书面：黄某「同步设计和碰撞说的模糊、底层欠缺」／陈某「战斗基础弱、核心理解不足」／曾某「核心能力偏弱」——跨候选人一致 → bar 真实非口味
- ATS 结构：过的 2 人为 16/12 年资深战斗程序；8-3 说破 bar 后推的画像有校准迹象
## 核对异常：pushed_not_interviewed 12/18（5 人被 8-3 一句话整批静默拒）；eval_business_divergence（谢某🟢未进面）
## 分侧动作
- 招聘侧：评估要点已回灌帧同步简历关硬前置+肉鸽高权重加分（9-2 完成）
- 业务侧（二期素材）：12/18 死在简历关且 5 人无逐人反馈——需对齐「无帧同步不推」前置过滤或逐人反馈
## 可证伪预测：筛简历硬卡「能讲透帧同步/状态同步项目」，下批 5 推应 ≥2 进面 复验日 2026-09-16
## 跨周追踪：首卡（基线）

## 铁律

1. n_rule=false 只出调查卡——小样本分诊=制造置信度
2. 三角印证才算实，单源一律标「待验证」；「原因缺失」不编故事
3. 面评字段路径：`module_assessments[*].dimension_assessments[*].dimension_content`（顶层键不存在）
4. 业务原话回灌评估要点=面评反哺既有流程，人工授权后才改
5. 永不自动向业务侧发送任何内容；二期证据包由用户人工发
6. 只读六源，唯一写权限=notes/retro/*；不重跑对账/不写 signals/nurture/manifest

## 依赖与路径

| 项 | 值 |
|---|---|
| 事实层脚本 | `…/position-retro/scripts/retro_facts.py` |
| 事实 JSON / 分诊卡 / 信号页 / 预测台账 | `<PROJECT_ROOT>/notes/retro/` |
| 数据契约 | `references/retro-contract.md` |
| 复用封装 | `<PROJECT_ROOT>/notes/_lark_shared.py`（hire 域）；lark-cli im 域 |
| 测试 | `PYTHONIOENCODING=utf-8 python -m unittest tests.test_retro_facts -v`（21 例） |
| Spec/Plan | `docs/superpowers/specs/2026-09-02-position-retro-design.md` + `plans/2026-09-02-position-retro.md` |
