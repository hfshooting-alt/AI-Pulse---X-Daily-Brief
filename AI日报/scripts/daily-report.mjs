import fs from 'node:fs/promises';
import nodemailer from 'nodemailer';

const requiredEnv = [
  'APIFY_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'MAIL_TO',
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}


function optionalEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) return undefined;
  return value.trim();
}

function parseBooleanEnv(value, defaultValue = false) {
  if (typeof value !== 'string') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function maskSecret(value) {
  if (!value) return '(empty)';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function normalizeApifyToken(raw) {
  const value = raw.trim();
  if (value.includes('token=')) {
    try {
      const asUrl = new URL(value);
      const tokenFromQuery = asUrl.searchParams.get('token');
      if (tokenFromQuery) return tokenFromQuery;
    } catch {
      const match = value.match(/token=([^&\s]+)/);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
  }
  return value;
}

function normalizeActorId(rawActorId) {
  const actorId = rawActorId.trim();
  // Apify API path format prefers "username~actor-name".
  return actorId.includes('/') ? actorId.replace('/', '~') : actorId;
}

function getPromptTemplate() {
  return process.env.REPORT_PROMPT_TEMPLATE || `你是一个专业的AI行业分析师和情报Agent。
你的任务是根据我提供的【真实抓取数据】，生成一份今日的“TwitterAI动态日报”。

追踪的名单包括：
Twitter (X): Elon Musk, Sam Altman, Andrej Karpathy, Yann LeCun, Demis Hassabis, Jim Fan, Ashok Elluswamy, Andrew Ng, Fei-Fei Li, Ilya Sutskever, François Chollet, Geoffrey Hinton, Mustafa Suleyman, Greg Brockman, Noam Brown, Thomas Wolf, Dario Amodei, Aravind Srinivas, Arthur Mensch, Alexandr Wang

以下是真实抓取并清洗后的最新动态数据（JSON格式）：
{{APIFY_ITEMS_JSON}}

请仔细阅读上述真实数据，并严格按照以下逻辑生成报告：

【数据筛选规则】
1. 仅仅关注这些人物关于“AI（人工智能）”以及“前沿科技”的发帖、转帖。
2. 严格筛选掉无关的发帖（例如：日常闲聊、调侃、政治、生活琐事等）。

【报告结构与排版要求】
请彻底摒弃“流水账”式的按人头罗列的写法。必须以“事件/事实”为核心，突出重点。发帖人不应该作为事实的主语，而仅仅作为信息的Reference（来源参考）。

请参考以下结构生成日报：

# TwitterAI动态日报

## 一、[大类名称，如：核心产品动态与市场反响]

1. **[提炼的核心事件标题]**
   * **事件：** [客观描述发生了什么事实，并以人物作为来源参考] [查看原帖](url)
   * **关键进展：** [如果有详细内容，分点展开]

## 二、[大类名称]
...

## 三、[大类名称]
...

## 四、其他值得关注的动向
* **[简短标题]：** [一句话描述事实，发帖人作为Reference] [查看原帖](url)

**总结：** [总结今日AI领域趋势。]

【写作风格要求】
- 突出重点，提炼核心价值。
- 忠于事实，避免主观臆断。
- 每条事实必须附原帖链接。
- 语言专业、精炼。`;
}

async function runApify() {
  const token = normalizeApifyToken(requireEnv('APIFY_TOKEN'));
  const taskId = optionalEnv('APIFY_TASK_ID');
  const actorId = optionalEnv('APIFY_ACTOR_ID');

  if (!taskId && !actorId) {
    throw new Error('Missing required environment variable: APIFY_TASK_ID or APIFY_ACTOR_ID');
  }

  const inputRaw = optionalEnv('APIFY_ACTOR_INPUT_JSON');
  const input = inputRaw ? JSON.parse(inputRaw) : undefined;

  // Prefer task execution when available to keep input source-of-truth in Apify console.
  const runPath = taskId
    ? `https://api.apify.com/v2/actor-tasks/${encodeURIComponent(taskId)}/run-sync-get-dataset-items`
    : `https://api.apify.com/v2/acts/${encodeURIComponent(normalizeActorId(actorId))}/run-sync-get-dataset-items`;

  const runSyncUrl = new URL(runPath);
  runSyncUrl.searchParams.set('token', token);
  runSyncUrl.searchParams.set('clean', 'true');

  const requestOptions = {
    method: 'POST',
  };

  if (input !== undefined) {
    requestOptions.headers = { 'Content-Type': 'application/json' };
    requestOptions.body = JSON.stringify(input);
  }

  const runResp = await fetch(runSyncUrl, requestOptions);

  if (!runResp.ok) {
    throw new Error(`Apify run failed: ${runResp.status} ${await runResp.text()}`);
  }

  const items = await runResp.json();
  if (!Array.isArray(items)) {
    throw new Error('Apify returned non-array dataset items.');
  }

  return {
    items,
    runData: { id: taskId || normalizeActorId(actorId), status: 'SUCCEEDED' },
    datasetId: 'run-sync-output',
  };
}

async function generateReport(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    return `# TwitterAI动态日报\n\n日期：${today}\n\n## 今日概览\n\n今日抓取结果为 0 条有效动态，暂无可整理的 Twitter AI 前沿信息。\n\n## 建议排查\n\n1. 检查 Apify Actor 输入配置是否正确（账号列表、时间窗口、过滤条件）。\n2. 检查目标账号是否在抓取时间段内发布了公开内容。\n3. 检查 Actor 内的过滤规则、时间窗口与账号列表设置。\n`;
  }

  const apiKey = requireEnv('OPENAI_API_KEY');
  const model = requireEnv('OPENAI_MODEL');

  const prompt = getPromptTemplate().replace('{{APIFY_ITEMS_JSON}}', JSON.stringify(items, null, 2));

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: Number(process.env.OPENAI_TEMPERATURE || 0.2),
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  const text = [
    json?.output_text,
    ...(json?.output || []).flatMap((item) =>
      (item?.content || [])
        .map((contentItem) => contentItem?.text)
        .filter((value) => typeof value === 'string'),
    ),
  ]
    .filter((value) => typeof value === 'string')
    .join('\n')
    .trim();

  if (!text) {
    const outputLength = Array.isArray(json?.output) ? json.output.length : 0;
    throw new Error(
      `OpenAI returned empty textual output. status=${json?.status || 'unknown'}, output_length=${outputLength}`,
    );
  }

  return text;
}

async function sendEmail(reportMarkdown) {
  const host = requireEnv('SMTP_HOST');
  const port = Number(requireEnv('SMTP_PORT'));
  const user = requireEnv('SMTP_USER');
  const pass = requireEnv('SMTP_PASS');
  const secure = process.env.SMTP_SECURE
    ? parseBooleanEnv(process.env.SMTP_SECURE, false)
    : port === 465;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
  });

  try {
    await transporter.verify();
  } catch (error) {
    const errMsg = error?.message || String(error);
    throw new Error(
      `SMTP verify failed: ${errMsg}\n` +
        `Current SMTP config => host=${host}, port=${port}, secure=${secure}, user=${maskSecret(user)}\n` +
        `If your provider is 163/QQ/Gmail, use an SMTP authorization code (app password), not the mailbox login password.`,
    );
  }

  const now = new Date();
  const subject = process.env.MAIL_SUBJECT || `Twitter AI 动态日报 ${now.toISOString().slice(0, 10)}`;
  const to = requireEnv('MAIL_TO')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  if (to.length === 0) {
    throw new Error('MAIL_TO must contain at least one email recipient.');
  }

  const html = `<pre style="white-space: pre-wrap; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; line-height:1.5">${reportMarkdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</pre>`;

  await transporter.sendMail({
    from: requireEnv('MAIL_FROM'),
    to,
    subject,
    text: reportMarkdown,
    html,
  });
}

async function main() {
  requiredEnv.forEach(requireEnv);

  const { items, runData, datasetId } = await runApify();
  console.log(`Apify run ${runData.id} succeeded with ${items.length} items from dataset ${datasetId}.`);

  const report = await generateReport(items);
  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile('artifacts/daily-report.md', report, 'utf8');

  await sendEmail(report);
  console.log('Daily report generated and emailed successfully.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
