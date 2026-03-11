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

function getBjtTodayAndYesterday() {
  const bjtFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const today = bjtFormatter.format(new Date());
  const [year, month, day] = today.split('-').map((v) => Number.parseInt(v, 10));
  const yesterdayUtcMs = Date.UTC(year, month - 1, day) - 24 * 60 * 60 * 1000;
  const yesterdayDate = new Date(yesterdayUtcMs);
  const yesterday = `${yesterdayDate.getUTCFullYear()}-${String(yesterdayDate.getUTCMonth() + 1).padStart(2, '0')}-${String(
    yesterdayDate.getUTCDate(),
  ).padStart(2, '0')}`;

  return { today, yesterday };
}

function parseApifyInputTemplate(inputRaw) {
  try {
    return JSON.parse(inputRaw);
  } catch {
    const normalized = inputRaw.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(normalized);
  }
}

function applyBjtDateWindowToApifyInput(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.searchTerms)) {
    return input;
  }

  const { today, yesterday } = getBjtTodayAndYesterday();
  const nextInput = {
    ...input,
    searchTerms: input.searchTerms.map((term) => {
      if (typeof term !== 'string') return term;

      return term
        .replace(/since:\d{4}-\d{2}-\d{2}/g, `since:${yesterday}`)
        .replace(/until:\d{4}-\d{2}-\d{2}/g, `until:${today}`);
    }),
  };

  console.log(`Applied BJT date window to searchTerms: since=${yesterday}, until=${today}`);
  return nextInput;
}


async function fetchApifyDatasetItems({ token, actorId, input }) {
  const runPath = `https://api.apify.com/v2/acts/${encodeURIComponent(normalizeActorId(actorId))}/run-sync-get-dataset-items`;

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
  const responseText = await runResp.text();

  if (!runResp.ok) {
    throw new Error(`Apify run failed: ${runResp.status} ${responseText}`);
  }

  let items;
  try {
    items = JSON.parse(responseText);
  } catch {
    throw new Error(`Apify returned non-JSON response: ${responseText.slice(0, 500)}`);
  }

  if (!Array.isArray(items)) {
    throw new Error('Apify returned non-array dataset items.');
  }

  return items;
}


function parsePositiveIntEnv(name, fallback) {
  const value = optionalEnv(name);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isReducibleOpenAIInputError(message) {
  return /context_length_exceeded|context window|input exceeds the context window|rate_limit_exceeded|request too large|tokens per min|must be reduced/i.test(
    message || '',
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestOpenAIReport({ apiKey, model: selectedModel, prompt }) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: selectedModel,
      input: prompt,
      temperature: Number(process.env.OPENAI_TEMPERATURE || 0.2),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${body}`);
  }

  let itemLimit = items.length;
  while (itemLimit >= 1) {
    try {
      const limitedItems = items.slice(0, itemLimit);
      const prompt = getPromptTemplate().replace('{{APIFY_ITEMS_JSON}}', JSON.stringify(limitedItems, null, 2));
      const result = await requestOpenAIReport({ apiKey, model, prompt });

      if (itemLimit < items.length) {
        console.warn(
          `OpenAI context guard applied: used ${itemLimit}/${items.length} items to stay within model context window.`,
        );
      }

      return normalizeMarkdownLayout(result);
    } catch (error) {
      const message = error?.message || String(error);
      if (!isReducibleOpenAIInputError(message)) {
        throw error;
      }

      if (itemLimit <= minItems) {
        throw new Error(
          `OpenAI request still too large at ${itemLimit} items. Set a larger-context OPENAI_MODEL or reduce APIFY_ACTOR_INPUT_JSON size/window. Last error: ${message}`,
        );
      }

      itemLimit = Math.max(minItems, Math.floor(itemLimit / 2));
      console.warn(`OpenAI request too large, retrying with ${itemLimit} items after ${retryDelayMs}ms...`);
      await sleep(retryDelayMs);
    }
  }

  throw new Error('Failed to generate report due to repeated OpenAI context limit errors.');
}


function normalizeMarkdownLayout(markdown) {
  if (!markdown || typeof markdown !== 'string') return markdown;

  let text = markdown.replace(/\r\n/g, '\n').trim();

  // Ensure headings start on new lines.
  text = text.replace(/([^\n])\s+(#{1,6}\s)/g, '$1\n\n$2');

  // Ensure ordered list items are not glued to previous sentence.
  text = text.replace(/([^\n])\s+(\d+\.\s+)/g, '$1\n\n$2');

  // Ensure bullet lines are separated.
  text = text.replace(/([^\n])\s+([*-]\s+)/g, '$1\n$2');

  // Keep key labels readable.
  text = text.replace(/\*\*事件：\*\*/g, '\n  - **事件：**');
  text = text.replace(/\*\*关键进展：\*\*/g, '\n  - **关键进展：**');

  // Trim excessive blank lines.
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return `${text}\n`;
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
- 语言专业、精炼。

【强制排版要求（必须严格遵守）】
- 仅输出标准 Markdown，不要输出 HTML。
- 每个标题（# / ##）必须独占一行，前后保留空行。
- 每个编号条目（1. / 2. / 3.）必须独占一行。
- “事件/关键进展”使用子级列表缩进，不得与标题写在同一行。
- 禁止将多个段落、标题、列表拼接在一行。`;
}

async function runApify() {
  const token = normalizeApifyToken(requireEnv('APIFY_TOKEN'));
  const actorId = requireEnv('APIFY_ACTOR_ID');

  const inputRaw = optionalEnv('APIFY_ACTOR_INPUT_JSON');
  const parsedInput = inputRaw ? parseApifyInputTemplate(inputRaw) : undefined;
  const input = parsedInput ? applyBjtDateWindowToApifyInput(parsedInput) : undefined;

  const items = await fetchApifyDatasetItems({ token, actorId, input });
  return {
    items,
    runData: { id: normalizeActorId(actorId), status: 'SUCCEEDED' },
    datasetId: 'run-sync-output',
  };
}

async function generateReport(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    return `# TwitterAI动态日报

日期：${today}

## 今日概览

今日抓取结果为 0 条有效动态，暂无可整理的 Twitter AI 前沿信息。

## 建议排查

1. 检查 Apify Actor 输入配置是否正确（账号列表、时间窗口、过滤条件）。
2. 检查目标账号是否在抓取时间段内发布了公开内容。
3. 检查 Actor 内的过滤规则、时间窗口与账号列表设置。
`;
  }

  const apiKey = requireEnv('OPENAI_API_KEY');
  const openaiModel = requireEnv('OPENAI_MODEL');
  const minItems = parsePositiveIntEnv('OPENAI_MIN_ITEMS', 20);
  const retryDelayMs = parsePositiveIntEnv('OPENAI_RETRY_DELAY_MS', 1500);

  console.log(`Using OPENAI_MODEL=${openaiModel}`);

  let itemLimit = items.length;
  while (itemLimit >= 1) {
    try {
      const limitedItems = items.slice(0, itemLimit);
      const prompt = getPromptTemplate().replace('{{APIFY_ITEMS_JSON}}', JSON.stringify(limitedItems, null, 2));
      const result = await requestOpenAIReport({ apiKey, model: openaiModel, prompt });

      if (itemLimit < items.length) {
        console.warn(
          `OpenAI context guard applied: used ${itemLimit}/${items.length} items to stay within model context window.`,
        );
      }

      return normalizeMarkdownLayout(result);
    } catch (error) {
      const message = error?.message || String(error);
      if (!isReducibleOpenAIInputError(message)) {
        throw error;
      }

      if (itemLimit <= minItems) {
        throw new Error(
          `OpenAI request still too large at ${itemLimit} items. Set a larger-context OPENAI_MODEL or reduce APIFY_ACTOR_INPUT_JSON size/window. Last error: ${message}`,
        );
      }

      itemLimit = Math.max(minItems, Math.floor(itemLimit / 2));
      console.warn(`OpenAI request too large, retrying with ${itemLimit} items after ${retryDelayMs}ms...`);
      await sleep(retryDelayMs);
    }
  }

  throw new Error('Failed to generate report due to repeated OpenAI context limit errors.');
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
