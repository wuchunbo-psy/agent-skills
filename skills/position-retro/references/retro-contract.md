# retro-contract — 事实层 JSON 与预测台账契约

## 事实层 JSON（retro_facts.py 产出，notes/retro/_facts_{岗位}_{M.D}.json）

顶层键（六常驻 + group_excerpt）：
| 键 | 类型 | 说明 |
|---|---|---|
| pushes | list | 操作人（WU_OPEN_ID 常量）群推送按人聚合：{name, files:[{fname,file_type,pushed_at}], pushed_at_first, multi_position, position_matched} |
| interviews | list | 本岗面试事实：{name, round, begin_time, conclusion(1过/2挂/null未交), interviewer, job_title, app_id} |
| feedback_texts | list | 证据文本：{name, source(面评|群原话), text, date, speaker?}；证据等级 面评>群原话>结论枚举 |
| eval_conclusions | dict | 我方评估 {姓名: 🟢强推/🟡可推/⚪待定/🔴不推}，取最新报告 |
| anomalies | list | 五类核对异常：{type, names, detail}，type∈pushed_not_interviewed/interviewed_not_pushed/eval_business_divergence/unreported_but_verbal/stuck_cause_split |
| meta | dict | {generated_at, window, position, n_rule(进面人数≥5), data_gaps[]}——n_rule=false 时判断层只许出调查卡 |
| group_excerpt | list | 业务发送人 text 消息摘录（泛化 bar 原话，不要求含候选人名）：{speaker, text, date}，取最近 40 条防爆（Ruling V：复盘更关心近期业务口径）。main() 实跑必含（无业务消息为 []）；build_facts_dict 纯函数缺省调用不落该键（兼容旧断言）。摘要行 过/挂/未交 按人级口径（person_rollup：每人取最晚有结论轮，全 null=未交） |

## 预测台账（notes/retro/_predictions.json）

[{position, prediction, raised_on, verify_by, result: null|"命中"|"未命中", action_taken}]

模式B每次运行先扫 verify_by≤今天 且 result=null 的条目置顶信号页。
