import fs from 'node:fs/promises';
import nodemailer from 'nodemailer';

const requiredEnv = [
  'APIFY_TOKEN',
  'APIFY_ACTOR_ID',
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
  const actorId = normalizeActorId(requireEnv('APIFY_ACTOR_ID'));
  const waitForFinish = Number(process.env.APIFY_WAIT_FOR_FINISH_SECONDS || 300);
  const maxItems = Number(process.env.APIFY_DATASET_LIMIT || 200);

  const input = process.env.APIFY_ACTOR_INPUT_JSON
    ? JSON.parse(process.env.APIFY_ACTOR_INPUT_JSON)
    : {};

  const runUrl = new URL(`https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs`);
  runUrl.searchParams.set('waitForFinish', String(waitForFinish));
  runUrl.searchParams.set('token', token);

  const runResp = await fetch(runUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!runResp.ok) {
    throw new Error(`Apify run failed: ${runResp.status} ${await runResp.text()}`);
  }

  const runJson = await runResp.json();
  const runData = runJson?.data;
  if (!runData) {
    throw new Error('Apify run response missing data.');
  }
  if (runData.status !== 'SUCCEEDED') {
    throw new Error(`Apify run did not succeed. Status: ${runData.status}`);
  }

  const datasetId = runData.defaultDatasetId;
  if (!datasetId) {
    throw new Error('Apify run has no defaultDatasetId.');
  }

  const datasetUrl = new URL(`https://api.apify.com/v2/datasets/${datasetId}/items`);
  datasetUrl.searchParams.set('clean', 'true');
  datasetUrl.searchParams.set('limit', String(maxItems));
  datasetUrl.searchParams.set('token', token);

  const itemsResp = await fetch(datasetUrl);

  if (!itemsResp.ok) {
    throw new Error(`Apify dataset fetch failed: ${itemsResp.status} ${await itemsResp.text()}`);
  }

  const items = await itemsResp.json();
  if (!Array.isArray(items)) {
    throw new Error('Apify dataset items are not an array.');
  }

  return { items, runData, datasetId };
}

async function generateReport(items) {
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
  const text = json?.output_text?.trim();
  if (!text) {
    throw new Error('OpenAI returned empty output_text.');
  }

  return text;
}

async function sendEmail(reportMarkdown) {
  const transporter = nodemailer.createTransport({
    host: requireEnv('SMTP_HOST'),
    port: Number(requireEnv('SMTP_PORT')),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: requireEnv('SMTP_USER'),
      pass: requireEnv('SMTP_PASS'),
    },
  });

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
