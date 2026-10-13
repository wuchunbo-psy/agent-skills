# 发布兜底手册（finalize_report.py 失败时的人工路径）

> 正常路径：`scripts/finalize_report.py --date {M.DD}` 一条命令完成 派生发布版 → import → 发链接。
> 本手册只在脚本失败（鉴权缺失 / import 报错 / IM 发送失败）时使用。

## 鉴权检查（缺权限先补）

```bash
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 lark-cli auth status --json --verify
```

`identities.user.scope` 需含 `drive:drive`（导入）+ `im:message`（发消息）。scope 字段是**空格分隔字符串**，判断用 `if 'drive' in scopes_str`，不要迭代。

缺权限 → split-flow 授权（不在同一轮阻塞）：`lark-cli auth login --domain drive --domain im --no-wait --json`，拿 `verification_url` 后 `lark-cli auth qrcode <url> --output qrcode.png` 生成二维码一起展示给用户，授权完成后继续。

## 手动三步

```bash
# 1. 派生发布版（脚本 --skip-publish 已生成 notes/_发布版_简历评估_{M.DD}.md，可直接用）
#    规则：删「## 归档说明」整节；删本地绝对路径行（归档相对路径保留）；反引号内裸 | 转义 \|

# 2. 导入飞书 Docx（--file 只接受相对路径，必须 cd 到 notes/）
cd <PROJECT_ROOT>/notes && \
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 MSYS_NO_PATHCONV=1 \
lark-cli drive +import --file "./_发布版_简历评估_{M.DD}.md" --type docx --name "简历评估 {M.DD} · {N}人"

# 3. 发链接（纯 URL 单独一条消息，飞书才渲染文档卡片）
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 MSYS_NO_PATHCONV=1 \
lark-cli im +messages-send --user-id YOUR_OPEN_ID --text "{url}"
```

## 返回字段要点

- import 成功：`ok=true`，URL 在 **`data.url`**（不在 result 下）；秒级完成，无需轮询。
- 超时未就绪：`data.ready=false` + `data.ticket` → 续查 `lark-cli drive +task_result --scenario import --ticket <TICKET>`，最多 3 次。
- import 失败：`data.job_status≠0` + `data.job_error_msg` → 走兜底。
- IM 成功：`ok=true` 即送达。

## 兜底与纪律

| 场景 | 动作 |
|------|------|
| import 失败（格式/大小/权限） | IM 发文字："飞书发布失败（原因：{err}），本地报告：<PROJECT_ROOT>/notes/简历评估_{M.DD}.md" |
| 续查 3 次未 ready | 同上 |
| IM 也失败 | 终端打印 URL 让用户手动复制，不阻塞其他收尾 |
| import 重试 | 不超过 2 次——失败大概率是格式问题，重试无用 |

- 用 `--text` 不用 `--markdown`（纯 URL 在 `--text` 下自动渲染卡片）。
- 链接单独一条消息；要补说明，发完纯链接后再单独发文字。
- 不要 `docs +create` / `lark-markdown`（表格渲染不如 `drive +import` 稳）。
- 环境变量必加：`MSYS_NO_PATHCONV=1`（git-bash 吞 `/` 前导路径→404）、`LARKSUITE_CLI_NO_*_NOTIFIER=1`（防 `_notice` 污染 JSON 解析）。
