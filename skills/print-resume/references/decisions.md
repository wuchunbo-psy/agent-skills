# print-resume 决策记录（考古层，执行时不读）

> 开源版说明：本文为脱敏版——候选人以「某候选人」代称，打印机/路径换占位符；
> 工程决策的完整来龙去脉保持原样。

## 2026-09-03 建档：简历打印翻车演进

**起点**：用户要"直接打印"（不手动 WPS）。本机默认 PDF handler 是 WPS，无静默打印 CLI；Edge 无 print verb。

**第一版 GDI 渲染路线**：PyMuPDF 渲染 300dpi PNG → PowerShell `PrintDocument` 直推默认打印机。出纸成功，但两个问题被用户点名：
1. 双面方向错乱——横向内容用了默认长边翻转，背面倒置 180°。.NET 命名反直觉：`Duplex.Vertical`（=DEVMODE `DMDUP_HORIZONTAL`）才是短边翻转（翻书式）；`Duplex.Horizontal` 反而是长边。修为显式 `Duplex.Vertical` 后正确。
2. 任务名用了英文（`Candidate_Resume_5pages`），用户在打印机面板上辨认费劲 → 任务名必须中文。

**为什么当初要渲染**：Windows 静默打印接口（GDI）只认图片流不认 PDF；WPS 手动打印时是它内部转的。渲染不是多余工序，是补 WPS 缺席后的"翻译"环节。

**第二版 SumatraPDF 路线（现行）**：用户接受建议装了 SumatraPDF（`winget install SumatraPDF.SumatraPDF`，用户级装到 `%LOCALAPPDATA%`）。优势：
- PDF 直打一条命令：`-print-to "打印机" -print-settings "1-5,fit,duplexshort" -silent -exit-when-done`
- 退出码语义官方定义（0/1/2/3/4/5），失败可报告原因
- 打印任务名=文件名 → 中文文件名天然中文任务名，GDI 版的任务名问题消失
- 横向自动旋转（auto-rotation 默认开）+ fit 缩放

**bash 直调 SumatraPDF 假失败**：git-bash 内联跑 `-print-to '<PRINTER_UNC>'` 退出码异常（1）但 ParseFlags 调试输出正常；换 PowerShell `Start-Process -Wait` 退出码 0 成功。结论：UNC 打印机名走 bash 会被 MSYS 层搅动，一律 subprocess list 传参（已固化进脚本）。

**试打浪费纸教训**：验证时漏传页码范围，把 5 页完整版打了出去（1-2 份）。教训：打印命令的页码范围必须是脚本拼装的一部分（全打=显式省略页码参数=有意为之），不靠人肉记着带。这也是 skill 化的核心理由——参数固化进脚本后此类失误归零。

**auto 分界规则取舍**：从第 2 页起找作品集标记（跳过第 1 页防"附作品集链接"误伤）；标记词命中在正文（如"参与XX作品集项目"）会误截，但方向是多截不漏截，出纸可目检；>8 页无标记 fail-closed 让人给范围，不猜。8 页阈值：多数纯简历 ≤5 页，合订本作品集动辄几十页。

**合订本截取用重建不用 select()**：某候选人 98 页 19.9MB 的 PDF，`doc.select([0..4])` 后仍是 19MB——PPT 导出的 PDF 整套资源字典共享，select 保留了未引用图片。`show_pdf_page` 逐页重建 + `garbage=4` 后 0.6MB。

## 2026-09-04 任务名短名化：面板显示的是全路径不是文件名

用户到打印机取件，面板上任务名把整条归档路径（在招岗位候选人管理/项目团队/技术端/岗位/…）全吐出来没法认。根源：SumatraPDF 的打印任务名=**文档全路径**，CLI 没有指定任务名的参数——建档时写的"任务名=文件名"只对了文件名部分，面板实际显示路径，归档库一深就废。

**修法（用户拍板"说明岗位和姓名就行"）**：打印前一律 copy 成「岗位_姓名.pdf」（岗位=归档路径中「已收集简历」的上一层文件夹，姓名取 `--name` 或文件名首段）放下载目录浅层再打；截取版加 `_简历部分`。发送成功（退出码 0=已入 spooler，文件已被读走）即删副本，不留垃圾；失败保留副本供直接重试。归档外散文件（--pdf 直给）退回原文件名。

**为什么放下载目录不放 %TEMP%**：面板显示全路径，TEMP 路径更长更难认；下载目录是既有产物目录且路径浅。

**9-04 二次返工：下载目录还不够短，且源码坐实根因**。某候选人一打，面板显示 `<下载目录>\某候选人_3D角色设计师_7年.pdf`——用户看到还是有目录链。审查 SumatraPDF 源码：本机 3.6.1（tag `3.6.1rel`）`PrintToDevice` 默认分支 `di.lpszDocName = ToWStrTemp(engine.FilePath())` 写死全路径；master 才改成 basename-only（issue #2166，"some printer drivers/spoolers choke on long or non-ASCII full paths"）并新增 `-print-settings docname=` 显式任务名。3.6.1 两样都没有。**修法：副本挪到盘符根**，任务名只剩「F:\岗位_姓名.pdf」；不加 %TEMP%/C盘（C盘根要管理员，TEMP 链长）。**没走升级路线**：打印链路在 3.6.1 上验证过，升级新版虽原生修任务名，但双面/缩放行为要重新真纸验收，不值得为一行面板文字冒险；已把升级选项和代价写进 SKILL.md 坑清单。

**9-04 同日第三次返工：升级路线其实走得通，上轮"没走升级"的论据有错**。用户要求升级试试。查实：①3.6.1 就是官方最新**稳定版**（2026-04-06 发布，GitHub releases 与 winget 源一致，没有任何 prerelease tag）——上轮暗示"升级到新版"隐含存在新稳定版，是错的，basename-only 修复只存在于 master 源码；②但官方 [prerelease 日报构建](https://www.sumatrapdfreader.org/prerelease) 存在，版本清单在 `sumatralatest.js`（`dl/prerel/<build号>/...`），最新 build 21978（2026-09-02 构建）包含全部 master 修复。**执行**：下载 `SumatraPDF-prerel-64-install.exe` 静默安装（参数查 winget 清单坐实：`-s -install -with-preview -d <目录>`，用户级装回原目录），3.6.1 → 3.7.0.21978，已发真纸验证件（某候选人 4 页，命令参数与 3.6.1 完全一致，退出码0）。脚本零改动（根目录短名副本机制保留：新版任务名=basename，面板显示「岗位_姓名.pdf」无任何路径前缀）。**代价与后续**：prerel 版脱离 winget 管理，以后更新走 prerelease 页。**用户目检回执（9-04）：面板只显示「岗位_姓名.pdf」，无路径前缀——坑关闭。**
