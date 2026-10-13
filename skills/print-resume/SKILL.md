---
name: print-resume
description: 候选人简历打印：从归档库定位 → 自动截取简历背景部分（简历+作品集合订本场景） → SumatraPDF 静默直打 miniwan 打印机。用于「打印简历 / 打一份简历 / 打印XX的简历 / 直接打印」。不覆盖简历收集归档（collect-resumes）、不覆盖评估（analyze-resumes）、只处理 PDF（zip/图片简历不走本 skill）。
---

# print-resume 简历打印

## 默认场景一条命令

```bash
cd "…/print-resume" && PYTHONIOENCODING=utf-8 \
  "python" \
  scripts/print_resume.py --name 候选人姓名
```

agent 收到打印请求后直接跑此命令，脚本自决：定位文件 → 判断页范围 → 截取（如需） → 打印，stdout 每步有报告。**不要手工拼 SumatraPDF 命令**（参数/打印机名/退出码翻译都已固化在脚本里）。

> **解释器**：managed 默认解释器（裸 `python` 解析到的 `versions/3.13.12`）已装 PyMuPDF，可直接跑。若遇 `ModuleNotFoundError: No module named 'fitz'`，换用：`python`（fitz 1.28.0）或 `C:/Python314/python.exe`。
>
> 另：若 bash 报 `dirname/head/tail: command not found`（PATH 缺 coreutils），命令前先 `export PATH="~/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:$PATH"`。

> **⚠️ 只打现场面试（2026-09-08 用户定稿）**：视频面试不用打印简历（面试官在屏幕上看）。打印前先核对面试形式——查 `notes/_daily_review.json` 的 `structured.today_interviews[*].interview_type`：`现场面试`才打，`视频面试`跳过。用户说「打印一下」指的通常只是当天/最近的现场面试候选人，别把视频场一起打了。

**定位兜底链（2026-09-08 新增，起因=李菲只有 zip 包、刘青从未归档，两条当时各绕了十步手工调查）**：归档库 PDF → ① 归档库 zip 作品包（自动解出「简历」成员）→ ② 飞书招聘 ATS（talent_id 取值优先级：`--talent-id` > 今日面试名单 > 人才缓存，缓存同名多条 fail-closed 让人挑；拉名下最新简历附件）。兜底来源不保证脱敏态：脚本统一跑薪酬扫描，命中自动调 collect-resumes 的 redact_salary.py 白覆盖；老版 `.doc` 附件自动走 WPS COM 转 PDF（Word COM 不可用、LibreOffice 未装，WPS 是本机唯一活路；PS1 及其引用路径必须纯 ASCII，PowerShell 5.1 无 BOM 按 ANSI 读）。

## 事实表

| 项 | 值 |
|---|---|
| SumatraPDF 路径 | `%LOCALAPPDATA%/SumatraPDF/SumatraPDF.exe`（**3.7.0.21978 prerelease**，2026-09-04 从 3.6.1 升级：3.6.1 是最新稳定版，任务名修复只在 master，走官方日报构建装的） |
| 默认打印机 | `<PRINTER_UNC>`（共享队列，同事也在用） |
| 打印任务名 | 新版（3.7.0.21978+）任务名只用文件名不带路径；脚本仍打「F:\岗位_姓名.pdf」根目录短名副本，故面板显示「岗位_姓名.pdf」，截取版加 `_简历部分`，发送成功后自动删除 |
| 双面方向 | auto（默认）：首页横向 → 短边翻转；纵向 → 长边翻转 |
| 脱敏 | 归档库里的 PDF 均为薪酬脱敏后版本，直接打，无泄漏风险 |
| 打印副本目录 | `F:/` 盘根（短名副本/截取版，打完即删；放根目录任务名才只剩「F:\名字.pdf」） |

## 参数表

| 参数 | 默认 | 说明 |
|---|---|---|
| `--name` | — | 候选人姓名，归档库递归模糊搜（miss 自动走 zip→ATS 兜底链） |
| `--pdf` | — | 直接给 PDF 路径（优先于 --name） |
| `--talent-id` | — | ATS 兜底直指人才 ID（同名歧义时用，跳过缓存查询） |
| `--pages` | auto | auto / all / N-M |
| `--copies` | 1 | 份数，上限 5 |
| `--duplex` | auto | auto / short / long / off（单面） |
| `--printer` | miniwan | 打印机名 |
| `--dry-run` | 关 | 只出决策和命令，不出纸（验证场景用） |

## auto 页范围规则（脚本内置）

1. 页数 ≤ 8 → 全打（视为纯简历文件）
2. 页数 > 8 → 从第 2 页起扫描文本层，首次命中作品集标记（个人作品/作品集/项目展示/部分展示/作品赏析/PORTFOLIO/WORKS）的前一页 = 简历末页，截取打印
3. 无标记可判 → **fail-closed**：列出各页开头摘要，要求用户给 `--pages N-M`，不猜
4. 多文件命中时：文件名带作品集标记的自动降级（打简历不打作品集）；仍剩多个 → 列候选停下

## 失败处理

脚本已翻译 SumatraPDF 退出码（0 成功 / 1 打印失败查打印机 / 2 文件打不开 / 4 打印机不存在 / 5 驱动失败），按 stdout 的 ❌ 提示走：打印机类错误先查队列（`Win32_PrintJob`）与脱机状态，文件类错误核对路径。

## 已知坑

- **UNC 打印机名必须由脚本 subprocess 调用**：`<PRINTER_UNC>` 走 bash 内联会被 MSYS 层搅动导致假失败（2026-09-03 实测 bash 直调退出码异常，脚本内 list 传参稳定）。
- **打印任务名历史坑（已根治）**：3.6.1 任务名=文件全路径（`Print.cpp` `di.lpszDocName = engine.FilePath()`），面板吐整条归档路径没法认（9-04 用户两次点名）。当天升级到 prerelease 3.7.0.21978（master 的 basename-only 修复 + `docname=` 选项都已包含），面板只剩文件名；脚本保留根目录短名副本机制，面板显示统一的「岗位_姓名.pdf」。**prerel 不再受 winget 管理**，下次更新走 [prerelease 页](https://www.sumatrapdfreader.org/prerelease)（版本清单在 `sumatralatest.js`），静默安装参数 `-s -install -with-preview -d <目录>`。升级后真纸验证：**面板任务名只有文件名无路径（用户目检确认 2026-09-04），此坑关闭**；打印参数与 3.6.1 完全一致，未收到翻面/缩放异常反馈。
- **截页禁用 `doc.select()`**：合订本 PDF 共享资源字典（PPT 导出特征），select 把未引用图片全带上（98页19MB 截5页仍19MB），必须 `show_pdf_page` 重建（脚本已实现）。
- SumatraPDF 的 ParseFlags stderr 调试输出是噪音，不代表失败；以退出码为准。

## 参考

- 设计由来与技术选型（GDI 渲染路线→SumatraPDF 演进、双面翻转方向坑、试打教训）：读 `references/decisions.md`
