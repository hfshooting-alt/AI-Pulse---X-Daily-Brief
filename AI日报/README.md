<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/641843a5-ce53-4d86-aa3d-2aab448276f4

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## GitHub Actions 自动化日报

仓库已添加工作流：`.github/workflows/twitter-ai-daily-report.yml`。

流程：
1. 触发 Apify Actor 抓取数据。
2. 拉取 Actor 输出数据集。
3. 调用 OpenAI 生成日报 markdown。
4. 通过 SMTP 发邮件到目标收件箱。
5. 上传 `artifacts/daily-report.md` 作为 Action 构建产物。

可手动触发（workflow_dispatch），也可按 cron 每天自动触发。

### Apify 配置注意事项

- `APIFY_ACTOR_ID` 请填写 Actor 标识：`apidojo/tweet-scraper` 或 `apidojo~tweet-scraper`（脚本会自动兼容这两种写法）。
- `APIFY_TOKEN` 可以填纯 token，也可以直接填带 `?token=...` 的完整 API URL，脚本会自动提取 token。
- `APIFY_TASK_ID` 已不再使用，无需配置。
- 仅当设置 `APIFY_ACTOR_INPUT_JSON` 时，脚本才会覆盖输入；未设置时沿用 Actor 默认输入。
- 若 `APIFY_ACTOR_INPUT_JSON` 包含 `searchTerms`，脚本会按北京时间（Asia/Shanghai）自动改写每项中的 `since`/`until` 为“昨天→今天”的日期窗口后再调用 Apify。
- 若模板 JSON 存在尾逗号，脚本会在不改变语义前提下自动修正为合法 JSON 再解析。
- 运行日志会打印 `Using OPENAI_MODEL=...`，可直接确认 Action 实际调用的模型名。
- 邮件正文会将 Markdown 渲染为分级样式 HTML（标题字号、层级列表、颜色区分），并将来源链接渲染为可点击 `@本名` 超链接。
- 日报格式会自动清理独立 `*` 噪声行，并按章节自动重排编号（避免每条都显示为 `1.`）。

- 可选：`APIFY_PEOPLE_JSON` 支持传入人物库（JSON数组或每行 `name,item`/`name,handle`）；脚本优先读取 `item` 字段并转换为 `from:<item> since:<date> until:<date>` 形式。
- 采集逻辑：先按“近7天、最多1000条”拉全量输出并保存 `artifacts/all-outputs.json`，再按输出量排名取TOP20用于“近1天”日报生成。
- 每人近7天动态数表格会写入 `AI日报/artifacts/ai-weekly-output-counts.md` 与 `AI日报/artifacts/ai-weekly-output-counts.csv`，并随 workflow artifact 一起下载。
- 日报末尾会自动追加附录，列出TOP20人物的真名、账号与输出数量。

- 日报主标题统一为 `AI Pulse - X Daily Brief`。
- 来源链接文案统一为 `@本名` 超链接（不再使用“查看原帖”与X用户名显示）。
- 事件结构统一为“热点解析 + 相关动态”。

- 附录标题统一为 `TOP20活跃人物`，每位人物包含：本名、账号、输出数量、一句话描述（来自人物库 description/desc/bio 字段）。

- 正文末尾新增 `Today's Summary`（面向高管），按“关键结论/重要原因/业务影响”结构化输出，限制在200字内。
- 附录新增“每日Action数量”和“每日涉及热点数量”，并给出热点概览排序。
