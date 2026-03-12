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
  if (!value || !value.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}

function optionalEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function normalizeActorId(rawActorId) {
  const actorId = rawActorId.trim();
  return actorId.includes('/') ? actorId.replace('/', '~') : actorId;
}

function normalizeApifyToken(raw) {
  const value = raw.trim();
  if (!value.includes('token=')) return value;
  try {
    const url = new URL(value);
    return url.searchParams.get('token') || value;
  } catch {
    const match = value.match(/token=([^&\s]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : value;
  }
}

function parseBooleanEnv(value, fallback = false) {
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return fallback;
}

function maskSecret(value) {
  if (!value) return '(empty)';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function formatBjtDateDaysAgo(daysAgo) {
  const now = new Date();
  const bjtNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const shifted = new Date(Date.UTC(bjtNow.getFullYear(), bjtNow.getMonth(), bjtNow.getDate() - daysAgo));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function parseApifyInputTemplate(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
  }
}

function normalizeHandle(value) {
  return String(value || '').trim().replace(/^@/, '');
}

function parsePeopleRoster(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((row) => {
          if (typeof row === 'string') return { name: row, handle: normalizeHandle(row) };
          return {
            name: String(row?.name || row?.fullname || row?.displayName || row?.item || row?.handle || '').trim(),
            handle: normalizeHandle(
              row?.item || row?.handle || row?.username || row?.account || row?.twitter || row?.x || row?.id,
            ),
            description: String(row?.description || row?.desc || row?.bio || row?.note || '').trim(),
          };
        })
        .filter((r) => r.handle);
    }
  } catch {}

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.includes(',')
        ? line.split(',').map((v) => v.trim())
        : line.split(/\s+/).map((v) => v.trim());
      const [name, itemOrHandle] = parts;
      return { name: name || itemOrHandle, handle: normalizeHandle(itemOrHandle || name), description: '' };
    })
    .filter((r) => r.handle);
}

function getRosterFromEnvOrTemplate(templateInput) {
  const envRoster = parsePeopleRoster(optionalEnv('APIFY_PEOPLE_JSON'));
  if (envRoster.length > 0) return envRoster;

  const searchTerms = Array.isArray(templateInput?.searchTerms) ? templateInput.searchTerms : [];
  return searchTerms
    .map((term) => String(term).match(/from:([^\s]+)/i)?.[1])
    .filter(Boolean)
    .map((handle) => ({ name: handle, handle: normalizeHandle(handle) }));
}

function buildApifyInput(templateInput, handles, since, until, maxItems = 1000) {
  const base = templateInput && typeof templateInput === 'object' ? { ...templateInput } : {};
  return {
    ...base,
    maxItems,
    searchTerms: handles.map((h) => `from:${normalizeHandle(h)} since:${since} until:${until}`),
  };
}

async function fetchApifyDatasetItems({ token, actorId, input }) {
  const runPath = `https://api.apify.com/v2/acts/${encodeURIComponent(normalizeActorId(actorId))}/run-sync-get-dataset-items`;
  const runSyncUrl = new URL(runPath);
  runSyncUrl.searchParams.set('token', token);
  runSyncUrl.searchParams.set('clean', 'true');

  const response = await fetch(runSyncUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input || {}),
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`Apify run failed: ${response.status} ${body}`);

  let items;
  try {
    items = JSON.parse(body);
  } catch {
    throw new Error(`Apify returned non-JSON response: ${body.slice(0, 500)}`);
  }

  if (!Array.isArray(items)) throw new Error('Apify returned non-array dataset items.');
  return items;
}

function extractHandleFromItem(item) {
  const keys = [
    item?.author?.userName,
    item?.author?.username,
    item?.author?.screenName,
    item?.userName,
    item?.username,
    item?.screenName,
    item?.ownerUsername,
    item?.handle,
  ];
  for (const k of keys) {
    const h = normalizeHandle(k);
    if (h) return h;
  }
  return '';
}

function extractTextFromItem(item) {
  return [item?.text, item?.fullText, item?.full_text, item?.tweetText, item?.title]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' \n ')
    .toLowerCase();
}

function isAiRelatedItem(item) {
  const text = extractTextFromItem(item);
  if (!text) return false;
  const kws = [
    'ai', 'artificial intelligence', 'llm', 'model', 'agent', 'openai', 'anthropic', 'gpt', 'gemini', 'claude',
    'nvidia', 'robot', 'inference', 'training', '人工智能', '大模型', '智能体', '推理', '算力', '芯片', '机器学习',
  ];
  return kws.some((k) => text.includes(k));
}

function classifyHotspot(text) {
  const rules = [
    { label: '模型与推理能力', kws: ['model', 'llm', 'inference', 'gpt', 'gemini', 'claude', '大模型', '推理'] },
    { label: 'Agent与自动化', kws: ['agent', 'workflow', 'automation', '智能体', '自动化'] },
    { label: '算力与芯片', kws: ['nvidia', 'gpu', 'chip', '算力', '芯片'] },
    { label: '机器人与具身智能', kws: ['robot', 'humanoid', 'optimus', '机器人', '具身'] },
    { label: '产品发布与商业化', kws: ['launch', 'release', 'pricing', 'funding', '融资', '发布', '定价'] },
  ];

  const lower = String(text || '').toLowerCase();
  for (const rule of rules) {
    if (rule.kws.some((k) => lower.includes(k))) return rule.label;
  }
  return '其他AI动态';
}

function getHotspotStats(items) {
  const counts = new Map();
  for (const item of items) {
    const label = classifyHotspot(extractTextFromItem(item));
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  const hotspots = Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  return {
    actionCount: items.length,
    hotspotCount: hotspots.length,
    hotspots,
  };
}

function rankPeople(items, roster) {
  const counts = new Map();
  for (const item of items) {
    const handle = extractHandleFromItem(item);
    if (!handle) continue;
    counts.set(handle, (counts.get(handle) || 0) + 1);
  }

  const meta = new Map(roster.map((r) => [normalizeHandle(r.handle), { name: r.name || r.handle, description: r.description || '' }]));
  return Array.from(counts.entries())
    .map(([handle, outputCount]) => ({
      name: (meta.get(handle)?.name) || handle,
      description: (meta.get(handle)?.description) || '',
      handle,
      outputCount,
    }))
    .sort((a, b) => b.outputCount - a.outputCount);
}

function appendTop20Appendix(markdown, top20, stats) {
  const safeStats = stats || { actionCount: 0, hotspotCount: 0, hotspots: [] };
  const hotspotRows = (safeStats.hotspots || [])
    .slice(0, 8)
    .map((h, i) => `${i + 1}. ${h.label}（${h.count}条）`)
    .join('\n');

  const rows = top20
    .map((p, i) => `${i + 1}. ${p.name}（@${p.handle}）- ${p.outputCount} 条\n   一句话：${p.description || '待补充'}`)
    .join('\n');

  return `${markdown.trim()}\n\n## TOP20活跃人物\n\n- 每日Action数量：${safeStats.actionCount}\n- 每日涉及热点数量：${safeStats.hotspotCount}\n\n### 热点概览（按涉及Action量）\n${hotspotRows || '暂无'}\n\n### 人物清单\n${rows}\n`;
}

function relabelSourceLinksWithRealNames(markdown, people) {
  const map = new Map((people || []).map((p) => [normalizeHandle(p.handle), p.name || p.handle]));

  return String(markdown || '').replace(/\[查看原帖\]\((https?:\/\/[^)]+)\)/g, (_, url) => {
    let handle = '';
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      handle = normalizeHandle(parts[0] || '');
    } catch {
      const m = String(url).match(/x\.com\/([^/\s?#]+)/i);
      handle = normalizeHandle(m?.[1] || '');
    }

    const realName = map.get(handle);
    return realName ? `[@${realName}](${url})` : `[@来源](${url})`;
  });
}

function normalizeMarkdownLayout(markdown) {
  let text = String(markdown || '').replace(/\r\n/g, '\n').trim();
  text = text.replace(/^\s*\*\s*$/gm, '');
  text = text.replace(/([^\n])\s+(#{1,6}\s)/g, '$1\n\n$2');
  text = text.replace(/([^\n])\s+(\d+\.\s+)/g, '$1\n\n$2');
  text = text.replace(/\*\*事件：\*\*/g, '\n○ **热点解析：**');
  text = text.replace(/\*\*关键进展：\*\*/g, '\n○ **相关动态：**');

  // remove unwanted section blocks
  text = text.replace(/\n##\s*(四、其他值得关注的动向|五、AI大厂与投资机构资讯|额外观察)[\s\S]*?(?=\n##\s|$)/g, '');

  const lines = text.split('\n').map((line) => line.replace(/^\s*[•*-]\s*○\s*/, '○ ').replace(/^\s*[•*-]\s*■\s*/, '■ '));

  // remove noisy lines like ### or cluster labels
  const cleaned = lines.filter((line) => {
    const t = line.trim();
    if (t === '###') return false;
    if (/^聚类[一二三四五六七八九十0-9]+[:：]/.test(t)) return false;
    return true;
  });

  // renumber all top-level ordered items sequentially
  let idx = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const m = cleaned[i].match(/^(\s*)\d+\.\s+(.*)$/);
    if (m) {
      idx += 1;
      cleaned[i] = `${m[1]}${idx}. ${m[2]}`;
    }
  }

  text = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  if (!/##\s*Today's Summary/i.test(text)) {
    text += "\n\n## Today's Summary\n\n- 关键结论：今日高热度集中在AI能力落地与产品化推进。\n- 重要原因：头部公司密集发布与资本动作叠加，放大市场关注。\n- 业务影响：建议高管优先布局组织级部署、成本治理与执行效率。";
  }

  return `${text}\n`;
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatInlineMarkdown(text) {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

function markdownToStyledHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let inUl = false;
  let inEventCard = false;

  const closeLists = () => {
    if (inUl) {
      html.push('</ul>');
      inUl = false;
    }
  };

  const closeEventCard = () => {
    closeLists();
    if (inEventCard) {
      html.push('</div>');
      inEventCard = false;
    }
  };

  html.push(`<div style="font-family:'PingFang SC','Microsoft YaHei',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(180deg,#f4f8ff 0%,#f8fafc 32%,#ffffff 100%);padding:24px;border-radius:18px;color:#0f172a;">`);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const h1 = line.match(/^#\s+(.+)/);
    if (h1) {
      closeEventCard();
      html.push(`<div style="margin:0 0 22px;padding:18px 20px;border-radius:14px;background:linear-gradient(120deg,#0b1220 0%,#1e293b 100%);box-shadow:0 10px 24px rgba(15,23,42,0.18);"><h1 style="font-size:34px;line-height:1.22;margin:0;color:#f8fafc;letter-spacing:0.2px;">${formatInlineMarkdown(h1[1])}</h1><div style="margin-top:8px;font-size:14px;color:#cbd5e1;">Auto-generated intelligence brief</div></div>`);
      continue;
    }

    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      closeEventCard();
      html.push(`<h2 style="font-size:26px;line-height:1.28;margin:26px 0 12px;color:#0f172a;border-left:5px solid #3b82f6;padding-left:10px;">${formatInlineMarkdown(h2[1])}</h2>`);
      continue;
    }

    const ordered = line.match(/^(\d+)\.\s+(.+)/);
    if (ordered) {
      closeEventCard();
      inEventCard = true;
      html.push('<div style="margin:12px 0 14px;padding:14px 16px;border-radius:12px;background:#ffffff;border:1px solid #dbeafe;box-shadow:0 6px 18px rgba(30,41,59,0.08);">');
      html.push(`<div style="display:inline-block;font-size:13px;font-weight:700;color:#1d4ed8;background:#dbeafe;border-radius:999px;padding:3px 10px;margin-bottom:8px;">事件 ${ordered[1]}</div>`);
      html.push(`<div style="font-size:20px;line-height:1.55;font-weight:700;color:#111827;">${formatInlineMarkdown(ordered[2])}</div>`);
      continue;
    }

    const bullet = line.match(/^[○■*-]\s+(.+)/);
    if (bullet) {
      if (!inUl) {
        html.push('<ul style="margin:10px 0 0 24px;padding:0;color:#1f2937;">');
        inUl = true;
      }
      html.push(`<li style="margin:7px 0;font-size:17px;line-height:1.75;">${formatInlineMarkdown(bullet[1])}</li>`);
      continue;
    }

    closeLists();
    html.push(`<p style="margin:8px 0 0;font-size:18px;line-height:1.78;color:#334155;">${formatInlineMarkdown(line)}</p>`);
  }

  closeEventCard();
  html.push(`</div>`);

  return html.join('').replace(/<a /g, '<a style="color:#2563eb;text-decoration:none;font-weight:600;" ');
}


function getPromptTemplate() {
  return process.env.REPORT_PROMPT_TEMPLATE || `你是一个专业的AI行业分析师和情报Agent。
请根据提供的数据生成日报。

# AI Pulse - X Daily Brief

输出要求：
1) 先输出TOP3热度事件（按相关输出量排序）
2) 再输出7-12条中热度事件，按3-4个聚类大点组织
3) 不需要按传统行业大类分类
4) 每个事件统一结构：\n   - ○ **热点解析：** [事件抽象总结]\n   - ○ **相关动态：** [参与者动态，分点列出]\n5) 不要输出“聚类一/二/三”字样；不要输出“额外观察”与“AI大厂与投资机构资讯”板块\n6) 关联动态中的来源链接，不使用“查看原帖”，统一写成 [@本名](url)（本名不是X用户名）\n7) 文末新增 Today\'s Summary 板块，用3条结构化要点（关键结论/重要原因/业务影响），总计不超过200字\n8) 输出Markdown，结构清晰，分级列表明确
`;
}

async function requestOpenAIReport({ apiKey, model, prompt }) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: prompt, temperature: Number(process.env.OPENAI_TEMPERATURE || 0.2) }),
  });

  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
  const json = await response.json();
  const text = [
    json?.output_text,
    ...(json?.output || []).flatMap((item) => (item?.content || []).map((c) => c?.text).filter((v) => typeof v === 'string')),
  ].filter(Boolean).join('\n').trim();

  if (!text) throw new Error('OpenAI returned empty textual output.');
  return text;
}

async function runApify(input) {
  const token = normalizeApifyToken(requireEnv('APIFY_TOKEN'));
  const actorId = requireEnv('APIFY_ACTOR_ID');
  const items = await fetchApifyDatasetItems({ token, actorId, input });
  return { items, runData: { id: normalizeActorId(actorId), status: 'SUCCEEDED' }, datasetId: 'run-sync-output' };
}

async function generateReport(items, top20, stats) {
  if (!Array.isArray(items) || items.length === 0) {
    return `# AI Pulse - X Daily Brief\n\n今日无可用AI相关内容。\n`;
  }

  const apiKey = requireEnv('OPENAI_API_KEY');
  const model = requireEnv('OPENAI_MODEL');
  console.log(`Using OPENAI_MODEL=${model}`);

  const prompt = `${getPromptTemplate()}\n\n数据如下：\n${JSON.stringify(items, null, 2)}`;
  const markdown = await requestOpenAIReport({ apiKey, model, prompt });
  const normalized = normalizeMarkdownLayout(markdown);
  const withRealNameLinks = relabelSourceLinksWithRealNames(normalized, top20);
  return appendTop20Appendix(withRealNameLinks, top20, stats);
}

async function sendEmail(reportMarkdown) {
  const host = requireEnv('SMTP_HOST');
  const port = Number(requireEnv('SMTP_PORT'));
  const user = requireEnv('SMTP_USER');
  const pass = requireEnv('SMTP_PASS');
  const secure = process.env.SMTP_SECURE ? parseBooleanEnv(process.env.SMTP_SECURE, false) : port === 465;

  const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  try {
    await transporter.verify();
  } catch (error) {
    const errMsg = error?.message || String(error);
    throw new Error(
      `SMTP verify failed: ${errMsg}\nCurrent SMTP config => host=${host}, port=${port}, secure=${secure}, user=${maskSecret(user)}`,
    );
  }

  const subject = process.env.MAIL_SUBJECT || `Twitter AI 动态日报 ${new Date().toISOString().slice(0, 10)}`;
  const to = requireEnv('MAIL_TO').split(',').map((v) => v.trim()).filter(Boolean);
  if (to.length === 0) throw new Error('MAIL_TO must contain at least one email recipient.');

  await transporter.sendMail({
    from: requireEnv('MAIL_FROM'),
    to,
    subject,
    text: reportMarkdown,
    html: markdownToStyledHtml(reportMarkdown),
  });
}

async function main() {
  requiredEnv.forEach(requireEnv);

  const templateRaw = optionalEnv('APIFY_ACTOR_INPUT_JSON');
  const templateInput = templateRaw ? parseApifyInputTemplate(templateRaw) : {};
  const roster = getRosterFromEnvOrTemplate(templateInput);
  if (roster.length === 0) {
    throw new Error('No people roster found. Set APIFY_PEOPLE_JSON or provide searchTerms in APIFY_ACTOR_INPUT_JSON.');
  }

  const today = formatBjtDateDaysAgo(0);
  const yesterday = formatBjtDateDaysAgo(1);
  const weekAgo = formatBjtDateDaysAgo(7);

  const weeklyInput = buildApifyInput(templateInput, roster.map((p) => p.handle), weekAgo, today, 1000);
  console.log(`Example weekly searchTerm: from:${roster[0].handle} since:${weekAgo} until:${today}`);
  const weekly = await runApify(weeklyInput);
  console.log(`Weekly items: ${weekly.items.length}`);

  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile('artifacts/all-outputs.json', JSON.stringify(weekly.items, null, 2), 'utf8');

  const ranking = rankPeople(weekly.items, roster);
  const top20 = ranking.slice(0, 20);
  await fs.writeFile('artifacts/top20-ranking.json', JSON.stringify(top20, null, 2), 'utf8');

  const dailyInput = buildApifyInput(templateInput, top20.map((p) => p.handle), yesterday, today, 1000);
  if (top20.length > 0) console.log(`Example daily searchTerm: from:${top20[0].handle} since:${yesterday} until:${today}`);
  const daily = await runApify(dailyInput);
  const aiRelatedDaily = daily.items.filter(isAiRelatedItem);
  console.log(`Daily items: ${daily.items.length}, AI-related: ${aiRelatedDaily.length}`);
  const hotspotStats = getHotspotStats(aiRelatedDaily);

  const report = await generateReport(aiRelatedDaily, top20, hotspotStats);
  await fs.writeFile('artifacts/daily-report.md', report, 'utf8');

  await sendEmail(report);
  console.log('Daily report generated and emailed successfully.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
