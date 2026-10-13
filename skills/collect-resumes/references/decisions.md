# 决策记录（decisions）

> 本文件归档 collect-resumes 脚本的历史变更记录（"旧版怎么错 → 新版怎么改"）。
> 不在执行路径上——Agent 执行任务时无需阅读此文件。

## 2026-09-23 视频打包规则：废除散放豁免，一人一个作品视频包

> 背景：曾扬（长青 3D 动作）8 个动作视频散在批次根目录（此前按「视频豁免散放」处理过，
> 彭芳诗 13 视频散放为先例）。用户拍板：散放每次都要再整理、容易混乱，**视频必须打包与简历放一起**。

**旧版怎么错**：散件检测对 mp4/mov 等视频扩展名直接 `continue`（完全豁免），视频散放是合规终态，
每个批次收尾后都要人工再整理；「一人一包」只覆盖简历+作品文档，视频成了唯一的散件残留源。

**新版怎么改**：a) 规则层 archive-naming.md——每人视频打成一个 `{姓名}_作品视频.zip` 与简历放同档位
子夹；不混进简历加作品.zip（视频压不动，简历保持即取即用）。b) 闸门 verify_archive.py 双改——散视频
收集进 `_art_videos` 计 STOP「视频散件未打包」；「作品视频」包名进合集命名豁免，否则视频包按"作品"类
与简历类并存会被误 STOP。c) 实现教训：新标志的初始绑定必须放在单文件模式早退路径可达处（与
`art_scatter` 函数顶部同级），只放散件检测块内会让跳过该块的路径 UnboundLocalError——测试套件抓出。
测试 +2（散视频 STOP / 视频包+简历放行），27 绿。

## 2026-09-20 判重证据收口三连修：状态机护栏 + 同批注册表 + 图片简历成员识别

> 背景：9-20 当日批处理实测暴露三个工具层缺口（当日 8 人批全绿收官，但过程依赖 Agent 手工兜底）。
> 三案共性：**机制已有、覆盖不全**——9-15 判重机制化与 9-16 无证据排除禁令都已落码，但各有绕过路径。

**修①（谢平鑫案例）批量前置自愈的无证据排除**：`download_attachment` 批量模式的前置自愈
（2026-08-17 积压清理产物）按"同人同岗已有 archived"直接 `transitionToExcluded('DUPLICATE_ALREADY_ARCHIVED')`，
下载前就排除、无 SHA 证据——正是 9-16 用户拍板禁止的行为（"无下载证据的重复类排除一律拒绝"），
且当时 9-16 护栏只加在 resolve 层，这里直接调状态机绕过了它。BOSS 候选人分投简历+作品时
（第二封是不同材料）这就是误杀；谢平鑫案排除了他 8-17 已评"待定·不推"后的第三次投递，
实质是重发（事后 --new-version 拿 SHA 证实），但流程靠运气不靠机制。
**修复两层**：a) 移除前置自愈的去重分支（只留 target 路径修复），判重统一下移到
`downloadByRecord` 的 SHA 事实判定——同 SHA → DUPLICATE_CONTENT（带证据可重开），
不同 SHA → 正常归档；b) **证据护栏收口到状态机单一实现**：`transitionToExcluded` 对
DUPLICATE_* 与 SAMEDAY_* 前缀码强制要求内容证据（记录 sha256 / 调用方 evidence.sha256 /
reaudit 正向 dupe_verified），缺失即抛 EXCLUDE_NO_EVIDENCE——任何调用方（现有或将来的）
都绕不过。--backlog 积压清理会因此多下载真重发件（下载后按 SHA 排除），用带宽换正确性。

**修②（唐诗晨案例）同批并发下载不互查 SHA**：同人同日两封邮件附件字节相同（BOSS 版+
直投版），同批 `--pending` 并发 3 提交时 manifest 快照里彼此还是 verified——
"manifest 孪生 SHA 检查"（9-15 加）只对批前已 archived 记录生效，两份同内容文件以不同
文件名双双入库，resolve 层 exclude 又拒收 archived 终态，只能手删。
**修复**：`downloadByRecord` 增加批内已提交注册表 `batchCommittedIndex`（key=姓名+末级
岗位+SHA）。JS 单线程下 check→commit→set 之间无 await，天然原子，并发 worker 只可能在
await 处交错；跨批/跨运行场景仍由 manifest 孪生检查覆盖（每批重读 manifest）。命中即抛
duplicateOf（附 SHA），收尾循环转 DUPLICATE_CONTENT 排除——证据齐全。

**修③（毛亚雄案例，9-08 高阳盲区的 STOP 面）zip 内仅图片简历批次闸门 STOP**：图片简历叫
`简历.jpg`（无姓名无岗位词）时，`verify_archive._is_resume_file` 不认 → zip 判纯作品包 →
批次无简历成员 → 🔴"没找到简历"STOP；而 skill 文档要求 Agent 手工解出脱敏再放回，
等于把已知坑留给每天手工踩。**修复**：`_is_resume_file` 与 `archive_safety` 的 is_resume
判定对齐——图片扩展名 + 文件名含「简历/resume」即认作简历成员（两处单一语义，不再出现
"纯作品包"与"已提取简历成员"同时打印的矛盾输出）。闸门对图片成员仍只报"提取阻断"warning
（图片不做 OCR 薪酬扫描，人工/视觉复核闭环），但批次不再 STOP、人头计数正确。

**附带发现（同案顺带修）**：分档分发（finalize mv 进档次子夹）不回写 manifest → 孪生检查
的直拼路径 existsSync=false 被静默跳过，判重对已分发记录失明（谢平鑫重开件与 8-17 孪生
同 SHA 却成功 commit，就是因为孪生文件已进"待定·不推/"子夹）。加 `findMovedTwin`：
孪生直拼路径不存在时在批次目录树（限深 3 层）内按文件名兜底定位。

**测试**：`tests/node/download_dedup.test.mjs`（护栏 6 态 + 注册表命中/自身/跨人/跨内容 +
findMovedTwin 挪动/未挪动/缺失）与 `tests/python/test_verify_archive.py::TestImageResumeRecognition`
（关键词图片识别单测 + zip 仅含简历.jpg 的闸门端到端）。node 41、python 46 全绿。

## 2026-09-15 大附件分工反转：Agent 默认直接下载，下不动才升级用户

> 背景：温业正 278.9MB QQ 超大附件，Agent 按 SKILL.md「≥50MB 默认不自动下载」把下载推给用户，
> 用户连续两次反馈："你自己下载一下不就行" "昨天升级过 skill，大文件你也可以顺利下载，自己复盘"。

**复盘（规则已与现实脱节 4 次）**：≳50MB 分工定于 08-19（商连胜/邓世豪双下事故 + 用户一句
"让你下载慢的要死"）。此后实测全部打脸：08-20 96.5MB+189.1MB 一批约 5 分钟一次成功、
186MB（万楚粤）一次成功、09-08 高阳 66.6MB 专项脚本 3m16s、09-15 278.9MB 约 7 分钟一次成功。
08-20 打脸后只在 memory 补了"用户让下就直接下"，SKILL.md 默认分工没改——新会话读 SKILL.md
照样推用户。**单次事故+一句主观感受定下的规则，被 4 次实测证伪后必须回写规则本身**。

**反转后的分工**：
- 默认：大附件 Agent 直接 `batch_download_links --records` 下载（自带限流退避、Downloads
  复用、BROWSER_HEADED 风控重跑）。
- 升级用户的两个硬条件：①LINK_EXPIRED（过期链接只能用户从邮箱客户端重下）②连续失败
  （重跑 + 有头模式都失败）。
- 「用户手动下载归档三步走」从主路径降级为 fallback（Downloads 复用场景仍依赖它）。
- 脚本内 >150MB 的"下次建议人工下载"提醒改为中性耗时描述（batch_download_links 291 行）。

## 2026-09-15 判重机制化：resolve 停止瞎猜，下载层 SHA 事实判定（盛明明事故，第 4 次同类误杀）

> 背景：盛明明（2D角色原画）两封邮件 7 分钟内先后到达（16:36/16:43），附件名按 BOSS 规则完全相同，
> 内容一封是 18 页作品集、一封是 2 页简历。Agent 按"同人同岗重复投递"判 duplicate，用户指出
> "两份是她的简历和作品，你不会认真看下内容吗"。这是同一根因的第 4 次事故（刘小六 08-20
> SAMEDAY 误杀作品集、苏树林 08-20 exclude-mail 误伤、林秋钰 08-25 防重闸门拦同邮件作品包）。

**根因（为什么改记忆改不住）**：resolve 层判重键=candidate_name+岗位末级名，而它在 resolve 时点
**没有任何内容判据**——邮件附件 API 返回的字段只有 id/filename/content_type，无 size 无 SHA。
BOSS 场景下两封邮件附件名必然相同（平台命名规则），"跨邮件同名同岗=真重复"这个假设在
"简历+作品分两封投"（美术岗常态）下必然误杀。每次事故后记 memory/加注释，下一批照样犯——
教训写在记忆里，判重跑在代码里，记忆不看代码照错。

**修复（判重从"猜"改为"事实"，三处）**：
1. `resolve_records.mjs`：删除跨邮件 duplicate 终态判定 → 同人同岗已归档只打 ⚠️ 警告放行。
2. `download_attachment.mjs` downloadByRecord：写 .part 后 commit 前，按同人同岗查 twin 已归档
   文件并比对 SHA——相同=真重发 → 抛 duplicateOf，收尾循环转 `excluded/DUPLICATE_CONTENT`
   （.part 清理）；不同=不同材料 → 正常 commit。twin 文件丢失（FILE_LOST）跳过不拦。
3. `download_attachment.mjs` 收尾循环同名冲突分流：删掉"original_filename 相同→排除"分支
   （盛明明案 original_filename 完全相同也会被它误杀）——到 conflict 的必然 SHA 不同=不同内容
   （真重发已被 twin 判重拦截、同内容走 commit 幂等 idempotent），统一加 `_作品集`/`_2` 后缀改名归档。

**配套**：`DUPLICATE_CONTENT` 加入 DUP_REOPEN_CODES（--new-version 可重开）；resolve 单条模式
"已归档警告"保留（人工 resolve 时的即时提示）。

**代价（接受）**：真重发不再被 resolve 层省下下载——每次重投多一次下载（几秒）换零误杀；
误杀危害（静默丢材料、4 次事故）远大于多余下载。

**验证**：集成测试（notes/_archive/_test_dedup_fix.mjs，本地 https mock）9/9 绿：
resolve 放行/twin SHA 同拦截/SHA 不同归档/DUPLICATE_CONTENT 重开闭环。

## 2026-09-16 同名误杀清零 + 判重旁路封死 + 冲突件内容定名（林彩华/韩文帝/谢廷三起救回，用户拍板"机制必须多检查一遍，不靠记忆"）

> 背景：9-14 当天 4 起「同文件名/同内容」排除，3 起误杀 1 起正确——林彩华 19:01（23 页作品集）、
> 韩文帝 19:40（角色设定长图）、谢廷 19:01（JPG 简历，且判反了：已归档的 15 页 PDF 实为作品集）；
> 周童 19:40（同款 45 页作品集的重导出）排除正确。前三起在 9-15 机制化**之后**仍被发现，说明
> 判重机制存在旁路：**排除发生在下载之前，SHA 层根本没机会说话**。

**根因（三个盲区叠加）**：
1. **人工旁路**：Agent 按"同文件名重发"手工 `--exclude DUPLICATE_ALREADY_ARCHIVED`——BOSS 附件
   元数据文件名按职位模板生成，简历/作品集两封可完全同名，真实文件名只在 BOSS 聊天可见。
   9-15 机制只管住了"自动判重"，没管住"人按名猜"。
2. **存量旁路**：历史上已按名排除的记录从未下载、永无 SHA 证据，机制不会回头看。
3. **链接器旁路**：batch_download_links 的 commitToArchive 遇同名目标**直接删新件不比内容**——
   链接类同名简历+作品第二份无声丢失且 manifest 显示已归档。

**修复（堵旁路 + 清存量 + 每日自愈）**：
1. `resolve_records.mjs`：`--exclude/--exclude-mail` 对无 sha256（从未下载）记录打
   DUPLICATE_*/SAMEDAY_* 排除码一律拒绝（工具层封死按名判重）。
2. 新增 `reaudit_duplicates.mjs`（collect 阶段3.5 每日跑）：无下载证据的重复类排除重新下载，
   SHA 同或 PDF 文本层逐字一致（`lib/pdf_text_fingerprint.py`，同文档重导出判据）→ 维持排除 +
   `dupe_verified` 证据落盘；不可证同 → resolveRecord(newVersion) 自动重开正常归档。
   孪生文件定位唯一稳定锚点 = **姓名前缀**（target_path/target_filename 均为陈旧快照高发区）。
3. `batch_download_links.mjs` commitToArchive：同名目标改 SHA 分流——相同=真重发保留原件，
   不同=改名 `_作品集`/`_2` 共存。对齐 download_attachment 语义，不再删件。

**冲突件内容定名（同日升级，用户："你有视觉直接看图"）**：`_2` 通用后缀不表达内容。reaudit
第二部分：PDF 文本层 **≥10 页或前 200 字含 portfolio/作品集 → 自动改名 `_作品集`**；证据不足
→ 渲染首页（`lib/render_page_png.py`，长图缩放）进 `notes/_label_queue/` 视觉队列，主会话看图后
`--apply-label <record_id> --apply-verdict portfolio|resume` 落名（resume 结论自动改回 `_2`，
label_checked 防重进队列）。collect 阶段5.5 每日跑，当日冲突件当天定名。

**页数规则的边界（卢容辉误判教训）**：首版自动规则"≥5 页=作品集"把 8 年老候选人的 5 页简历
误判（视觉抽验抓回）。收紧为 ≥10 页 + 封面关键词；5-9 页一律进视觉队列。**启发式只做粗筛，
看图才是终审**。

**首跑战果**：存量 17 条重审 → 10 条证同维持排除（含周童 45 页重导出，SHA/文本层证据落盘）、
7 条重开归档（含曹语录等历史 SAMEDAY 存疑件）；链接器修复顺带查明；受影响目录脱敏+闸门全绿。
另修 download_attachment.mjs 既有崩溃 bug（自愈分支 `parent is not defined`，_暂定 被收敛改名后
`--pending` 必崩）。

## 2026-08-14 晚 「何时收到」判定链根治（received_at 单一事实源）

> 背景：7.14 积压 22 人 + 3 条历史漏网被当成"8.14 今日"处理，评估报告 38→20→17 三次返工。
> 根因不是单个 bug，是三个时间戳三种语义、消费点各选各的：

**根因链（每个环节单独看都"合理"，连起来错）：**
1. collect 判"今日"用 `updated_at` —— 增量核查会刷新历史记录的 updated_at → 7.14 的 22 人全部"变今天"。
2. 改用 `created_at` 仍错 —— 历史邮件被后续运行**首次建记录**时 created_at 落在当天（8.8/8.5/8.10 三条漏网）。created_at 语义是"入库时间"不是"邮件时间"。
3. 真正的事实只有一个：**邮件真实收到时间**（快照 `m.date`）。
4. resolve 的目录日期段默认=**归档操作日** → 就算 scope 判对，积压邮件仍会落进操作日的 `_暂定` 目录 → analyze 按目录名出报告 → 报告混人。
5. 报告未核对名单就发飞书（38 人版）——发布前的最后一道人工核对缺位。

**修复（全部回归测试覆盖，node 38 / python 44）：**
- **`lib/dates.mjs` 单一实现**：parseMailDate / parseDateArg / sameLocalDay / mdd / recordDate（fallback 链 received_at→created_at→今天只在这里）。collect scope、resolve 日期段、verify --date 全部从它派生，禁止各自读时间戳。
- **verify_mails 存量回填**：`backfillReceivedAt` 每次运行按快照 message_id 给缺 received_at 的记录补齐（幂等、不调 API）——修复时 manifest 922 条记录 received_at 全空，只改新建逻辑等于没修存量。
- **resolve 目录日期段 per-record**：默认=该记录 `recordDate`（邮件收到日），`--date` 降级为人工显式覆盖。积压邮件从此按真实收到日落档（7.14 邮件进 7.14 目录），结构上消灭"积压混进今日目录"。
- **collect `--date` 语义统一**：从"归档日期段"改为"按收到日过滤 scope"（与 verify --date 同语义），不再传给 resolve 当目录日期。
- **verify_mails `--date` 修复**：旧实现 `m.date.startsWith("8.14")` 对快照格式 `"2026-08-14 18:50"` 永远不命中（文档广告的分步用法静默无效）；改 `filterByDate` 按本地日比较，"8.14"/"2026-08-14" 都接受。
- **salary_pattern 双修**：①裸金额分支在 alternation 首尾复制了两份（尾部是死代码，"单一真相源"文件内部冗余）→ 删；②`(月薪|…|期望).{0,4}\d{4,}` 会误命中"期望到岗时间2026年8月"（期望+到岗时间+2026）→ 加 `(?![年]|[-/]\d)` 日期 guard（连字符区间由区间分支兜住，不漏"月薪30000-35000"）。
- **跨 skill 契约**：analyze-resumes 阶段7 增加发布前核对——报告名单必须与 manifest `received_at` 当日记录比对（人数+姓名），不符先查再发。契约在 archive-contract.md 字段表。

**移入的历史教训（原在执行路径/代码注释上）：**
- "8.8 余世坤 / 8.5 常庆龙 / 8.10 何博被误当 8.14"（created_at 陷阱实证）、"7.14 积压 22 人误当今日"（updated_at 陷阱实证）→ 对应 SKILL.md 反模式"不要用 created_at/updated_at/目录名判定何时收到"。
- resolve_records.mjs 内"2026-07-29 target_dir 改 _暂定""455 条积压促生 --auto"等代码注释考古段已删（本文件 07-29/08-14 上午条目已有记录）。

## 2026-08-14 第一性原理+对抗式审查大修（慢/漏/一条命令/架构）

> 背景：用户反馈下载慢、有时漏。两位并行审查 agent + live 数据实证定位根因，全部修复并补回归测试。

**漏的三个实证根因（全部修复）：**
1. **通知关键词误杀候选人回信**（最严重）：`notifications.mjs` 的 NOTIF_RE 按 subject 匹配 `资料收集` 等词直接丢邮件——候选人回复 HR 的"【资料收集】公司名"主题邮件（带学历/薪酬附件）继承主题 → live 快照实证 ≥5 封真简历被静默丢弃且 manifest 零痕迹。修复：关键词降级为展示标签（🏷️），邮件是否相关由详情事实（附件/链接/正文提示）决定；fail-closed 原则的真正贯彻。
2. **verify_mails 每次全量重拉 853 封详情**（慢+限流雪崩面）：新增 `manifest.processed` 增量标记（message_id → 时间），已核查邮件（含"确认零附件"结论）跳过；详情拉取曾失败的（mail_detail blocked）保留重试且成功后自动自愈为 excluded（DETAIL_FETCH_RECOVERED）。`--force` 可全量重拉。
3. **301 条记录卡 verified 从未下载**（resolved 但没人跑 download+merge 两步）：download_attachment 新增 `--pending`；两个下载器批量尾部**自动合并**推进 archived（单进程串行无并发写风险，merge_results 降级为修复工具）；失效链接自动标 blocked(LINK_EXPIRED) 让闸门能发现缺失而非静默重试。

**一条命令：collect.mjs 编排器**：scan → verify(增量) → resolve --auto → 附件下载（今日 scope，--backlog 全量）→ 链接下载 → 自动合并 → redact --dir → verify_archive，每个受影响目录出闸门结果，汇总人工清单。下载默认只处理**今天** resolve 的记录（尊重"当天收简历别拖历史积压"的用户反馈），历史积压显式 `--backlog`。

**P0 数据丢失修复（_finalize_pending_dirs rmtree 删整批）**：旧版把 final_path 自身留在合并源列表——"已有 8.5_N份 + 同名重投 _暂定"场景下文件全被 skip 后 `rmtree(final_path)` 删光整批档案（8.05 实际丢过 4 个文件）。重写合并逻辑：合并源排除 final_path；同名冲突加 `_重投N` 后缀保留；源目录只在确已清空后删除；目录 rename 加 copytree+rmtree fallback（Windows 句柄锁）。补"同名重投不丢数据"回归测试。

**闸门诚实化与作用域**：`五重阻断` 实际只有三重（name_issues/blocked_files 是死变量，"姓名不符/文件阻断"分支不可达）——docstring 与判定对齐为"数量/薪酬/manifest 阻断 + 姓名/格式 warning"。manifest blocked 检查从全库收敛到**绑定本批次目录**（同父目录+同日期段，_暂定 与 rename 后的 _N份 同键），历史 blocked 不再劫持任意目录的闸门。数量闸门口径与 `_count_heads` 统一（旧版 collect 档位统计只认 os.listdir 全文件 → 备注.txt 虚增人头误 STOP）。单文件模式跳过数量闸门（旧版单文件必落"散落根目录"STOP，功能事实已死）。嵌套归档从静默跳过改为显式警告（防"外层zip里的嵌套zip藏薪酬"三层全放行）。

**重复造轮子清理（I5）**：getArg×5、isDirectRun×5、lark-cli 执行器×3 收敛到 `lib/cli_helpers.mjs`；retry.mjs 死函数 runLarkCliWithRetry 删除；file_identity.detectFileType 从整文件 readFileSync 改为只读 512 字节头（OOM 修复只修了一半）；`typeMatchesExtension` 不可达分支清理；batch_download_links 硬编码 playwright 路径收进 paths.mjs。⚠️ 教训：isDirectRun 收进共享模块时漏传 import.meta.url，首轮实测全脚本静默不执行（exit 0 零输出）——共享化必须当天实测。

**状态机补工具化入口**：`resolve_records --exclude <id> --code <原因码>`（历史 140 条 excluded 和 11 条非法 skipped 全是手改 JSON 的产物）；readManifest 读取时自动把非法状态（skipped）归一化为 excluded（LEGACY_SKIPPED_MIGRATED）。redact_salary --output 自动转绝对路径（相对路径落 CWD 坑）；--dir 模式新增 --report-json、列出批量范围外文件（图片简历提示 enhance_ocr_pdf）、rar→zip 成功后自动删原 rar（归档目录不留未脱敏源）。

**SKILL.md 重写为冷清单**（按 docs/skill-doc-standard.md）：时间戳/人名/教训故事全部移入本文件，执行路径只留 what/how。

**实测期追加修复（首轮 collect 全流程实测暴露）：**
- **collect.mjs python spawn 不能 shell:true**：中文路径含空格/全角括号时 cmd 按空格/括号重新拆参（"交互设计师（AI UGC平台）"被截断成"交互设计师（AI"→误报目录不存在）。改无 shell spawnSync('python')，ENOENT fallback `py -3`。
- **verify_archive 支持 target 是 `_暂定` 目录**：编排器把下载目录（_暂定）直接传给闸门时，旧逻辑只扫 target 内部找 _暂定 子目录、不处理自身 → 永远"未找到 _N份 批次"STOP。现在 target 为 _暂定 时先对父目录收敛（_finalize_pending_dirs），再重定向到收敛后的 _N份 校验。
- **同人同日重复投递 TARGET_CONFLICT 自动排除**：批量下载遇同名目标已存在+内容不同（候选人当天重发同份简历），删 conflict 副本（未脱敏内容不得残留在归档目录）+ 记录结构化排除（SAMEDAY_CONFLICT）。真新版简历可凭 message_id 回溯人工裁决。

### 移入的历史教训（原写在 SKILL.md 执行路径上）

- **8.05 游戏UI设计师误归 UIUE**：Agent 凭"意思接近"猜目录，项目B"游戏ui设计师"归到项目A"UIUE设计师"，两工作室不同岗位评估维度完全不同 → 产生 `--job` 路径前缀匹配（策略0）和 resolve 前归属核对铁律。
- **8.12 候选人N方向打架**：邮件标题"UIUE设计师"但简历通篇网易/米哈游游戏动作经验，机械按标题归档 UIUE 判不推，挪 3D 动作岗重评变强推 → 产生"投递标题 vs 简历实际方向"核对铁律。
- **8.04 全量扫 27 条历史积压**：当天收 2 人排 28/29（含 1.8GB 文件），白等几小时 → 产生"当天用 --records 精准下"和编排器默认今日 scope。
- **7-14 积压 455 条漏一个月**：简历文件名本身是结构化信息（【岗位_城市_薪资】姓名_年限.ext），却要 AI 逐条人工转录 → 产生 resolve --auto（0→33 条自动解析）。

## 2026-07-29 工具链缺陷修复 + 对抗式审查加固

> 背景：用户报告 5 个缺陷（29 封邮件实战后），经第一性原理 + 对抗式 code review 确认根因，
> **纠正了 2 个误诊**，并发现 3 个未报告的关键缺陷。全部修复，测试覆盖。

**两个误诊纠正（用户报告 vs 代码实查）：**
1. "download 落根目录导致 merge_results 路径校验失败" → **错误**：merge 两侧都派生自同一 `rec.target_dir`，永远自洽。真正破坏的是 `verify_archive` 数量闸门（根目录文件无 `_N份` 标注 → STOP）。
2. "dry-run 扫 zip 报无薪酬但闸门检出" → **不完整**：对文本型 PDF，dry-run 用 `get_text()+SALARY` 与 verify 按构造相同。真正分歧是**真实(非dry-run)脱敏** `_search_page` 当 `page.search_for` 无法定位矩形时**静默丢弃命中**——dry-run 反而误导操作员。

**缺陷①根治（download→日期子目录→闸门路径打通）：**
- `resolve_records.mjs`：target_dir 从"已收集简历"根改为"已收集简历/{M.DD}_暂定/"。新增 `--date` 参数。
  - 旧版：落根目录 → 闸门因无 `_N份` 标注 STOP → 手动归整 37 文件 → merge 路径对不上。
  - 新版：统一落 `_暂定` 中转目录；只创建此目录，不碰岗位目录。
- `verify_archive.py`：新增 `_finalize_pending_dirs`，闸门 collect 前扫所有 `_暂定` 目录，数人头后自动 rename 为 `{M.DD}_{N}份`。N 永远自洽，fail-closed 语义不变（数量不符仍 STOP）。空 `_暂定` 目录删除。
- `resolve_records`：collected_dir/target_dir 统一正斜杠存储（M2：旧版 path.join 产生反斜杠，下游字符串比较出错）。

**缺陷②根治（dry-run 与真实脱敏一致性）：**
- `redact_salary.py:_search_page`：当 `search_for` 找不到矩形时不再静默丢弃——先用 `get_text('dict')` 把匹配区间映射回 span bbox 涂白；仍找不到则标记 `__UNLOCATABLE__` fail-closed（报告命中、退出非0，不假装已脱敏）。
  - 旧版：dry-run 报命中、真实脱敏漏删 → 闸门检出残留 → 返工。
  - 新版：dry-run 与真实脱敏命中集合一致。

**缺陷③⑤根治（.doc 全链路支持）：**
- `file_identity.mjs:detectTypeFromBuffer`：加 OLE2/CFB 头检测（`D0 CF 11 E0 A1 B1 1A E1`）→ 返回 `'doc'`。
  - 旧版：无此分支 → 返回 unknown → `DOWNLOAD_TYPE_UNKNOWN`，只能 `--unsafe-manual`。
- `content_extractors.py`：新增 `extract_doc`（subprocess 调 antiword），dispatch 加 `.doc` 分支。antiword 不可用/失败 → 阻断（fail-closed）。
- `archive_safety.py`：`.doc` 从 `PORTFOLIO_MEDIA_EXTS` 移到 `RESUME_MEMBER_EXTS` + `ALLOWED_MEMBER_EXTS`，zip 内 .doc 参与姓名/薪酬校验。
- `verify_archive.py`：`RESUME_EXTS` 加 `.doc`；walk 用 `_is_resume_file` 统一判断（修 M5：top-level .doc 不再静默消失）。
- `redact_salary.py`：新增 `redact_doc`（antiword 只读不可涂白 → 命中薪酬即阻断提示转 PDF）。
- **决策**：antiword 校验 + 阻断含薪酬的（用户确认）。无需装 LibreOffice。

**缺陷④修复（verify_mails 并行化）：**
- `verify_mails.mjs`：新增 `runVerifyParallel`（mapPool 并发 fetch 限流5 + 串行处理保证 manifest 确定性）。CLI 改用 async runner（`execAsync`）。
  - 旧版：for + execSync 全串行，29 封几分钟。
  - 新版：并发 fetch，结果与串行完全一致（新增一致性测试）。
- `fetchMessageDetail`：兼容同步/异步 runner。

**H3 修复（merge_results downloaded 状态卡死）：**
- `merge_results.mjs`：状态机推进改幂等（`if status==='downloading' → downloaded`，不再从 downloaded→downloaded 抛 INVALID_TRANSITION）；per-record 转换包进 try/catch，单条失败记入 errors 继续不中断整批。
  - 旧版：'downloaded' 状态记录会抛错（在 try/catch 外）→ 整批中止且重跑卡死。

**H2 修复（redact_salary 解压前安全关口前置）：**
- `redact_zip` 开头调 `archive_safety.check_zip`，blocked 则拒绝 extractall。
- `redact_rar` 开头新增 `_check_rar_safety`（7z l 列成员，阻断嵌套归档/绝对路径/超成员数）。
  - 旧版：直接 extractall/7z x，绕过 verify_archive 的单一安全关口。

**H4 修复（salary 正则假阴性）：**
- `salary_pattern.py`：加裸万/W 区间（`25万-30万`、`20W-30W`）；加英文单值（`Salary: 30K`，手写大小写变体）。
  - 旧版：裸万/W 区间无关键词前缀漏匹配；英文单值无区间漏匹配。扫删同漏。

## 2026-07-16 消除代码重复

- SALARY 正则从 verify_archive.py / redact_salary.py 提取到 `salary_pattern.py` 单一源，两个脚本改为 import（此前是手工复制，靠注释"保持一致"维持，迟早漂移）。
- NOTIF_RE 通知关键词从 scan_all.mjs / verify_mails.mjs 提取到 `lib/notifications.mjs` 单一源（此前同样手工复制）。

## 2026-07-15 性能优化

- 美术岗解压脱敏重打包：redact_salary.py 一个命令搞定（此前需手动解压→脱敏→重打包三步）。
- QQ 大附件批量下载：新增 batch_download_links.mjs（Playwright headless，此前需逐个手动浏览器下载）。
- 链接下载快速失败：download 事件等待 15 秒（此前需登录的页面会无限等待）。

## 2026-07-13 运行 bug 修复

- download_attachment.mjs result.json 文件名冒号→下划线（Windows NTFS ADS bug：冒号被当 NTFS 备用数据流分隔符截断文件名）。

## 2026-07-10 安全管线全面重构

**verify_archive.py（归档闸门）：**
1. 旧版图片型 PDF 只告警不阻断 → 新版 fail-closed（OCR 不可用即 STOP）
2. 旧版 DOCX 完全绕过姓名/薪酬 → 新版用 content_extractors 统一提取
3. 旧版 ZIP 解压失败只告警 → 新版 archive_safety 阻断
4. 旧版缓存用 mtime+size → 新版用 SHA-256（mtime/size 只做性能快筛）
5. 旧版无 _N份 标注只告警 → 新版 STOP
6. 旧版档位目录与同级文件并存时漏计 → 新版同时统计
7. 新增 --manifest 闭环对账（来源→归档→哈希→状态）

**scan_all.mjs（扫描）：**
1. 旧版中间页 JSON 解析失败时 break 但未设 truncated，仍覆盖 _scan_all.json 并 exit 0 → 新版：任何异常都不覆盖上一份完整快照，部分结果写诊断文件，非零退出
2. 旧版通知关键词直接从 candidates 里删掉 → 新版：只打 is_notification 标签，不删除
3. 原子发布：先写 .tmp 再 rename，保证读者不会看到半截 JSON

**verify_mails.mjs（核查）：**
1. 旧版 JSON 解析失败时返回 ok:true → "零附件" 被静默记录 → 新版：严格 parseCliJson，失败抛错，邮件进 blocked
2. 旧版链接二次白名单漏了 126.com，普通域名作品集也不提取 → 新版：extractLinks 解析全部 href + 锚文本分类
3. 旧版直接写 _verified.json → 新版：生成 collection_manifest.json records（source_type + status 状态机）

**download_attachment.mjs（下载）：**
1. 旧版接受任意 MID + 任意 OUT，可人为串件 → 新版：常规模式只接受 --record，MID/附件ID/目标路径全部从 manifest 派生
2. 旧版失败时 writeFileSync 仍写到目标，重试会覆盖正确文件 → 新版：下载到 .part，校验通过后原子 rename；目标存在绝不覆盖
3. 旧版下载成功直接改 manifest → 新版：写独立结果 JSON（.result），由 merge_results.mjs 串行合并（避免并发覆盖）

**file_identity.mjs（文件身份）：**
- 同 download_attachment 第2点：校验失败仍 writeFileSync 到目标路径 → 下载到 .part 校验通过后原子提交

**lark_mail.mjs（CLI 解析）：**
- 旧版 verify_mails 在 JSON 解析失败时返回 ok:true → 真实附件被静默漏掉 → 新版 parseCliJson fail-closed

**html_links.mjs（链接提取）：**
- 旧版用简单正则提取 URL 且二次白名单漏了 126.com → 新版解析所有 `<a href>` + 锚文本分类

---

## 2026-08-17 漏件大修（第一性原理 + 对抗式审查）

**事故**：8.14 晚 20:41/23:45 候选人J、候选人C两封 QQ 超大附件简历（链接在正文，无标准附件）漏掉，
用户质疑后全量对账发现 8 月共 7 条真实候选材料卡在管道（另含候选人K/候选人L/候选人E/候选人M/候选人N）。
三个并行审查 agent（扫描链/下载链/文档层）交叉验证，全部漏洞已修。

**根因链（候选人J/候选人C漏件的完整闭环）**：
1. verify 建 link record（QQ 链接提取本身正常）→ needs_resolution
2. resolve --auto 硬编码只处理 mail_attachment，link 类永远跳过（P0）
3. collect 汇总按 JSON 插入序取前 20 条 = 永远显示最老的，候选人J排 114 条中第 113 位，不可见（P0）
4. 114 条存量 needs_resolution 使 collect 永远 exit 2 → 告警疲劳（P2）

**修复清单**（全部已修+测试）：
- `html_links.mjs`：无闭合 `<a>`（QQ 邮件 HTML 常见）、纯文本裸 URL、img src 三种提取盲区补齐；
  白名单加 quark/drive.google/lanhuapp；裸 URL 中文标点作边界防吞句号
- `verify_mails.mjs`：blocked/excluded 终态重复失败幂等（原会抛 INVALID_TRANSITION 炸整批
  → collect 静默继续 → 整批邮件零 record）；单封处理异常隔离；attachments 字段缺失时不写
  processed（原 fail-open 会永久锁死）；body_hint blocked 纳入重核查（修复后的提取器自愈
  历史误判）；关键词兜底扩到网盘/下载/链接/主页；record 落盘 subject；存量 subject 回填
- `collect.mjs`：汇总分「新到（近7天，完整列出+主题+时间）」vs「历史积压（仅报数）」，
  exit 2 只由新到触发；下载 scope = 指定日 ∪ 近7天 verified（治"处理日滞后滑进积压"）；
  resolve 退出码不再被忽略；scope 外近7天 verified 显式提示
- `resolve_records.mjs`：autoResolve 支持 link 类（邮件主题「姓名-岗位」提取，唯一匹配才
  落盘）；`--new-version` 重开 duplicate 终态（更新版简历正规入口，替代 unsafe-manual 旁路）；
  duplicate 转换不再丢 candidate_name；`--exclude-mail` 按邮件批量排除（背调材料一封
  13-25 附件逐条排没人做）
- `manifest.mjs`：duplicate 出边 needs_resolution（--new-version 唯一重开路）
- `scan_all.mjs`：增量边界命中后连续 2 页零新邮件才停（防服务端排序扰动把新邮件排进旧区）
- `download_attachment.mjs`：批量下载并发 3（CLI 冷启动 1.5s/份占 50-65%，串行慢 3 倍）；
  SAMEDAY_CONFLICT 批尾串行处理避免并发写 manifest
- `verify_archive.py`：文件名含「简历」的合体文件（XX_简历和作品集.pdf）按简历本体验证
  （原规则见「作品集」就跳过 → 55MB 合体 PDF 逃过姓名/薪酬检查）

**文档层**（单一真相源 + 渐进式披露）：
- CLAUDE.md「简历归档铁律」6 条中 5 条与 skill 重复 → 整节置换为指针；孤本规则
  （美术岗作品 ZIP 验证口径）搬入 archive-contract.md
- job-aliases.md 与磁盘脱节的全量表删除，降级为纯歧义规则（Unity 三岗/iOS SDK/UI特效动作撞名）
- AGENTS.md：脱敏铁律标题去"美术岗"限定（矩形/白色/边界适用于所有岗）；压缩包规则指针化
- link-attachments.md：阈值口径统一 150MB、CDP Proxy 标注仅 Claude Code 环境

**未修（记录在案）**：307 条 verified 历史积压清理需先做 target_dir 迁移（44 条反斜杠无
日期段、262 条指向已不存在的 8.13_暂定）；batch_download_links 下载后未按 magic bytes
校正扩展名（候选人J PDF 被存成 .zip 后人工改名）。

## 2026-08-18 new-version 下载死锁修复（程远娟 bug）

**现象**：`--new-version` resolve 成功转 verified，但 `download_attachment --records` 的
批量前置自愈把同人同岗记录标 `excluded/DUPLICATE_ALREADY_ARCHIVED`（无出边终态），
再跑 `resolve --new-version` 返回 bad_record（excluded 不可重开）——补充版简历永久死锁。

**根因**：两层去重判断不对称——resolveRecord 的去重有 `!opts?.newVersion` 豁免，
download_attachment 的前置自愈没有；且 new-version resolve 成功时不落任何标记，
下载器无从豁免。excluded 终态无出边放大为死锁。

**修复**（三处）：
- `manifest.mjs`：`excluded` 出边 `['needs_resolution']`（受控重开路，与 duplicate 同构）
- `resolve_records.mjs`：--new-version 重开条件扩到"重复类排除码的 excluded"
  （DUPLICATE_ALREADY_ARCHIVED/SAMEDAY_CONFLICT/DUPLICATE_CANDIDATE 白名单，
  NOT_RESUME 等人工排除不放行）；重开时清掉残留 exclude_reason；
  new-version resolve 成功落 `new_version: true` 标记
- `download_attachment.mjs`：前置自愈去重循环 `if (rec.new_version) continue`

## 2026-08-18 对抗式审查 + 积压根治（用户质疑"机制有问题"触发）

**触发**：用户三问——①没几份简历为什么慢 ②08-14 的薪酬材料为什么 08-18 还在被当新到处理 ③历史积压每次都干扰，之前不是处理过吗。派独立审查 agent 对抗式审查 + 主会话数据实证交叉验证。

**被推翻的错误认知（曾写进记忆，已修正）**：
- "93 条待解析多为背调材料"——实为 49 条 6-7 月真简历僵尸（流程未跑起来的遗留）+ 44 条系统/流程邮件；08-17 旧版汇总只显最老 20 条，看到资料收集类就下了错误结论
- "39 条老链接失效"——实为 37 条面试邀约邮件误判（正文"简历/附件"字样撞 body_hint 正则）+ 真失效仅 3 条
- 08-17 大清理实际一条 needs_resolution 都没收敛（--exclude-mail 当天造好但没用过）；decisions.md 的"未修清单"也没记这批——被彻底遗忘

**修复**（6 项代码 + 1 次性数据收敛）：
- verify_mails：isNotification 豁免 body_hint（仅豁免"无附件且无链接"的兜底分支；带附件/链接的回信照常核查，不违反 08-14 静默丢简历教训）
- resolve_records：auto 失败缓存 `auto_failed_at`（失败过不再每日重试，`--force` 强制；成功清除标记）；failures 只列近 7 天；`--exclude-mail` 支持逗号分隔多 id
- scan_all：stdout 不再倾倒全量候选（913 封×每次=噪音），增量只打新增，全量写 `_candidates.txt`
- collect 汇总：新到标注"⏳已挂N天"（挂≥2天催落终态）；历史积压报数附构成分类（系统邮件/老投递/其他），黑盒总数曾掩盖 37/40 blocked 是误判的事实
- SKILL.md：新增"⛔当日收尾核对"铁律（新到清单必须清零落终态，决策停在对话里=明天原样再现）+ 系统/流程邮件当场排除口径
- 数据收敛（用户拍板）：132 条一次性排除（59 封系统邮件 NOT_RESUME + 50 封 6-7 月老投递/失效链接 STALE + 2 封测试稿），候选人K保留 blocked 等重发 → needs_resolution 93→0、blocked 40→1

**评估后未采纳**（对抗审查建议但不照单全收）：
- scan 结果缓存/无新邮件跳过 scan：边界 lookahead 2 页是 08-17 漏件事故后的防漏设计，为省几十秒引入漏件风险不值；resolve 空转已被失败缓存消除，verify 增量本来就快
- blocked 加 snooze/ack 新状态：真失效链接月均 1-2 条，为个位数引入状态机新态是过度设计；数据收敛+豁免已根治
- easyocr 无条件加载的假设被推翻：本就是惰性导入+图片型门槛（今天看到 torch 警告是谢文健加密 PDF 真需要 OCR 的必要成本）

## 2026-08-20 四条执行规则的固化（大文件分工 / merge 串行 / OCR 页数上限 / 手动归档入口）

**1. 大附件（≳50MB）默认用户手动下载，Agent 只归档**
- why：QQ 超大附件受服务器限速，Agent 的 Playwright 下载全程 10-20 分钟；用户浏览器/QQ 客户端有断点续传更快。且用户经常已在手动下载——Downloads 里看不到"正在下载中"的文件，Agent 无从感知，两边同时下载必有一遍白下（08-19 商连胜/邓世豪双下事故）。阈值从旧规则">150MB 建议人工"收紧为"≳50MB 默认不自动下"，因为分工模式变了：不是"谁快谁下"，而是"默认用户下，Agent 并行干别的"。
- 配套：手动归档三步入口（mv→result.json→merge）进 SKILL.md 单文件特殊场景。merge 的前置状态校验只认 verified/downloading/downloaded，blocked 记录要先 resolve --record 重推。

**2. 下载/合并任务不并行收尾**
- why：merge_results 是"读 manifest→改→原子写回"，无并发锁。两个下载任务几乎同时完成时各自 merge，后写的基于旧快照，把先写的状态覆盖回去（08-19 候选人K：sha256/扩展名校正都在但 status 被 covering 回 blocked，result 文件被消费，排查+修复花了 3 轮）。

**3. 图片型 PDF 的 OCR 只查前 3 页（`--ocr-pages` 可调，0=全页）**
- why：作品集式简历动辄几十页（吴雨坤 72 页），薪酬只出现在简历信息页（前几页个人信息行），后续全是作品图无薪酬字段。easyocr CPU 逐页跑 72 页 15 分钟跑不完，前 3 页 1-2 分钟。`redact_image_salary.py` 是同原则的独立快路径（jpg/单文件场景一条命令）。
- 坐标原则不变：只覆盖 OCR 命中块自身 bbox（含防锯齿小 padding），不做几何扩展——相邻字段（期望城市/求职意向）分属不同 OCR 块，天然不误删。

**4. `redact_image_salary.py` 诞生的 why**
- 08-19 邓世豪（7z 包内 jpg 简历）走了 6 步人工链（诊断嵌套阻断→解 jpg→转 PDF 绕路→easyocr 定位→视觉多轮确认→rects 涂白），其中 3 步是首次试错浪费。模式与吴雨坤（图片 PDF）同构 → 固化为脚本：复用 salary_pattern 正则判定命中、easyocr 定位、PIL/fitz 白块、输出验证图。easyocr 读不了中文路径（imageio 限制），脚本内先复制 ASCII 临时路径。fitz 的 apply_redactions 是 Page 级方法。

**5. 半加密 BOSS PDF 不再进 OCR 回退（`_is_image_pdf` 的 CJK≥200 快速否决）**
- why：`_is_image_pdf` 旧逻辑把"可读文本+乱码 token 行混合"的半加密 BOSS PDF 也判成图片型，导致文本层 0 命中的每份 BOSS 简历都白跑一遍"easyocr 模型加载（torch 全量初始化）+渲染 3 页+OCR"——2026-09-02 一批 6 份 BOSS 简历实测每份多耗几十秒、命中全 0。半加密 PDF 的可读文本层已被文本路径全量扫过，OCR 对它没有增量价值（token 化的是姓名/联系方式，不是薪酬）。
- 保留：纯扫描件（文本<50字符）与全加密 PDF（可读中文≈0，薪酬可能只在渲染层）仍走 OCR——2026-09-03 用曾华强扫描简历实测 OCR 路径行为不变。阈值 200 汉字：真简历正文数千字，远高于噪声。

## 2026-09-30 增量扫描主路径切换：锚点翻页 → 服务端 time_range 过滤（吴增俊漏件事故二轮加固）

**事故回顾**：吴增俊等 8 封 BOSS 批量通知邮件被增量扫描静默漏掉 ~20h（同分钟批次被服务器排序扰动夹进旧邮件区，「连续 2 页静默即停」提前停止）。一轮修复（同日上午）加了锚点硬停止（必须见到上次快照最旧一封）+15 页护栏告警+24h 每日全量兜底。当日下午第一性审查发现锚点方案三个结构性问题，遂有本轮二轮加固。

**一轮修复（锚点制）被推翻为主路径的三个理由**：
- **保质期 ~28 天**：锚点=上次快照最旧一封，只能单调加深（新邮件不断堆在锚点之前），增量页数随邮件总量线性增长。实测锚点已在第 8 页=邮箱末页，日增 ~50 封≈4 天 1 页，(15−8)×200÷50≈28 天触顶 15 页护栏，之后增量名存实亡、每次走兜底告警。
- **「数学保证」依赖未验证假设**：见到锚点防住的是「同批次乱序」，防不住「新邮件跨时间戳排到锚点之后」——triage 列表排序键含线程/未读权重（scan_all 注释自证「回复置顶/线程聚合会把新邮件排进旧区」），排序稳定性是未文档化黑盒，把黑盒假设当数学保证是断言过强。
- **兜底检测无响应**：15 页护栏触发后告警写 stderr 就蒸发——不自动全量、不进快照元数据、不进日报，漏的那封邮件在下次全量前对所有下游不存在。

**二轮方案（当前生效）**：增量主路径改 `--filter '{"time_range":{"start_time":…}}'` 服务端过滤（lark-cli mail +triage 原生支持，实测生效：future 窗口返回 0 封）。窗口起点=上次扫描开始时刻（`_scan_all.json.meta.json` 的 `last_scan_at`）−1h 余量。翻完窗口（has_more=false）即完整——**完整性是 API 契约，与列表排序彻底解耦**。增量成本从「翻到锚点（8 页起，无界增长）」变为「翻完时间窗（1-2 页，有界）」。
- 防御纵深四层：①窗口自检——上次快照最新一封若落在窗口时间内必须出现在窗口结果中，不在=服务端过滤静默失效，立即进程内升级全量（不等 24h）②锚点模式保留为 meta 缺失时的回退（首轮/损坏）③锚点兜底触发同样自动升级全量（不再告警完照用）④24h 每日全量兜底不变（`.fullscan`）。
- 升级全量不重置 `.fullscan` 计时：升级是异常触发的补救，例行全量保持每日节奏，两个时钟不互相掩盖。
- search 路径返回 ISO UTC 日期（list 路径是本地格式），`normalizeMailDate` 统一入快照，避免两种格式混存污染下游。
- 顺手修：`--max-age-minutes` 快照复用让位于 24h 全量周期（原实现复用 return 在 fullscan 检查之前，连续复用会把全量无限推迟）；stdout「本次新增」清单过滤 prevIds 命中（重叠区邮件不再误报为新增）。

**暂缓项（留档）**：MAX_PAGES=50（10000 封）上限——time_range 化后全量频率大降（每日 1 次例行），按当前增速 1-2 年才需面对；根治靠「处理完移出收件箱（列表有界化）」，配合 mail rules（服务器端规则自动归档已知通知类发件人）可让收件箱从源头只留候选邮件，届时锚点/静默页/快照膨胀三个问题一起消失，待收件箱接近 15 页前排期。
