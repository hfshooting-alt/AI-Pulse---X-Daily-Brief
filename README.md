# AI Pulse - X Daily Brief

一个保留核心分析产物的 AI 日报 Agent：

```text
Twitter/X API 抓取指定账号近一周动态
        ↓
按发帖量 + 五维度同行互动分生成 TOP20 活跃人物
        ↓
Twitter/X API 抓取 TOP20 近 24h 动态
        ↓
Gemini 原生 API 生成中文 Markdown 日报
        ↓
保存/复用历史抓取缓存，输出 artifacts，并通过 SMTP 邮件发送
```

当前版本只删除 **Apify 抓取链路** 和 **OpenAI-compatible / 多 Base URL / 多 Key fallback 等复杂兜底嵌套**。TOP20 活跃人物排名、互动关系五维度加权、TOP20 Action Sheet 这类有实际输出价值的逻辑已保留。

## 保留的核心能力

- **抓取方式**：只使用 TwitterAPI.io `GET /twitter/user/last_tweets`，不再使用 Apify。
- **LLM**：只调用 Google Gemini 原生 `generateContent` API。
- **历史缓存**：默认读写 `AI日报/artifacts/twitter-history.json`，GitHub Actions 会用 cache 跨运行保存，避免每次为了 TOP20 重爬整周数据。
- **TOP20 排名**：基于近一周动态数与同行互动分计算。
- **互动关系五维度加权**：
  - 被引用转发：`1.5x`
  - 主动引用：`1.2x`
  - 回复：`1.0x`
  - 被提及：`0.8x`
  - 主动提及：`0.5x`
- **原始日报处理链路**：保留 AI 相关过滤、同人/同线程去重、话题统计、基于 Gemini 的具体事件聚类、TOP3/中热度热度分类、结构修复重试和 Today's Summary。
- **微信公众号交叉验证**：保留从量子位、机器之心、新智元公开微信文章抓取元数据并交给 Gemini 做覆盖盲区/权重偏差检查。
- **日报发送**：用 SMTP 将 Markdown 日报转成 HTML 邮件发送。
- **提示词补充**：如果存在 `AI日报/prompt-rules.md`，会自动拼进 Gemini 提示词。

## 输出产物

每次运行会写入 `AI日报/artifacts/`：

| 文件 | 说明 |
|---|---|
| `daily-report.md` | Gemini 生成的日报正文，文末追加 TOP20 活跃人物。 |
| `tweets.json` / `tweets.csv` | TOP20 近 24h 动态，供排查日报来源。 |
| `weekly-tweets.json` | 本次用于 TOP20 排名的近一周数据（历史缓存 + 本次增量）。 |
| `twitter-history.json` | 跨运行复用的历史抓取缓存，默认保留 TOP20 所需窗口外加少量缓冲。 |
| `ai-weekly-output-counts.md` / `.csv` | 全员近一周发帖量、互动分、同行互动数、综合分。 |
| `top20-ranking.json` | TOP20 排名原始 JSON。 |
| `top20-action-sheet.md` / `.csv` | TOP20 近 24h 全量 Action Sheet，按话题分组。 |
| `media-cross-validation-sources.json` | 微信公众号交叉验证抓到的量子位/机器之心/新智元公开文章元数据。 |
| `iteration-log.md` | Gemini 基于微信公众号来源给出的覆盖盲区、权重偏差和 prompt 改进建议。 |



## TwitterAPI.io 调用方式与字段映射

脚本现在调用的是你给出的接口：

```bash
curl --request GET \
  --url "https://api.twitterapi.io/twitter/user/last_tweets?userName=sama&includeReplies=true" \
  --header "X-API-Key: $TWITTERAPI_API_KEY"
```

每个账号按页读取 `tweets`，使用 `has_next_page` / `next_cursor` 翻页，直到达到历史缓存增量起点或单账号抓取上限。脚本会把 TwitterAPI.io 返回字段标准化为内部字段：`author.userName -> handle`、`likeCount/replyCount/retweetCount/quoteCount -> metrics`、`entities.user_mentions -> mentions`、`isReply/inReplyToUsername -> replied_to`、`quoted_tweet.author.userName -> quoted`。

## 历史缓存如何避免重复爬取

之前只有 `weekly-tweets.json` 作为当次运行 artifact，GitHub Actions 下一次运行不会自动拿它继续用，所以确实会重复抓近一周数据。

现在脚本会：

1. 先读取 `twitter-history.json`。
2. 从缓存里筛出近一周、且属于当前账号列表的动态。
3. 只从「缓存中最新一条动态时间 - 5 分钟」开始增量调用 Twitter/X API。
4. 合并缓存与新增动态，再生成 TOP20 排名、周榜和 Action Sheet。
5. 写回 `twitter-history.json`；GitHub Actions 用 `actions/cache` 在下次运行前恢复这个文件。

如果账号列表大幅变化，或者你怀疑缓存不完整，可以临时设置 `TWITTER_FORCE_FULL_FETCH=true` 强制重爬一次。

## GitHub Secrets 配置

### 必填

| Secret | 说明 |
|---|---|
| `TWITTERAPI_API_KEY` | TwitterAPI.io API Key，会通过 `X-API-Key` header 调用 `/twitter/user/last_tweets`。 |
| `TWITTER_HANDLES` | 要抓取的账号列表，支持逗号、空格或换行分隔，例如 `sama,karpathy,demishassabis`。 |
| `GEMINI_API_KEY` | Google AI Studio / Gemini API Key。 |
| `GEMINI_MODEL` | Gemini 模型名，例如 `gemini-2.5-flash`。 |
| `SMTP_HOST` | SMTP 服务器地址。 |
| `SMTP_PORT` | SMTP 端口，常见为 `465` 或 `587`。 |
| `SMTP_USER` | SMTP 用户名。 |
| `SMTP_PASS` | SMTP 密码或应用专用密码。 |
| `MAIL_FROM` | 发件人地址。 |
| `MAIL_TO` | 收件人地址，多个地址通常可用逗号分隔。 |

### 可选

| Secret | 默认值 | 说明 |
|---|---:|---|
| `TWITTER_PEOPLE_JSON` | 空 | 比 `TWITTER_HANDLES` 更丰富的账号配置。设置后优先使用它；可选填 `userId`，会比 `userName` 更稳定。示例：`[{"handle":"sama","userId":"...","name":"Sam Altman","title":"OpenAI CEO","description":"OpenAI CEO"}]`。 |
| `REPORT_WEEKLY_LOOKBACK_HOURS` | `168` | TOP20 排名使用的回看窗口。脚本会从历史缓存复用旧数据，并用 `last_tweets` 增量补最新页。 |
| `REPORT_WEEKLY_MAX_TWEETS` | `1000` | 近一周最多抓取多少条动态，上限在脚本里限制为 3000。 |
| `REPORT_LOOKBACK_HOURS` | `24` | TOP20 日报动态抓取窗口。 |
| `REPORT_MAX_TWEETS` | `120` | 最多交给 Gemini 的 TOP20 日动态数，上限在脚本里限制为 500。 |
| `TWITTER_INCLUDE_REPLIES` | `true` | 调用 `last_tweets` 时是否包含回复；保留回复有助于互动关系加权。 |
| `TWITTER_HISTORY_PATH` | `artifacts/twitter-history.json` | 历史缓存路径；一般不用改。 |
| `TWITTER_FORCE_FULL_FETCH` | `false` | 设为 `true` 时忽略缓存，强制重爬近一周窗口。 |
| `GEMINI_TEMPERATURE` | `0.3` | Gemini 生成温度。 |
| `CROSS_VALIDATE_WITH_MEDIA` | `true` | 是否开启微信公众号媒体交叉验证。 |
| `CROSS_VALIDATE_USE_JINA` | `true` | 直抓搜索页/微信文章失败时，是否尝试 Jina Reader fallback。 |
| `SMTP_SECURE` | `true` | 是否使用 TLS；如果端口是 587，可按邮件服务商要求设为 `false`。 |
| `MAIL_SUBJECT` | `AI 日报 YYYY-MM-DD` | 邮件标题。 |

## 本地测试

进入项目目录：

```bash
cd AI日报
npm ci
python3 -m py_compile scripts/daily_report.py
```

只验证脚本语法不需要任何 Secret。若要跑完整链路：

```bash
export TWITTERAPI_API_KEY="你的 TwitterAPI.io API Key"
export TWITTER_HANDLES="sama,karpathy,demishassabis"
export GEMINI_API_KEY="你的 Gemini API Key"
export GEMINI_MODEL="gemini-2.5-flash"
export SMTP_HOST="smtp.example.com"
export SMTP_PORT="465"
export SMTP_USER="name@example.com"
export SMTP_PASS="your-password"
export MAIL_FROM="name@example.com"
export MAIL_TO="receiver@example.com"

npm run run:daily-report
```

如果只想在本地生成文件、不发邮件，可以额外设置：

```bash
export SKIP_EMAIL=true
npm run run:daily-report
```

运行成功后检查：

```bash
cat artifacts/daily-report.md
cat artifacts/ai-weekly-output-counts.md
cat artifacts/top20-action-sheet.md
```

## GitHub Actions 使用

在 GitHub Actions 页面手动触发 `Twitter AI Daily Report` workflow。当前 workflow 会安装依赖、检查脚本语法、恢复 `twitter-history.json` 缓存、运行日报脚本、保存新的历史缓存，并上传所有日报/TOP20 artifacts。

## 已删除的复杂逻辑

- 删除 Apify Token、Actor、Task、Actor Input Template、run reuse/cache 等采集路径。
- 删除 OpenAI-compatible Base URL / Endpoint 路由、多个 API Key fallback、公司平台兼容分支。
- 删除大段硬编码人物画像兜底表；人物信息优先从 `TWITTER_PEOPLE_JSON` 读取。
- 保留有实际输出的筛选、聚类、热度分类、TOP20、Action Sheet 和微信公众号交叉验证逻辑。

## 目录说明

```text
AI日报/scripts/daily_report.py   # 日报 Agent 主脚本
AI日报/prompt-rules.md           # 可选的中文提示词补充规则
.github/workflows/twitter-ai-daily-report.yml  # 手动触发的 GitHub Actions
```
