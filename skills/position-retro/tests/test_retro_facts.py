# checkpoint: task1 done
# checkpoint: task2 done
# checkpoint: task3 done
# checkpoint: task4 done
# checkpoint: task5 done
# checkpoint: task6 done
# checkpoint: task7 done
# checkpoint: task8 done
import sys, os, json, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from retro_facts import extract_file_name, classify_file, strip_game_prefix, position_matches
from retro_facts import parse_push_file, build_pushes
from retro_facts import build_interview_facts
from retro_facts import extract_feedback_text, collect_group_quotes
from retro_facts import load_eval_verdicts
from retro_facts import detect_anomalies
from retro_facts import build_facts_dict
from retro_facts import person_rollup

FIX_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")

class TestBasics(unittest.TestCase):
    def test_extract_file_name(self):
        c = '<file key="file_v3_0013t_xxx" name="何甲_游戏战斗客户端程序_12年.pdf"/>'
        self.assertEqual(extract_file_name(c), "何甲_游戏战斗客户端程序_12年.pdf")
        self.assertEqual(extract_file_name("<file key=\"k\"/>"), "")
        self.assertEqual(extract_file_name("纯文本消息"), "")

    def test_classify_file(self):
        self.assertEqual(classify_file("何甲_游戏战斗客户端程序_12年.pdf"), "简历")
        self.assertEqual(classify_file("苏乙_UIUE设计师_4年_作品集.pdf"), "作品")
        self.assertEqual(classify_file("韩丙_7年高级游戏UI设计师_作品集 (4).pdf"), "作品")
        self.assertEqual(classify_file("数值策划-杨丁.rar"), "简历")
        self.assertEqual(classify_file("卫二_作品图"), "作品")
        self.assertEqual(classify_file("随手发的.png"), "其他")

    def test_strip_game_prefix(self):
        self.assertEqual(strip_game_prefix("游戏战斗客户端程序"), "战斗客户端程序")
        self.assertEqual(strip_game_prefix("战斗客户端程序"), "战斗客户端程序")
        self.assertEqual(strip_game_prefix("休闲游戏策划"), "休闲游戏策划")

    def test_position_matches(self):
        self.assertTrue(position_matches("游戏战斗客户端程序", "战斗客户端程序"))
        self.assertTrue(position_matches("战斗客户端程序", "战斗客户端程序"))
        self.assertFalse(position_matches("系统客户端程序", "战斗客户端程序"))
        self.assertFalse(position_matches("服务器主程", "战斗客户端程序"))

class TestPushes(unittest.TestCase):
    def setUp(self):
        self.wu = "ou_WU"
        self.msgs = [
            {"sender": {"id": "ou_WU"}, "msg_type": "file",
             "content": '<file key="k1" name="赵大_战斗客户端程序_5年.pdf"/>', "create_time": "2026-08-03 14:59"},
            {"sender": {"id": "ou_WU"}, "msg_type": "file",
             "content": '<file key="k2" name="赵大_战斗客户端程序_5年_作品集.pdf"/>', "create_time": "2026-08-03 15:00"},
            {"sender": {"id": "ou_WU"}, "msg_type": "file",
             "content": '<file key="k3" name="钱二_系统客户端程序_4年.pdf"/>', "create_time": "2026-08-04 19:23"},
            {"sender": {"id": "ou_WU"}, "msg_type": "file",
             "content": '<file key="k4" name="赵大_系统客户端程序_5年.pdf"/>', "create_time": "2026-09-02 11:15"},
            {"sender": {"id": "ou_HAI"}, "msg_type": "file",
             "content": '<file key="k5" name="孙三_战斗客户端程序_6年.pdf"/>', "create_time": "2026-08-05 10:00"},
            {"sender": {"id": "ou_WU"}, "msg_type": "text", "content": "文本不算推送", "create_time": "2026-08-05 11:00"},
        ]

    def test_parse_push_file(self):
        p = parse_push_file("赵大_战斗客户端程序_5年.pdf")
        self.assertEqual((p["name"], p["position_hint"], p["file_type"]), ("赵大", "战斗客户端程序", "简历"))
        p2 = parse_push_file("【UIUE设计师_深圳】李四_11年.pdf")
        self.assertEqual(p2["name"], "李四"); self.assertEqual(p2["position_hint"], "UIUE设计师")
        p3 = parse_push_file("随手文件.pdf")
        self.assertEqual(p3["position_hint"], "")

    def test_build_pushes_filters_and_aggregates(self):
        pushes = build_pushes(self.msgs, self.wu, "战斗客户端程序")
        names = [p["name"] for p in pushes]
        self.assertIn("赵大", names); self.assertIn("钱二", names)
        self.assertNotIn("孙三", names)  # 非吴春波发送
        zhao = next(p for p in pushes if p["name"] == "赵大")
        self.assertEqual(len(zhao["files"]), 3)          # 裁决C：姓名聚合收全部文件（战斗简历+战斗作品+系统端重推）
        self.assertTrue(zhao["multi_position"])           # 8-03战斗 + 9-02系统
        self.assertFalse(next(p for p in pushes if p["name"] == "钱二")["multi_position"])
        self.assertEqual(zhao["pushed_at_first"], "2026-08-03 14:59")

class TestInterviewFacts(unittest.TestCase):
    def setUp(self):
        self.tn = {"7001": "赵大", "7002": "钱二", "7003": "周三"}
        self.jt = {"9001": "战斗客户端程序", "9002": "系统客户端程序"}
        self.ivs = [
            {"id": "i1", "application_id": "a1", "round": 1, "begin_time": 1786086000000,
             "interview_record_list": [{"interviewer": {"id": "ou_Z", "name": "钟某"}, "conclusion": 1}],
             "status": None},
            {"id": "i2", "application_id": "a2", "round": 2, "begin_time": 1786935600000,
             "interview_record_list": [{"interviewer": {"id": "ou_Z", "name": "钟某"}, "conclusion": None}],
             "status": None},
            {"id": "i3", "application_id": "a3", "round": 1, "begin_time": 1786086000000,
             "interview_record_list": [], "status": None},
        ]
        self.app_map = {"a1": ("7001", "9001"), "a2": ("7002", "9001"), "a3": ("7003", "9002")}

    def test_filters_by_position_and_maps_fields(self):
        facts = build_interview_facts(self.ivs, self.tn, self.jt, "战斗客户端程序", self.app_map)
        names = [f["name"] for f in facts]
        self.assertEqual(names, ["赵大", "钱二"])      # 周三的系统客户端被过滤
        self.assertEqual(facts[0]["conclusion"], 1)
        self.assertIsNone(facts[1]["conclusion"])      # 未交=None 不计挂
        self.assertEqual(facts[0]["interviewer"], "钟某")
        self.assertEqual(facts[0]["job_title"], "战斗客户端程序")
        self.assertEqual(facts[0]["app_id"], "a1")
        self.assertEqual(facts[0]["round"], 1)
        self.assertEqual(facts[0]["begin_time"], 1786086000000)

class TestFeedback(unittest.TestCase):
    def test_extract_feedback_text(self):
        record = {"module_assessments": [
            {"dimension_assessments": [{"dimension_content": "战斗同步设计说的模糊"},
                                      {"dimension_content": "底层欠缺"}]},
            {"dimension_assessments": []}]}
        self.assertEqual(extract_feedback_text(record), "战斗同步设计说的模糊；底层欠缺")
        self.assertEqual(extract_feedback_text({}), "")

    def test_collect_group_quotes(self):
        biz = {"ou_Z": "钟某"}
        msgs = [
            {"sender": {"id": "ou_Z"}, "msg_type": "text", "create_time": "2026-08-03 15:28",
             "content": "经验不足，主要是做过肉鸽和帧同步、状态同步之类的战斗经验"},
            {"sender": {"id": "ou_Z"}, "msg_type": "text", "create_time": "2026-08-03 15:30",
             "content": "与候选人无关的消息"},
            {"sender": {"id": "ou_WU"}, "msg_type": "text", "create_time": "2026-08-03 16:00",
             "content": "赵大怎么看"},
        ]
        quotes = collect_group_quotes(msgs, biz, ["赵大"])
        # 命中规则：业务消息且文本含候选人名——首条无名字不采集（保守：必须含名字）
        self.assertEqual(len(quotes), 0)
        quotes2 = collect_group_quotes(msgs + [
            {"sender": {"id": "ou_Z"}, "msg_type": "text", "create_time": "2026-08-20 10:00",
             "content": "赵大基础偏弱"}], biz, ["赵大"])
        self.assertEqual(quotes2[0], {"name": "赵大", "speaker": "钟某", "text": "赵大基础偏弱", "date": "2026-08-20 10:00"})
        quotes3 = collect_group_quotes(
            [{"sender": {"id": "ou_Z"}, "msg_type": "text", "create_time": "2026-08-21 10:00",
             "content": "王伟杰基础偏弱"}], biz, ["王伟", "王伟杰"])
        self.assertEqual(quotes3[0]["name"], "王伟杰")  # Ruling I: 最长匹配优先

class TestEvalVerdicts(unittest.TestCase):
    def setUp(self):
        os.makedirs("tests/fixtures", exist_ok=True)  # 裁决E

    def test_parses_overview_table(self):
        sample = """# 简历评估 · 9.1 · 整合版

## 总览

| 姓名 | 工作室/团队 | 岗位 | 判定 | 一句话理由 |
|------|------------|------|------|-----------|
| 赵大 | 项目A/技术 | 战斗客户端程序 | 🟢强推 | 理由 |
| 钱二 | 项目A/技术 | 系统客户端程序 | ⚪待定 | 理由 |

**1 🟢 · 1 ⚪**
"""
        with open("tests/fixtures/_eval_sample.md", "w", encoding="utf-8") as f:
            f.write(sample)
        v = load_eval_verdicts(["tests/fixtures/_eval_sample.md"])
        self.assertEqual(v, {"赵大": "🟢强推", "钱二": "⚪待定"})
        os.remove("tests/fixtures/_eval_sample.md")

    def test_latest_report_wins(self):
        for name, verdict in [("a_9.1.md", "| 赵大 | x | x | 🔴不推 | r |\n"), ("a_8.31.md", "| 赵大 | x | x | 🟡可推 | r |\n")]:
            with open(f"tests/fixtures/{name}", "w", encoding="utf-8") as f:
                f.write(f"## 总览\n\n| 姓名 | a | b | 判定 | c |\n|---|---|---|---|---|\n{verdict}")
        v = load_eval_verdicts(["tests/fixtures/a_8.31.md", "tests/fixtures/a_9.1.md"])
        self.assertEqual(v["赵大"], "🔴不推")  # 9.1 覆盖 8.31
        for n in ("a_9.1.md", "a_8.31.md"):
            os.remove(f"tests/fixtures/{n}")

    def test_missing_file_skipped(self):
        v = load_eval_verdicts(["tests/fixtures/_no_such_file.md"])
        self.assertEqual(v, {})

class TestAnomalies(unittest.TestCase):
    def setUp(self):
        self.pushes = [
            {"name": "赵大", "position_matched": True, "multi_position": True, "files": [], "pushed_at_first": "2026-08-03 14:59"},
            {"name": "钱二", "position_matched": False, "multi_position": False, "files": [], "pushed_at_first": "2026-08-04 19:23"},
            {"name": "李四", "position_matched": True, "multi_position": False, "files": [], "pushed_at_first": "2026-08-20 19:00"},
        ]
        self.ivs = [
            {"name": "赵大", "round": 1, "conclusion": 2, "interviewer": "钟某", "job_title": "战斗客户端程序", "begin_time": 1786086000000, "app_id": "a1"},
            {"name": "王五", "round": 1, "conclusion": None, "interviewer": "钟某", "job_title": "战斗客户端程序", "begin_time": 1786935600000, "app_id": "a2"},
        ]
        self.evals = {"李四": "🟢强推", "王五": "🔴不推"}
        self.quotes = [{"name": "王五", "speaker": "钟某", "text": "王五聊过了基础不行", "date": "2026-08-21 10:00"}]

    def test_five_types(self):
        a = detect_anomalies(self.pushes, self.ivs, self.evals, self.quotes, ["战斗客户端程序"], "战斗客户端程序")
        t = {x["type"]: x for x in a}
        self.assertEqual(len(a), 5)
        self.assertEqual(set(t), {"pushed_not_interviewed", "interviewed_not_pushed",
                                  "eval_business_divergence", "unreported_but_verbal", "stuck_cause_split"})
        self.assertEqual(t["pushed_not_interviewed"]["names"], ["李四"])  # 裁决K：position_matched 且未进面——钱二只推了系统客户端不算，赵大进了面
        self.assertEqual(t["interviewed_not_pushed"]["names"], ["王五"])
        self.assertEqual(t["eval_business_divergence"]["names"], ["李四", "王五"])
        self.assertEqual(t["unreported_but_verbal"]["names"], ["王五"])
        self.assertIn("战斗客户端程序", t["stuck_cause_split"]["detail"])
        self.assertTrue(all(set(x) == {"type", "names", "detail"} for x in a))

    def test_not_stuck(self):
        a = detect_anomalies(self.pushes, self.ivs, self.evals, self.quotes, [], "战斗客户端程序")
        t = {x["type"]: x for x in a}
        self.assertEqual(t["stuck_cause_split"]["detail"], "本岗不在卡住清单")

class TestBuildFacts(unittest.TestCase):
    def test_meta_and_n_rule(self):
        d = build_facts_dict("战斗客户端程序",
                             pushes=[{"name": "赵大", "position_matched": True}],
                             ivs=[{"name": f"人{i}", "conclusion": None} for i in range(4)],
                             feedback=[], evals={}, anomalies=[],
                             window=("2026-06-01", "2026-09-02"), gaps=["评估报告缺失"])
        self.assertFalse(d["meta"]["n_rule"])
        self.assertEqual(d["meta"]["data_gaps"], ["评估报告缺失"])
        self.assertEqual(d["meta"]["position"], "战斗客户端程序")
        self.assertEqual(d["meta"]["window"], ("2026-06-01", "2026-09-02"))
        d2 = build_facts_dict("战斗客户端程序", pushes=[], ivs=[{"name": f"人{i}"} for i in range(5)],
                              feedback=[], evals={}, anomalies=[], window=(None, None), gaps=[])
        self.assertTrue(d2["meta"]["n_rule"])

    def test_top_level_keys(self):
        d = build_facts_dict("X", pushes=[], ivs=[], feedback=[], evals={}, anomalies=[], window=(None, None), gaps=[])
        self.assertEqual(set(d), {"pushes", "interviews", "feedback_texts", "eval_conclusions",
                                   "anomalies", "meta"})

class TestPersonRollup(unittest.TestCase):
    def test_multi_round_takes_latest_concluded(self):
        # Ruling T：一人多轮含 null 尾轮 → 取最晚有结论轮定状态，尾轮未交不改变人级状态
        ivs = [
            {"name": "谷某", "round": 1, "begin_time": 100, "conclusion": 1},
            {"name": "谷某", "round": 2, "begin_time": 200, "conclusion": 1},
            {"name": "谷某", "round": 3, "begin_time": 300, "conclusion": 1},
            {"name": "谷某", "round": 4, "begin_time": 400, "conclusion": None},   # 排期中的尾轮
            {"name": "陈某", "round": 1, "begin_time": 500, "conclusion": 2},
            {"name": "陈某", "round": 2, "begin_time": 600, "conclusion": None},
        ]
        ok, bad, unrep = person_rollup(ivs)
        self.assertEqual(ok, ["谷某"])   # 最晚有结论轮 r3=过
        self.assertEqual(bad, ["陈某"])  # 最晚有结论轮 r1=挂
        self.assertEqual(unrep, [])

    def test_all_null_is_unreported(self):
        ivs = [
            {"name": "郭某", "round": 1, "begin_time": 100, "conclusion": None},
            {"name": "郭某", "round": 2, "begin_time": 200, "conclusion": None},
        ]
        ok, bad, unrep = person_rollup(ivs)
        self.assertEqual((ok, bad, unrep), ([], [], ["郭某"]))

    def test_input_order_irrelevant(self):
        # 乱序输入 + begin_time 缺失（None 按 0 排最前）→ 结果只由 begin_time 决定，与输入顺序无关
        base = [
            {"name": "甲", "round": 1, "begin_time": 100, "conclusion": 2},
            {"name": "甲", "round": 2, "begin_time": 300, "conclusion": 1},
            {"name": "乙", "round": 1, "begin_time": 200, "conclusion": 2},
            {"name": "丙", "round": 1, "begin_time": None, "conclusion": None},
        ]
        r1 = person_rollup(base)
        r2 = person_rollup(list(reversed(base)))
        self.assertEqual(r1, r2)
        ok, bad, unrep = r1
        self.assertEqual(ok, ["甲"])      # r1 挂被 r2 过覆盖（最晚有结论轮 300=过）
        self.assertEqual(bad, ["乙"])
        self.assertEqual(unrep, ["丙"])

class TestFixtures(unittest.TestCase):
    def test_group_fixture_loads_and_parses(self):
        with open(os.path.join(FIX_DIR, "group_sample.json"), encoding="utf-8") as f:
            msgs = json.load(f)
        self.assertEqual(len(msgs), 20)
        pushes = build_pushes(msgs, "ou_WU", "战斗客户端程序")
        self.assertEqual(len([p for p in pushes if p["position_matched"]]), 6)
        quotes = collect_group_quotes(msgs, {"ou_Z": "钟某", "ou_H": "金某"}, [p["name"] for p in pushes])
        self.assertGreaterEqual(len(quotes), 2)

    def test_interviews_fixture(self):
        with open(os.path.join(FIX_DIR, "interviews_sample.json"), encoding="utf-8") as f:
            ivs = json.load(f)
        self.assertEqual(len(ivs), 8)
        self.assertTrue(all("interview_record_list" in i and "application_id" in i and "round" in i for i in ivs))

if __name__ == "__main__":
    unittest.main()
