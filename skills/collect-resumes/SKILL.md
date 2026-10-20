---
name: collect-resumes
description: >
  从飞书邮箱收集简历并归档到本地：扫描→核查→解析→下载→脱敏→闸门，一条命令（collect.mjs）或分步执行。
  触发词：收简历、整理简历、处理简历、下载简历、分类简历。
  只要用户提到简历、邮箱、候选人、作品集、归档，就使用这个skill。
  覆盖：标准附件下载、链接类附件（QQ超大附件/云盘）、同人简历+作品打包（2026-09-22 起全岗，原美术岗口径）、多附件合并。
  不覆盖：Bitable写入、BOSS直聘打招呼（见boss-recruit skill）、群聊文件简历（走 candidate-entry 的 _hire.py --by-name 级联下载）。
  依赖：lark-cli（mail 域已授权，不查 auth）、node v24+、Python + PyMuPDF + python-docx + easyocr（图片型PDF）、Playwright（链接类附件，装在 <PROJECT_ROOT>/node_modules）。**Python 用项目 venv**（`python`，collect.mjs 自动探测，`PYTHON` 环境变量可覆盖）；`.doc` 转 PDF 需要本机 Word/WPS（Word COM）或 LibreOffice（soffice），无需 antiword。
---

# 简历收集与归档

## 配置

| 项 | 值 |
|---|---|
| 路径常量真相源 | `scripts/lib/paths.mjs`（JS）/ `scripts/paths.py`（Python）——manifest、归档根、Downloads 全部只在这里定义，改路径改这里 |
| 脚本目录 | `…/collect-resumes/scripts/`（下文 `…/` 均指此处） |
| manifest 事实源 | `<PROJECT_ROOT>/notes/collection_manifest.json`（所有命令的默认 --manifest，日常无需显式传） |

---

## 快路径：一条命令（日常推荐）

```
node "…/scripts/collect.mjs"                # 今天收到的邮件全流程：扫描→核查→自动解析→重复排除重审→下载→合并→脱敏→闸门→冲突件定名
node "…/scripts/collect.mjs" --backlog      # 清历史积压（下载所有 verified 记录，不限收到日）
node "…/scripts/collect.mjs" --no-finish    # 只到下载+合并，人工接管脱敏/闸门
node "…/scripts/collect.mjs" --date 7.29    # 只处理收到日=7.29 的记录（默认今天收到的）
node "…/scripts/collect.mjs" --max-age-minutes 30   # 同一时间段重复整理时跳过邮件重扫（快照30分钟内直接复用）；⚠️ 用户明确说"刚收到邮件"时不带本参数
```

- 退出码：`0`=全绿；`2`=有**新到**人工事项（看汇总）；`1`=流程错误（中止在某阶段）
- 汇总分两层：**新到（近 7 天收到）完整列出置顶**（含邮件主题+收到时间+已挂天数；挂≥2天会标注催落终态）/ 历史积压报数**附构成分类**（系统邮件/老投递/其他）——exit 2 只由新到事项触发
- 增量语义：已核查过的邮件自动跳过详情拉取；**首轮运行会对历史邮件做一次性全量核查（约几分钟），属正常**
- 下载 scope = 指定日（默认今天）∪ 近 7 天 verified 未下载（防深夜邮件/处理滞后滑进积压）；历史全量积压用 `--backlog`
- 归档目录日期段 = **归档日规则推算**（2026-08-21 用户定稿：①19 点后收到算次日 ②周六/周日收到算下一个周一；`dates.mjs archiveDate()` 单一实现）。`received_at` 事实字段不变，collect 下载 scope 用原始日期宽口径防漏件
- auto 解析有**失败缓存**：解析失败过的记录（`auto_failed_at`）不再每日重试（重试必然再失败）；汇总也不每日重刷。看全量失败用 `--auto --force`
- **长 IO 后台化 + 与评估重叠（2026-10-16 用户定稿）**：大附件下载/rar 转包期间，collect 整体转后台执行，已归档的个人立即交 `analyze-resumes` 滚动评估（不等批次收齐）。⚠️ 后台仅限**单个** collect 实例——不得与第二个下载/合并任务并行（manifest 读改写互斥，见反模式）

## Agent 必做的人工环节（collect 汇总之后）

collect 只自动处理"唯一匹配"，以下决策归 Agent/用户：

1. **needs_resolution 清单**（岗位歧义/文件名不可解析/图片附件）：
   - **⛔ 定岗证据交叉（2026-09-30 机制化，取代纯流程版"定岗三查"）**：resolve 内置证据反证拦截（fail-closed 有反证才拦）——①当日 `_signals.json` 中 `type=invite` 的信号按姓名匹配，证据指向他岗/他工作室 → **判 ambiguous 拦下**（李淑婷模式：群推荐明写"游戏UI，迷你世界"却归长青）；②目标岗在撞名群（同名/近名/工种族，自动推导）时加查 ATS：同人已有同名岗投递在别的工作室 → 拦（黄菲菲模式）；③同人跨岗历史 stderr 提示不拦。查询失败=无证据放行（fail-open）。人工核实确属目标岗 → 加 `--skip-evidence` 放行。对账/撞名群工具见 `archive_audit.mjs`（脚本表）。
   - 能确定岗位 → 单条 resolve（`--job` 传完整路径前缀）：
     ```
     node "…/scripts/resolve_records.mjs" --record <id> --name 张三 \
       --job "长青工作室/美术端/游戏UI设计师" --filename 张三_游戏UI设计师_5年.pdf
     ```
     **判重机制（2026-09-15 盛明明事故后机制化，不靠 Agent 记忆）**：resolve 层**不再判重复**（附件 API 无 size 无 SHA，"同名同岗"判重是瞎猜，曾 4 次误杀：刘小六/苏树林/林秋钰/盛明明——BOSS 候选人把简历和作品分两封投、附件名完全相同）；resolve 遇同人同岗已归档只打 ⚠️ 警告并放行，**判重后移到下载层按 SHA 事实判定**：下载内容与同人同岗已归档文件 **SHA 相同**=真重发 → 自动标 `excluded/DUPLICATE_CONTENT`（⏭️ 正常退出）；**SHA 不同**=不同材料（简历+作品分投/更新版）→ 正常归档，target 同名冲突自动加 `_作品集`/`_2` 后缀改名。**Agent 无需预判"是不是重复"**——resolve 放行、下载闭环、看结果。`DUPLICATE_CONTENT` 与其他 `DUPLICATE_*`/`SAMEDAY_CONFLICT` 一样在 `--new-version` 重开白名单内。
     **⛔ 2026-09-16 补强（用户拍板："同文件名≈简历+作品两份材料，机制必须多检查一遍，不靠记忆"）**：①工具层——`--exclude`/`--exclude-mail` 对**从未下载（无 sha256）的记录打 DUPLICATE_*/SAMEDAY_* 排除码一律拒绝**（BOSS 附件元数据文件名按职位模板生成，两封邮件可完全同名，真实文件名只在 BOSS 聊天可见；林彩华/韩文帝/谢廷三起同款误杀的根源）；②存量重审——每日 collect 阶段3.5 自动跑 `reaudit_duplicates.mjs`：无下载证据的重复类排除 → 重新下载，**SHA 相同或 PDF 文本层逐字一致（同文档重导出）→ 维持排除并记录 `dupe_verified` 证据；不可证同 → 自动重开走正常归档**（>7 天收到的重开件需 collect --backlog 接手）。
   **⛔ 不要把已归档件复制回 Downloads 伪装"用户手动下载"走复用**：归档件常经脱敏重打包，字节已与原附件不同，SHA 判重链路必断（重发件判不出重复，且 archived 终态不可再排除）；重发件宁可让下载层真下载一次，交给 SHA 事实判定。
   - **候选人是更新版简历**（同名同岗已归档、本次是补充AI版/新版）→ `--new-version` 重开归档，文件名加 `_补充AI版` 等后缀：
     ```
     node "…/scripts/resolve_records.mjs" --record <id> --name 张三 --job "…" \
       --filename 张三_岗位_年限_补充AI版.pdf --new-version
     ```
   - 非简历材料/确认无法处理 → 结构化排除（不手改 JSON）：
     ```
     node "…/scripts/resolve_records.mjs" --exclude <id> --code NOT_RESUME --note "背调材料"
     ```
     常用 code：`NOT_RESUME`（非简历材料）/ `NO_MATERIAL`（取不到材料）/ `IRRELEVANT`（与招聘无关）/ `STALE`（过期投递，岗位已停/太久远）/ `OTHER`
   - **一封邮件整批排除**（背调材料一封 13-25 个附件）：`--exclude-mail <id1,id2,...> --code NOT_RESUME`（支持逗号分隔多封一次排除）。⚠️ message_id/record_id 是 40+ 位 base64，**从 manifest 查询取值（命令替换或脚本取），禁止肉眼手抄**——2026-08-21 手抄把 `M` 抄成 `C`（字形相近），排查码点花了 2 分钟
2. **系统/流程邮件（当场排除，别留给"明天"）**：主题含「视频面试邀约 / 欢迎加入 / 【资料收集】/ 薪酬(学历)资料 / 信息征集 / 信息记录 / 测试题」的邮件是面试流程/入职材料，不是简历投递——读正文确认后**当场** `--exclude-mail NOT_RESUME`。⚠️ 边界：候选人**回信继承通知主题**但带简历附件/链接的，附件/链接核查照常走（这类是真简历，2026-08-14 有静默丢简历事故，见 notifications.mjs 头注释）；只有"无附件且无链接"的纯通知才排除
3. **⛔ 当日收尾核对（每天 collect 处理完必做，2026-08-18 铁律）**：汇总里"新到待解析/blocked"清零了吗？没清零的每一条都要么 resolve 要么 --exclude **落终态**——决策停在对话里=明天原样再现（姚宇舟 5 条挂 4 天的教训：08-17 说了"已转发相关负责人"却没落盘，08-18 还在干扰）。汇总标注「⏳已挂N天」的就是漏网
4. **blocked 记录**：`LINK_EXPIRED`（链接失效）→ 联系候选人重发或 `--exclude`；详情拉取失败 → 重跑 collect 自动重试自愈
5. **闸门 STOP 的目录**：按 verify_archive 输出修复（数量不符/薪酬残留/本批次 blocked），修复后单跑闸门复验
6. **图片型/乱码 PDF 闸门报"提取阻断"**：
   **快路径（2026-08-27 用户定稿，主会话首选）**：主会话有视觉能力，`fitz` 渲染候选页 PNG（dpi≥60 保证小字可读）后用 Read **目检薪酬残留**，直接替代 OCR 核查。只看简历信息页（前几页）+ 必要时抽查；目检结论写进交付记录。仅在两种情况才走重流程：①目检发现薪酬→走 `redact_salary.py --vision` 三步流涂白；②评估链路需要文本入库/检索→再跑
   ```
   python "…/scripts/enhance_ocr_pdf.py" <图片型或乱码PDF> [--name 候选人真名]
   ```
   嵌入 OCR 文本层后重跑闸门；`--name` 纠正 OCR 对生僻字的形近字误识。闸门的"提取阻断"本身是 warning 不阻断，目检通过即可放行。

   **⚠️ zip 内图片型简历（2026-09-08 高阳案例，09-20 机制已修一半）**：图片简历常叫 `简历.jpg/个人简历.png`（无姓名岗位词）——**09-20 起 `_is_resume_file` 对文件名含「简历/resume」的图片直接认作简历成员**：批次不再 STOP「没找到简历」、也不再静默判纯作品包🟢漏检（闸门会报「提取阻断」warning 强制人工知情）。**但闸门对图片不做 OCR 薪酬扫描**——凡 zip 内见到 `.jpg/.png` 命名含"简历"的成员，仍必须主动解出跑 `redact_image_salary.py` OCR 定位（无命中则目检/删临时件；命中则涂白后放回 zip 替换原成员），不能只看闸门绿了就交差。
7. **冲突件视觉定名（2026-09-16 用户拍板升级）**：collect 阶段5.5 会对 `_2` 冲突后缀的归档件做内容定名——≥10 页或封面关键词的自动改名 `_作品集`；**单页/页数少/纯图/证据不足的渲染首页进 `notes/_label_queue/` 视觉队列**。Agent 必做：汇总出现"待视觉定名 N 个"时，Read 队列 PNG 亲眼看内容，然后 `node reaudit_duplicates.mjs --apply-label <record_id> --apply-verdict portfolio|resume` 落名（verdict=resume 且此前被误自动改名会自动改回 `_2`）。**页数规则不可靠（8年老简历能写满5页，候选人V误判教训），看图才是终审**。

### 岗位→工作室归属核对（resolve 前必做）

- `--job` 优先传**完整路径前缀**（含 `/` 即触发路径精确匹配，不走模糊）
- 只传岗位名时，投递标题的岗位名必须与归档目录**末级名逐字匹配**，不取近义词（"游戏UI设计师"≠"UIUE设计师"）
- UI / 特效 / 客户端类岗位跨工作室撞名高发：不带路径前缀的这类 resolve，逐个人工确认归属

### 投递标题 vs 简历实际方向核对（闸门/评估阶段必做）

- 归档以邮件标题为起点不是终点；简历文本可读后，核对正文"求职意向/实际经验方向"与归档岗位是否一致
- 方向打架（标题 A 岗、简历方向是另一个在招 B 岗）→ 标"疑挪岗 B"问用户，确认后挪岗重评，不闭眼归 A
- 简历全是跨行经验（B 不是在招岗）→ 按 A 岗评估但注明"疑投错岗"

---

## 分步命令（fallback / 单阶段重跑 / 排障）

| 阶段 | 命令 | 要点 |
|---|---|---|
| 1 扫描 | `node "…/scripts/scan_all.mjs"` | 穷尽分页，原子发布快照；异常不覆盖旧快照。**不支持 --date**。增量主路径=服务端 time_range 过滤（2026-09-30 吴增俊漏件事故二轮加固）：窗口起点=上次扫描时刻−1h 余量（记在 `_scan_all.json.meta.json`），翻完窗口即完整，正确性与列表排序解耦，成本 1-2 页。防御四层：①窗口自检（上次快照最新一封必须出现在窗口结果，否则**自动升级全量**）②锚点模式回退（meta 缺失时走「见到上次快照最旧一封才停」）③锚点兜底触发同样自动升级全量 ④距上次全量 >24h 自动强制全量（`.fullscan`），任何增量漏件最多 24h 自动补上 |
| 2 核查 | `node "…/scripts/verify_mails.mjs" [--date 8.14] [--force]` | 增量（已核查邮件跳过）；`--date` 按邮件收到日过滤；`--force` 全量重拉。通知邮件**不按关键词丢弃**。存量记录自动回填 `received_at` 和 `subject`（按快照邮件）。链接提取覆盖：闭合/无闭合 `<a>`、纯文本裸 URL、img src；兜底关键词含网盘/下载/链接/主页 |
| 3 解析 | `node "…/scripts/resolve_records.mjs" --auto [--dry-run] [--force]` | 附件类从文件名、**链接类从邮件主题**（「姓名-岗位」模式）提取岗位+姓名，唯一匹配才落盘；歧义保留 needs_resolution。目标目录日期段默认=该记录邮件收到日（`--date` 仅人工显式覆盖）。`--dry-run` 先预览。**失败有缓存**：失败过的不再重试（`--force` 强制全量重试），失败清单只列近 7 天 |
| 4a 附件下载 | `node "…/scripts/download_attachment.mjs" --pending` 或 `--records id1,id2` | 事务式（.part→校验→原子提交，目标存在绝不覆盖）；**并发 3**（CLI 冷启动占大头，串行慢 3 倍）；限流自动退避重试；完成自动合并推进 archived |
| 4b 链接下载 | `node "…/scripts/batch_download_links.mjs" --records id1,id2`（不传=全部 verified 链接） | Playwright headless；**反复触发网盘风控页（no_button/下载取消）时加 `BROWSER_HEADED=1` 有头重跑**——真实浏览器指纹过风控，往往一次过（2026-08-27 加）；**下载前自动查 Downloads 本地复用**（链接旁附件名+大小匹配，用户已手动下载的直接归档跳过浏览器，2026-08-20 加）；失效自动标 blocked(LINK_EXPIRED)；完成自动合并。当天收简历**用 --records 精准下**。**大附件 Agent 默认直接下载（2026-09-15 规则反转）**：96.5MB/186MB/189MB/278.9MB 四次实测全部 Playwright 一次成功（2-7 分钟），不再事前推给用户——下不动才升级（连续失败/LINK_EXPIRED 时请用户从邮箱客户端下载，Agent 负责归档，见下方"用户手动下载文件的归档"） |
| 5 合并 | `node "…/scripts/merge_results.mjs"` | 修复工具：中断恢复时手动收尾（常规路径已自动合并；并行收尾禁止，见反模式） |
| 6 脱敏+闸门 | `python "…/scripts/redact_salary.py" --dir <目录1> <目录2> …`（**多目录一条命令**，OCR 模型只加载一次，2026-08-25 提速）→ `python "…/scripts/verify_archive.py" <目录1> <目录2> …`（同样多目标一次跑） | **先脱敏再闸门**（顺序反了闸门必 STOP）；rar 自动转 zip 并删原包；**`.doc` 自动转 PDF（Word COM / soffice）后脱敏，转换成功自动删原 .doc**；闸门输出 `🟢 全过` 才进评估。批量跑闸门时目录会被自动收敛改名（`_暂定`→`_N份`），报"没找到简历"先 ls 确认实际目录名再重跑。⚠️ **`<目录>` 只传当日批次目录（如 `8.21_3份` / `8.21_暂定`），禁止传岗位"已收集简历"根目录**——根目录会全量扫历史几十上百个 PDF，分钟级且无必要（2026-08-21 用户投诉）；历史批次冒出的残留不在日常流程修，一句话报告用户即可。⚠️ **`--dir` 对 zip 内成员的薪酬识别不如闸门细（2026-09-17 陈颂廷案例）**：批量脱敏对 zip 内文本层 PDF 报「0 命中」，闸门同一文件却精准报出「期望薪资：13-14K」→ **闸门 STOP 时不要相信脱敏的"0 命中"结论**。修复：`zipfile` 解出该成员 → 单文件 `redact_salary.py <成员>` → 逐成员重建 zip 替换回去（保持 infolist 顺序与名不变，`os.replace` 原子换）→ 重跑闸门。⚠️ **反向的假阳性也存在（2026-09-17 周洁案例）**：批量模式对**图片型 PDF** 可能报「有薪酬命中但未修改（异常）」，而**单文件重跑同一份报「✅ 无薪酬残留」**——批量告警不可直接采信。处置：先单文件复跑；若仍报命中→按批次里的 `_vision_*` 快路径渲染目标页**目检终审**（周洁 74 页作品集目检前 3 页 + 抽样 5 页确认干净即放行） |

单文件特殊场景（批量模式覆盖不到时）：

```
# 用户手动下载的大附件归档（fallback：仅链接过期/连续下载失败时用户手动下了才走；不跑下载脚本，三步走命令入口，不手改 manifest）。
# ⛔ 动手前两项检查（2026-08-20 铁律，两次重复劳动教训）：
#   ① ls Downloads 确认用户确实已下载（文件名+大小），别盲目等也别重新下载
#   ② 查目标岗位目录/manifest 有没有同人已归档（李展晴重复件/孙国军重复记录教训：
#      mv 前对一下 manifest 同名 archived 记录，重复件不入档）
# 1. mv "Downloads 目录/<原文件>" "<target_dir>/<规范文件名>"
# 2. 写 notes/_download_results/sha256_<record_id 的 : 换成 _>.result.json
#    内容: {"record_id":"sha256:...","outcome":"committed","sha256":"<文件哈希>","target_path":"<目标路径>","at":"<ISO时间>"}
# 3. node "…/scripts/merge_results.mjs"   （blocked 状态先 resolve --record 重推到 verified 再 merge）
# rar 转规范命名 zip（--output 必须绝对路径）
python "…/scripts/redact_salary.py" <简历.rar> --output "F:/…/姓名_岗位_年限_简历加作品.zip"
# ⚠️ 包内含超大成员（单文件 >2GB 视频，zip 安全上限）时 redact 自动保留原 rar/7z 不转 zip
#    （2026-09-30 护栏，刘新榕 2.3GB avi 案：转 zip 会在闸门安全检查必死）。超大成员无文本层，
#    薪酬扫描只针对包内文档类成员（已扫）。闸门对 .rar/.7z 走最小安全检查（无单成员上限），
#    原包直接过闸——不要手劲把超大成员拆出来再重打包，那是 2026-09-29 整个下午的弯路。
# 图片型简历（jpg/图片型PDF，7z 包内图片简历先解出）薪酬脱敏一条命令
python "…/scripts/redact_image_salary.py" <简历.jpg|图片型.pdf>   # 定位命中块→白块→输出验证图复核
# 图片型 PDF 视觉协助脱敏（2026-08-27 加；主会话有视觉后推荐：比 OCR 快一个量级，超大图不再卡批）
# 三步流，闸门已豁免 _vision_定位/ 工作区目录：
python "…/scripts/redact_salary.py" <图片型.pdf> --vision     # ①渲染各页 PNG + rects 清单模板
# ②主会话 Read 页图，目测每处薪酬文本的像素 bbox 填进清单（dpi 保持清单值不动，邻居字段务必留在框外）
python "…/scripts/redact_salary.py" <图片型.pdf> --redact-rects @"<pdf目录>/_vision_定位/<名>_rects.json"
```

---

## 反模式（不要做）

- **不要自己写循环连发下载** —— 用 `--records` / `--pending`（内置限流退避 + 间隔）
- **不要对未下载的记录手工打 DUPLICATE_*/SAMEDAY_* 排除码** —— 工具层直接拒绝（无内容证据的"重复"=瞎猜；BOSS 元数据同名≈简历+作品两份材料是常态）。**09-20 起护栏收口到状态机单一实现**（`transitionToExcluded` 对重复码强制要求 SHA/dupe_verified 证据，download 批量前置自愈的同名排除分支已删除——判重统一下移到下载层 SHA 事实判定）。怀疑重复就让下载层 SHA 判定；历史排除重审跑 `reaudit_duplicates.mjs`
- **不要把取 URL 和下载拆两步** —— auth code 有时效，原子完成
- **不要用 curl 下载链接类附件** —— 只会拿到 HTML 跳转页，必须走浏览器
- **不要手动解压→脱敏→重打包** zip/rar —— `redact_salary --dir` 一条命令搞定
- **不要逐个文件跑脱敏/闸门** —— 用 `--dir` / 传目录
- **不要给 scan_all 传 --date**；**不要手改 manifest JSON** —— 每个状态转移都有命令入口
- **不要把闸门 warning 当阻断** —— `🔴 STOP` 才是阻断；`⚠️` 是人工复核提示（加密 PDF 姓名缺失等）
- **不要用 created_at / updated_at / 目录名判定"何时收到"** —— 唯一依据 manifest `received_at`（字段语义见 archive-contract.md）
- **不要把链接下载失败的记录晾着** —— Playwright 报 no_button/下载取消的 QQ 链接，重跑一次往往能成（风控页是暂时的）；连续失败才列给用户人工下载
- **不要并行跑多个下载/合并任务** —— merge_results 是读-改-写 manifest，两个任务同时收尾会互相覆盖状态；多批记录下载完统一跑一次 merge
- **不要对图片型作品集 PDF 逐页 OCR** —— 薪酬只出现在简历信息页（前几页），后续是作品图；redact_salary 对图片型 PDF 默认只 OCR 前 3 页（`--ocr-pages 0` 才全页），独立快路径用 `redact_image_salary.py`

---

## 脚本

| 脚本 | 用途 |
|------|------|
| `…/scripts/collect.mjs` | **编排器**：一条命令跑完全流程（复用下列脚本，自身无业务逻辑） |
| `…/scripts/scan_all.mjs` | 阶段1 全量扫描，原子发布快照 |
| `…/scripts/verify_mails.mjs` | 阶段2 附件+链接核查，生成/推进 manifest records（并发 fetch，增量跳过） |
| `…/scripts/resolve_records.mjs` | 阶段3 绑定候选人/岗位/目标路径（--auto 批量；--record 单条；--exclude 结构化排除） |
| `…/scripts/download_attachment.mjs` | 阶段4a record 驱动事务式附件下载（--pending/--records，自动合并） |
| `…/scripts/batch_download_links.mjs` | 阶段4b 链接类附件 Playwright 批量下载（失效→blocked，自动合并） |
| `…/scripts/merge_results.mjs` | 阶段5 result.json → manifest 状态推进（修复工具） |
| `…/scripts/reaudit_duplicates.mjs` | 阶段3.5 重复排除重审 + 阶段5.5 冲突件定名（2026-09-16）：无下载证据的 DUPLICATE_* 排除重新下载，SHA/文本层判真重发还是误杀，误杀自动重开；`_2` 冲突件 ≥10 页/封面关键词自动改名 `_作品集`，证据不足进视觉队列（`--apply-label` 落名）。collect 每日自动跑，也可单独执行（`--dry-run` 先看清单） |
| `…/scripts/archive_audit.mjs` | **防错岗对账（2026-09-30）**：`--collisions` 撞名岗位群检测（同名/近名/工种族自动推导，纯本地）；`--audit [--no-ats] [--ats-limit N]` 存量对账（圈定=撞名群∪8月收件∪同人跨岗 → 当日 invite 信号 + ATS 投递比对 → 差异清单 `notes/_archive_audit_<date>.md`，**只列不挪**交用户拍板）；`--impact <岗位>` 新岗建立后跑冲击清单（邻岗历史记录可能本属新岗）。证据模块 `lib/job_evidence.mjs`（resolve 也用） |
| `…/scripts/ats_evidence.py` | ATS 投递证据批查询后端（job_evidence.mjs 调）：复用 `_lark_shared.hire_find_application` requests 直连。⚠️ 查 hire 投递**勿走 lark-cli api**——user token 调 GET /applications 报 1002002 process_id is required（2026-09-30 实测） |
| `…/scripts/redact_salary.py` | 阶段6a 薪酬脱敏（白色覆盖；PDF/DOCX/.doc/ZIP/RAR；--dir 批量+报告；OCR fallback） |
| `…/scripts/verify_archive.py` | 阶段6b 归档闸门（数量/薪酬/manifest 闭环阻断；姓名/格式 warning；_暂定→_N份 收敛；**含已收集简历根散落检测**——岗位已收集简历/ 第一层出现简历类文件即 STOP「简历散落未入日期段」，2026-08-20 22 文件散落 5 周事故后加） |
| `…/scripts/enhance_ocr_pdf.py` | 图片型/乱码 PDF 的 OCR 文本层增强（easyocr；jpg/png 转多页 PDF） |
| `…/scripts/redact_image_salary.py` | 图片型简历（jpg/png/图片型PDF）薪酬脱敏：OCR 前 N 页定位命中块→白块覆盖→输出验证图（复用 salary_pattern 正则） |
| `…/scripts/lib/` | 共享模块：manifest（状态机/原子写）、dates（邮件时间判定单一源）、cli_helpers（参数/lark执行器）、retry（限流退避）、file_identity（SHA-256/类型/原子提交）、html_links、lark_mail、notifications（仅展示标签）、paths（路径真相源） |
| `…/scripts/content_extractors.py` | Python 侧统一内容提取（PDF/OCR/DOCX/.doc） |
| `…/scripts/archive_safety.py` | ZIP 安全检查（穿越/加密/炸弹/嵌套）+ 中文文件名还原 |
| `…/scripts/salary_pattern.py` | 薪酬正则单一真相源（redact + verify 共用） |

## 参考文档（按需加载）

| 文件 | 什么时候读 |
|------|-----------|
| `references/archive-contract.md` | 改归档结构、查 manifest 字段/状态机契约、看闸门判据定义 |
| `references/job-aliases.md` | 岗位名匹配不到目录时查别名表和歧义规则（Unity 三岗等） |
| `references/archive-naming.md` | 同人打包命名规则（2026-09-22 全岗化） |
| `references/link-attachments.md` | 链接下载失败后的 fallback（Playwright MCP 手动操作 / 用户手动下载） |
| `references/decisions.md` | 想知道某条规则"为什么存在"时（历史决策与事故记录，不在执行路径上） |
