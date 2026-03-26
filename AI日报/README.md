# AI Pulse - X Daily Brief

AI 行业日报自动生成 Agent。从 Twitter/X 采集 AI 领域 KOL 动态，经 Gemini 聚类分析后生成结构化日报，通过邮件发送。

## 核心流程

```
Apify 采集 → 去重/聚类 → Gemini 生成日报 → Gemini 生成 Summary → SMTP 邮件发送
```

1. **数据采集**：通过 Apify Actor 抓取 TOP20 活跃 KOL 近 24h 的 Twitter 动态
2. **数据清洗**：按 handle + 文本相似度两轮去重，过滤非 AI 相关内容
3. **报告生成**：Gemini 根据动态数据独立聚类，按参与人数排序输出 TOP3 热点 + 中热度事件
4. **Summary 生成**：基于完成的报告，单独生成面向高管的 200 字结构化摘要
5. **邮件发送**：Markdown 渲染为 HTML，通过 SMTP 发送

## 日报结构

- **TOP3 热度事件** — 参与人数最多的 3 个具体事件，每条含热点解析 + 相关动态（附来源链接）
- **中热度话题** — 7-12 条事件，按 Topic 分组
- **TOP20 活跃人物附录** — 真名、账号、职位、今日 action 数量、涉及热点数
- **Today's Summary** — 关键结论 / 重要原因 / 业务影响

## 使用方式

手动触发 GitHub Actions workflow（`workflow_dispatch`）。

## 持续改进

编辑 `prompt-rules.md` 添加反馈规则，下次生成日报时自动生效。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `APIFY_TOKEN` | 是 | Apify API Token |
| `APIFY_ACTOR_ID` | 是 | Apify Actor 标识 |
| `APIFY_ACTOR_INPUT_JSON` | 否 | Actor 输入覆盖（含 searchTerms 时自动改写日期窗口） |
| `APIFY_PEOPLE_JSON` | 否 | 人物库 JSON |
| `GEMINI_API_KEY` | 是 | Gemini API Key |
| `GEMINI_MODEL` | 是 | Gemini 模型名 |
| `GEMINI_MAX_OUTPUT_TOKENS` | 否 | 最大输出 token（默认 65536） |
| `GEMINI_TEMPERATURE` | 否 | 温度参数（默认 1.0） |
| `GEMINI_THINKING_LEVEL` | 否 | 思考深度 minimal/low/medium/high |
| `SMTP_HOST` | 是 | SMTP 服务器 |
| `SMTP_PORT` | 是 | SMTP 端口 |
| `SMTP_USER` | 是 | SMTP 用户名 |
| `SMTP_PASS` | 是 | SMTP 密码 |
| `MAIL_FROM` | 是 | 发件人 |
| `MAIL_TO` | 是 | 收件人 |
| `MAIL_SUBJECT` | 否 | 邮件主题 |
