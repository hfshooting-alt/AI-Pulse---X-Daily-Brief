# AI Pulse - X Daily Brief

AI 行业日报自动生成 Agent。从 Twitter/X 采集 AI 领域 KOL 动态，经 Gemini 聚类分析后生成结构化日报，通过邮件发送。

## 整体架构

```
109 位人物库
    │
    ▼
┌─────────────────────────────────┐
│  Step 1  Apify 采集近 7 天全量数据  │
└────────────┬────────────────────┘
             ▼
┌─────────────────────────────────┐
│  Step 2  综合评分，选出 TOP20     │
│  outputCount + 互动关系权重       │
│  （回复/引用/提及 五维度加权）      │
└────────────┬────────────────────┘
             ▼
┌─────────────────────────────────┐
│  Step 3  抓取 TOP20 近 24h 动态   │
│  → 全量 Action Sheet (按topic聚类)│
│  → AI 相关内容过滤                │
└────────────┬────────────────────┘
             ▼
┌─────────────────────────────────┐
│  Step 4  Gemini 生成日报          │
│  独立聚类 → TOP3 热点 + 中热度事件 │
│  + Today's Summary (面向高管)     │
│  + prompt-rules.md 累积规则注入   │
└────────────┬────────────────────┘
             ▼
┌─────────────────────────────────┐
│  Step 5  交叉验证                 │
│  从量子位/机器之心/新智元视角       │
│  审视覆盖盲区与权重偏差            │
│  → iteration-log.md              │
└────────────┬────────────────────┘
             ▼
┌─────────────────────────────────┐
│  Step 6  SMTP 邮件发送            │
│  Markdown → HTML 渲染             │
└─────────────────────────────────┘
```

## TOP20 评分机制

排名不只看发帖数量，而是综合活跃度和圈内互动：

```
compositeScore = outputCount + interactionScore × 2
```

互动分由五个维度加权：

| 互动类型 | 含义 | 权重 |
|----------|------|------|
| 被引用转发 | 观点被同行引用讨论 | 1.5x |
| 主动引用 | 引用他人观点参与讨论 | 1.2x |
| 回复 | 直接回复他人推文 | 1.0x |
| 被提及 | 被他人 @点名 | 0.8x |
| 主动提及 | @提及他人 | 0.5x |

## 日报结构

| 板块 | 内容 |
|------|------|
| **TOP3 热度事件** | 参与人数最多的 3 个具体事件，含热点解析 + 相关动态（附来源链接） |
| **中热度话题** | 7-12 条事件，按 Topic 分组，覆盖更广的行业动态 |
| **TOP20 活跃人物** | 真名、账号、职位、今日 action 数量、涉及热点数、同行互动数 |
| **Today's Summary** | 面向高管的 200 字结构化摘要：关键结论 / 重要原因 / 业务影响 |

## 输出产物

每次运行生成以下文件（均在 `AI日报/artifacts/` 下）：

| 文件 | 说明 |
|------|------|
| `daily-report.md` | 日报正文（同时作为邮件内容发送） |
| `top20-action-sheet.md / .csv` | TOP20 人物全量 Action Sheet，按 topic 聚类，日报是其子集 |
| `ai-weekly-output-counts.md / .csv` | 全员近 7 天动态数量排名（含互动分） |
| `iteration-log.md` | 交叉验证历史记录，按日期累积 |
| `media-cross-validation-sources.json` | 交叉验证抓取到的微信公众号文章（仅量子位/机器之心/新智元，近2天，优先 Twitter/X 相关新闻） |
| `top20-ranking.json` | TOP20 排名原始数据 |

## 自迭代机制

```
日报生成 → 交叉验证（量子位/机器之心/新智元视角）
                ↓
        iteration-log.md（自动保存）
                ↓
        用户审阅，挑选有价值的建议
                ↓
        手动写入 prompt-rules.md
                ↓
        下次生成日报时自动注入 Prompt ──→ 日报质量持续提升
```

`AI日报/prompt-rules.md` 是规则累积文件，格式自由，例如：

```markdown
### 2026-03-27
- TOP3 热点解析每条至少写 3 句话
- 不要把同一产品的不同功能更新拆成多个事件
- 注意覆盖 AI 安全/治理类话题
```

## 使用方式

在 GitHub Actions 页面手动触发 `workflow_dispatch`。

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
| `GEMINI_THINKING_LEVEL` | 否 | 思考深度 minimal / low / medium / high |
| `GEMINI_RETRY_WEAK_STRUCTURE` | 否 | 当日报结构过弱（TOP3/中热度/链接不足）时是否自动重试一次 Gemini（默认 true） |
| `SMTP_HOST` | 是 | SMTP 服务器 |
| `SMTP_PORT` | 是 | SMTP 端口 |
| `SMTP_USER` | 是 | SMTP 用户名 |
| `SMTP_PASS` | 是 | SMTP 密码 |
| `MAIL_FROM` | 是 | 发件人 |
| `MAIL_TO` | 是 | 收件人 |
| `MAIL_SUBJECT` | 否 | 邮件主题 |
| `APIFY_REUSE_RECENT_RUNS` | 否 | 是否优先复用最近成功 run 的 dataset（默认 true） |
| `APIFY_REUSE_RUNS_LIMIT` | 否 | 复用检查的最近 run 数量（默认 10，最大 50） |
| `APIFY_REUSE_MAX_AGE_HOURS` | 否 | 仅复用最近 N 小时内的 run（默认 36 小时） |
| `APIFY_SKIP_SECOND_FETCH_IF_SUFFICIENT` | 否 | 当 weekly 数据已足够覆盖 TOP20 的日窗口时，跳过第二次 Apify 抓取（默认 true） |
| `APIFY_DAILY_MIN_ITEMS` | 否 | 判断 weekly 子集“足够”时的最小日动态数量阈值（默认 80） |
| `APIFY_DAILY_MAX_MISSING_TOP20` | 否 | 判断 weekly 子集“足够”时允许缺失动态的 TOP20 人数上限（默认 8） |
| `APIFY_DAILY_MIN_AI_ITEMS` | 否 | 跳过第二次抓取前，weekly 子集里最少 AI 相关动态数（默认 30） |
| `APIFY_DAILY_MIN_AI_HANDLES` | 否 | 跳过第二次抓取前，weekly 子集里最少有 AI 动态的 TOP20 账号数（默认 8） |
| `CROSS_VALIDATE_USE_JINA` | 否 | 交叉验证抓取失败时是否启用 `r.jina.ai` 回源兜底（默认 true） |

## 项目结构

```
AI日报/
├── scripts/
│   └── daily-report.mjs    ← 核心脚本，包含全部 Agent 逻辑
├── prompt-rules.md          ← 累积反馈规则（自动注入 Prompt）
├── artifacts/               ← 运行产物（日报、Action Sheet、迭代日志等）
└── package.json
```
