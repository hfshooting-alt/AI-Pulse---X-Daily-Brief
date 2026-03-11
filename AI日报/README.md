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

- `APIFY_ACTOR_ID` 推荐填 `apidojo~tweet-scraper`（若填 `apidojo/tweet-scraper`，脚本会自动转换）。
- `APIFY_TOKEN` 可以填纯 token，也可以直接填带 `?token=...` 的完整 API URL，脚本会自动提取 token。
- 支持 `APIFY_TASK_ID`（推荐）：若提供将优先运行 Task，复用 Apify 控制台已保存输入配置。
- ⚠️ `APIFY_TASK_ID` 不是 `apidojo/tweet-scraper` 这种 Actor 标识；Task ID 通常是短 ID（如 `abc123XYZ`）或 `username/task-name`。
- `apidojo/tweet-scraper` / `apidojo~tweet-scraper` 属于 Actor 标识，应配置在 `APIFY_ACTOR_ID`。
- 脚本兼容误配：若 `APIFY_TASK_ID` 看起来像 Actor 标识，会自动按 Actor 调用。
- 若不提供 `APIFY_TASK_ID`，则使用 `APIFY_ACTOR_ID` 直接运行 Actor。
- 仅当设置 `APIFY_ACTOR_INPUT_JSON` 时，脚本才会覆盖默认输入；未设置时沿用 Apify 侧默认/Task 输入。
