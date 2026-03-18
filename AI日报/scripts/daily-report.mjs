import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';

const requiredEnv = [
  'APIFY_TOKEN',
  'APIFY_ACTOR_ID',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
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

async function withRetry(fn, { retries = 3, baseDelayMs = 2000, label = 'operation' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable = /ECONNRESET|ETIMEDOUT|ENOTFOUND|UND_ERR|fetch failed|AbortError|50[0-3]|429/i.test(err?.message || '');
      if (attempt >= retries || !isRetryable) throw err;
      const delay = baseDelayMs * (2 ** attempt);
      console.warn(`${label} attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
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
  // BJT = UTC+8, use fixed offset instead of locale-dependent toLocaleString parsing
  const nowUtcMs = Date.now();
  const bjtMs = nowUtcMs + 8 * 60 * 60 * 1000;
  const bjtDate = new Date(bjtMs);
  bjtDate.setUTCDate(bjtDate.getUTCDate() - daysAgo);
  return `${bjtDate.getUTCFullYear()}-${String(bjtDate.getUTCMonth() + 1).padStart(2, '0')}-${String(bjtDate.getUTCDate()).padStart(2, '0')}`;
}

function parseApifyInputTemplate(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
  }
}

function normalizeHandle(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase();
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
            title: String(row?.title || row?.role || row?.position || '').trim(),
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
      return { name: name || itemOrHandle, handle: normalizeHandle(itemOrHandle || name), title: '', description: '' };
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

async function fetchApifyDatasetItemsOnce({ token, actorId, input }) {
  const runPath = `https://api.apify.com/v2/acts/${encodeURIComponent(normalizeActorId(actorId))}/run-sync-get-dataset-items`;
  const runSyncUrl = new URL(runPath);
  runSyncUrl.searchParams.set('token', token);
  runSyncUrl.searchParams.set('clean', 'true');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000); // 10 minutes
  let response;
  try {
    response = await fetch(runSyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input || {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

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

async function fetchApifyDatasetItems(params) {
  return withRetry(() => fetchApifyDatasetItemsOnce(params), { label: 'Apify fetch', retries: 3, baseDelayMs: 3000 });
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
    .join(' \n ');
}

function isAiRelatedItem(item) {
  const text = extractTextFromItem(item);
  if (!text) return false;
  const lower = text.toLowerCase();

  // Chinese keywords — any single match is a strong signal
  const cnStrong = ['人工智能', '大模型', '智能体', '机器学习', '深度学习', '神经网络'];
  if (cnStrong.some((k) => lower.includes(k))) return true;

  // Chinese weak — need context (e.g. "推理" alone could mean logical reasoning in non-AI context)
  const cnWeak = ['推理', '算力', '芯片', '训练'];

  // English strong — brand names / acronyms that unambiguously mean AI
  const enStrong = [
    'openai', 'anthropic', 'deepmind', 'midjourney', 'hugging face', 'huggingface',
    'llm', 'gpt', 'chatgpt', 'gemini', 'claude', 'llama', 'mistral', 'copilot',
    'artificial intelligence', 'machine learning', 'deep learning', 'neural network',
    'transformer', 'diffusion model', 'foundation model', 'large language model',
    'grok', 'xai', 'deepseek', 'qwen', 'cursor', 'windsurf', 'devin', 'sora',
    'stable diffusion', 'perplexity', 'cohere', 'inflection', 'character.ai',
  ];

  // English weak — common words that only indicate AI when combined with other signals
  const enWeak = [
    'ai', 'model', 'agent', 'training', 'inference', 'robot', 'nvidia',
    'gpu', 'chip', 'fine-tune', 'finetune', 'benchmark', 'reasoning',
    'embedding', 'token', 'prompt', 'rlhf', 'alignment',
  ];

  // Strong English: any single hit is enough
  if (enStrong.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))) return true;

  // Weak scoring: accumulate hits, threshold = 1
  let weakHits = 0;
  for (const k of cnWeak) { if (lower.includes(k)) weakHits += 1; }
  for (const k of enWeak) {
    if (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) weakHits += 1;
  }
  return weakHits >= 1;
}

const HOTSPOT_RULES = [
  { label: '模型与推理能力', enKws: ['model', 'llm', 'inference', 'gpt', 'gemini', 'claude', 'llama', 'mistral', 'reasoning', 'benchmark'], cnKws: ['大模型', '推理', '模型'] },
  { label: 'Agent与自动化', enKws: ['agent', 'workflow', 'automation', 'mcp', 'tool use', 'function calling'], cnKws: ['智能体', '自动化', 'Agent'] },
  { label: '算力与芯片', enKws: ['nvidia', 'gpu', 'chip', 'tpu', 'compute', 'hardware'], cnKws: ['算力', '芯片'] },
  { label: '机器人与具身智能', enKws: ['robot', 'humanoid', 'optimus', 'embodied'], cnKws: ['机器人', '具身'] },
  { label: '产品发布与商业化', enKws: ['launch', 'release', 'pricing', 'funding', 'startup', 'revenue', 'monetize'], cnKws: ['融资', '发布', '定价', '商业化', '上线'] },
  { label: '开发工具与编程', enKws: ['coding', 'copilot', 'cursor', 'ide', 'vscode', 'developer', 'api', 'sdk', 'devtool'], cnKws: ['编程', '开发工具', '代码'] },
  { label: '开源与社区', enKws: ['open source', 'opensource', 'github', 'huggingface', 'community', 'weights'], cnKws: ['开源', '社区', '权重'] },
  { label: '多模态与视觉', enKws: ['multimodal', 'vision', 'image', 'video', 'diffusion', 'sora', 'text-to', 'ocr'], cnKws: ['多模态', '视觉', '图像', '视频'] },
  { label: '安全与治理', enKws: ['safety', 'alignment', 'regulation', 'governance', 'policy', 'ethics', 'risk'], cnKws: ['安全', '对齐', '监管', '治理'] },
];

function classifyHotspots(text) {
  const lower = String(text || '').toLowerCase();
  const matched = HOTSPOT_RULES
    .filter((rule) => {
      if (rule.cnKws.some((k) => lower.includes(k))) return true;
      return rule.enKws.some((k) => new RegExp(`\\b${k}\\b`).test(lower));
    })
    .map((rule) => rule.label);
  return matched.length > 0 ? matched : ['其他AI动态'];
}

// Single-label wrapper for backwards compatibility where only one label is needed
function classifyHotspot(text) {
  return classifyHotspots(text)[0];
}

const getHotspotStats = (items) => {
  const topicMap = new Map();
  const groupedSignals = new Set();

  for (const item of items) {
    const labels = classifyHotspots(extractTextFromItem(item));
    const handle = normalizeHandle(extractHandleFromItem(item)) || 'unknown';
    const threadKey = getItemThreadKey(item);

    for (const label of labels) {
      const signalKey = `${label}::${handle}::${threadKey}`;

      if (!topicMap.has(label)) {
        topicMap.set(label, { participants: new Set(), interactionGroups: new Set(), rawCount: 0 });
      }
      const topicEntry = topicMap.get(label);
      topicEntry.rawCount += 1;
      topicEntry.participants.add(handle);
      topicEntry.interactionGroups.add(`${handle}::${threadKey}`);

      groupedSignals.add(signalKey);
    }
  }

  const hotspots = Array.from(topicMap.entries())
    .map(([label, entry]) => ({
      label,
      participantCount: entry.participants.size,
      participants: Array.from(entry.participants),
      interactionGroupCount: entry.interactionGroups.size,
      count: entry.rawCount,
    }))
    .sort((a, b) => {
      if (b.participantCount !== a.participantCount) return b.participantCount - a.participantCount;
      if (b.interactionGroupCount !== a.interactionGroupCount) return b.interactionGroupCount - a.interactionGroupCount;
      return b.count - a.count;
    });

  const stats = {
    actionCount: items.length,
    groupedSignalCount: groupedSignals.size,
    hotspotCount: hotspots.length,
    hotspots,
  };
  return stats;
};

function getItemThreadKey(item) {
  const candidates = [
    item?.conversationId,
    item?.conversation_id,
    item?.inReplyToStatusId,
    item?.inReplyToStatusIdStr,
    item?.quotedStatusId,
    item?.quotedStatusIdStr,
    item?.retweetedStatusId,
    item?.retweetedStatusIdStr,
    item?.id,
    item?.id_str,
    item?.tweetId,
  ].filter(Boolean).map((v) => String(v).trim());

  const referenced = Array.isArray(item?.referencedTweets)
    ? item.referencedTweets.map((ref) => ref?.id).filter(Boolean).map((v) => String(v).trim())
    : [];

  const key = [...candidates, ...referenced].find(Boolean);
  if (key) return key;

  const text = extractTextFromItem(item).replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 80) : 'unknown-thread';
}

function buildPromptItems(items) {
  // Two-pass dedup:
  // 1. Per handle+thread (original dedup for multi-label items)
  // 2. Per handle+topic — keep only the longest/most informative item per person per topic
  //    so that one person posting 5 threads about the same topic only appears once

  // Pass 1: thread-level dedup
  const threadDeduped = new Map();
  for (const item of items) {
    const handle = normalizeHandle(extractHandleFromItem(item)) || 'unknown';
    const threadKey = getItemThreadKey(item);
    const key = `${handle}::${threadKey}`;
    if (!threadDeduped.has(key)) threadDeduped.set(key, item);
  }

  // Pass 2: per person + topic dedup — keep the item with the longest text
  const topicDeduped = new Map();
  for (const item of threadDeduped.values()) {
    const handle = normalizeHandle(extractHandleFromItem(item)) || 'unknown';
    const text = extractTextFromItem(item);
    const labels = classifyHotspots(text);
    const primaryLabel = labels[0] || 'other';
    const key = `${handle}::${primaryLabel}`;

    if (!topicDeduped.has(key) || text.length > extractTextFromItem(topicDeduped.get(key)).length) {
      topicDeduped.set(key, item);
    }
  }

  return Array.from(topicDeduped.values());
}


const rankPeople = (items, roster) => {
  const counts = items.reduce((map, item) => {
    const handle = extractHandleFromItem(item);
    return handle ? (map.set(handle, (map.get(handle) || 0) + 1), map) : map;
  }, new Map());

  const meta = new Map(roster.map((r) => [normalizeHandle(r.handle), { name: r.name || r.handle, title: r.title || '', description: r.description || '' }]));
  const ranked = Array.from(counts.entries())
    .map(([handle, outputCount]) => ({
      name: (meta.get(handle)?.name) || handle,
      title: (meta.get(handle)?.title) || '',
      description: (meta.get(handle)?.description) || '',
      handle,
      outputCount,
    }))
    .sort((a, b) => b.outputCount - a.outputCount);

  return ranked;
};


async function writeWeeklyCountsTable(ranking) {
  const header = '| 排名 | 本名 | X账号 | 近一周动态数量 |\n|---:|---|---|---:|';
  const rows = ranking.map((p, i) => `| ${i + 1} | ${p.name} | @${p.handle} | ${p.outputCount} |`);
  const markdown = `${header}\n${rows.join('\n')}\n`;
  const csvHeader = 'rank,name,handle,weekly_output_count';
  const csvRows = ranking.map((p, i) => `${i + 1},"${String(p.name).replaceAll('"', '""')}",${p.handle},${p.outputCount}`);
  const csv = `${csvHeader}\n${csvRows.join('\n')}\n`;

  const artifactsDir = 'artifacts';
  await fs.mkdir(artifactsDir, { recursive: true });
  const artifactMarkdownPath = `${artifactsDir}/ai-weekly-output-counts.md`;
  const artifactCsvPath = `${artifactsDir}/ai-weekly-output-counts.csv`;

  await fs.writeFile(artifactMarkdownPath, markdown, 'utf8');
  await fs.writeFile(artifactCsvPath, csv, 'utf8');

  return { artifactMarkdownPath, artifactCsvPath };
}


function getDailyPeopleStats(items) {
  const stats = new Map();
  for (const item of items) {
    const handle = normalizeHandle(extractHandleFromItem(item));
    if (!handle) continue;
    if (!stats.has(handle)) stats.set(handle, { actionCount: 0, hotspots: new Set() });
    const entry = stats.get(handle);
    entry.actionCount += 1;
    for (const label of classifyHotspots(extractTextFromItem(item))) {
      entry.hotspots.add(label);
    }
  }
  return stats;
}

const PEOPLE_PROFILE_MAP = {
  elonmusk: { title: 'xAI创始人', bio: 'AI与算力叙事核心人物' },
  sama: { title: 'OpenAI联合创始人', bio: 'OpenAI产品与战略核心' },
  karpathy: { title: 'Eureka Labs创始人', bio: 'AI教育与工程化代表' },
  ylecun: { title: 'Meta首席AI科学家', bio: '深度学习研究风向标' },
  demishassabis: { title: 'Google DeepMind CEO', bio: '谷歌AI战略中枢' },
  drjimfan: { title: 'NVIDIA高级研究员', bio: '机器人与具身智能前沿' },
  andrewyng: { title: 'LandingAI创始人', bio: 'AI应用化推动者' },
  drfeifei: { title: '斯坦福教授', bio: '视觉AI研究代表人物' },
  ilyasut: { title: 'Safe Superintelligence联合创始人', bio: '新一代AI安全与能力路线' },
  fchollet: { title: 'Google AI研究员', bio: 'Keras之父，模型评估观点鲜明' },
  geoffreyhinton: { title: '图灵奖得主', bio: '深度学习奠基者之一' },
  mustafasuleyman: { title: 'Microsoft AI CEO', bio: '消费级AI产品商业化负责人' },
  gdb: { title: 'OpenAI产品负责人', bio: '产品化与开发者生态关键人物' },
  darioamodei: { title: 'Anthropic CEO', bio: 'Claude路线与AI安全代表' },
  aravsrinivas: { title: 'Perplexity CEO', bio: 'AI搜索产品化代表' },
  arthurmensch: { title: 'Mistral AI CEO', bio: '欧洲大模型创业代表' },
  alexandr_wang: { title: 'Scale AI CEO', bio: '数据基础设施与企业AI代表' },
  billgates: { title: '微软联合创始人', bio: '长期科技趋势观察者' },
};

function appendTop20Appendix(markdown, top20, peopleStats) {
  const rows = top20
    .map((p) => {
      const profile = PEOPLE_PROFILE_MAP[normalizeHandle(p.handle)] || {};
      const title = p.title || profile.title || 'AI从业者';
      const bio = p.description || profile.bio || '持续活跃于AI一线动态';
      const stat = peopleStats?.get(normalizeHandle(p.handle));
      const actionCount = stat?.actionCount || 0;
      const hotspotCount = stat?.hotspots?.size || 0;
      return `${p.name}（@${p.handle}）| ${title}：${bio} | 今日action数量：${actionCount}，涉及到${hotspotCount}个热点`;
    })
    .join('\n');

  return `${markdown.trim()}\n\n## TOP20活跃人物\n\n${rows}\n`;
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
    return realName ? `[@${realName}](${url})` : handle ? `[@${handle}](${url})` : `[@来源](${url})`;
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
    console.warn('Warning: OpenAI output missing "Today\'s Summary" section, appending generic fallback.');
    text += "\n\n## Today's Summary\n\n今日高热度集中在AI能力落地与产品化推进，头部公司密集发布与资本动作叠加放大了市场关注，建议管理层优先布局组织级部署、成本治理与执行效率。";
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
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n').map((l) => l.trim());

  const titleLine = lines.find((l) => /^#\s+/.test(l));
  const reportTitle = titleLine ? titleLine.replace(/^#\s+/, '') : 'AI Pulse - X Daily Brief';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

  const summaryHeaderIdx = lines.findIndex((l) => /^##\s+/.test(l) && /today'?s\s*summary|executive\s*summary|今日总结|总结/i.test(l));
  let summaryLines = [];
  let summaryEndIdx = -1;
  if (summaryHeaderIdx >= 0) {
    summaryEndIdx = lines.length;
    for (let i = summaryHeaderIdx + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^##\s+/.test(line)) {
        summaryEndIdx = i;
        break;
      }
      if (line) summaryLines.push(line.replace(/^[○■*-]\s+/, ''));
    }
  }

  const contentLines = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (/^#\s+/.test(line)) continue;
    if (summaryHeaderIdx >= 0 && i >= summaryHeaderIdx && (summaryEndIdx < 0 || i < summaryEndIdx)) continue;
    contentLines.push(line);
  }

  const events = [];
  let currentEvent = null;
  const topSectionNotes = [];
  const appendixLines = [];
  let inAppendix = false;
  // Track ## section headers from OpenAI output to preserve its topic grouping
  let currentSectionTitle = '';

  for (const line of contentLines) {
    if (/^##\s*TOP20活跃人物/i.test(line)) {
      if (currentEvent) {
        events.push(currentEvent);
        currentEvent = null;
      }
      inAppendix = true;
      continue;
    }

    if (inAppendix) {
      appendixLines.push(line.replace(/^[○■*-]\s+/, ''));
      continue;
    }

    // Detect ## section headers (e.g. "## 二、中热度话题" or "## Topic: Agent与自动化")
    const sectionMatch = line.match(/^##\s+(.+)/);
    if (sectionMatch) {
      if (currentEvent) {
        events.push(currentEvent);
        currentEvent = null;
      }
      currentSectionTitle = sectionMatch[1].replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, '').trim();
      continue;
    }

    // Detect ### sub-section headers (e.g. "### 开发工具与Agent工作流优化")
    // OpenAI sometimes uses ### for mid-heat topic groups under a ## parent section
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match) {
      if (currentEvent) {
        events.push(currentEvent);
        currentEvent = null;
      }
      currentSectionTitle = h3Match[1].replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, '').trim();
      continue;
    }

    const ordered = line.match(/^(\d+)\.\s+(.+)/);
    // Also match bold standalone titles like "**事件标题**" (LLM sometimes uses this instead of numbered lists)
    const boldTitle = !ordered && line.match(/^\*\*([^*]+)\*\*\s*$/);
    if (ordered || boldTitle) {
      const candidateTitle = ordered ? ordered[2] : boldTitle[1];
      // If this numbered item is actually "Today's Summary" / "今日总结", treat it as
      // the start of the summary section rather than an event item.
      if (/today'?s\s*summary|今日总结|executive\s*summary/i.test(candidateTitle)) {
        if (currentEvent) { events.push(currentEvent); currentEvent = null; }
        // Collect remaining lines as summary until end or next ## section
        let k = contentLines.indexOf(line) + 1;
        while (k < contentLines.length && !/^##\s+/.test(contentLines[k])) {
          const sl = contentLines[k].replace(/^[○■*-]\s+/, '').trim();
          if (sl) summaryLines.push(sl);
          k++;
        }
        break; // stop main loop; everything after is summary/appendix
      }
      if (currentEvent) events.push(currentEvent);
      currentEvent = {
        index: ordered ? Number(ordered[1]) : events.length + 1,
        title: candidateTitle,
        analysis: [],
        why: '',
        actions: [],
        sources: [],
        sectionTitle: currentSectionTitle,
      };
      continue;
    }

    // If no current event but we have a section title and content, auto-create an
    // implicit event so that un-numbered content under ### sections is captured
    // instead of falling through to topSectionNotes.
    if (!currentEvent && currentSectionTitle) {
      const probe = line.replace(/^[○■*-]\s+/, '').replace(/\*\*/g, '').trim();
      const isProbeNoise = !probe
        || /^(---+|___+|\*\*\*+)$/.test(probe)
        || /^#{1,6}\s+/.test(probe)
        || /^相关动态[:：]?$/.test(probe)
        || /^热点解析[:：]?$/.test(probe);
      if (!isProbeNoise) {
        currentEvent = {
          index: events.length + 1,
          title: currentSectionTitle,
          analysis: [],
          why: '',
          actions: [],
          sources: [],
          sectionTitle: currentSectionTitle,
        };
      }
    }

    if (currentEvent) {
      const normalized = line.replace(/^[○■*-]\s+/, '').trim();
      const plain = normalized.replace(/\*\*/g, '').trim();

      // Skip participant count lines (e.g. "参与人数：4人", "*参与人数：4人*")
      if (/参与人数|participantCount/i.test(plain)) continue;

      if (/热点解析[:：]/.test(plain)) {
        const value = plain.replace(/^热点解析[:：]\s*/, '').trim();
        if (value) currentEvent.analysis.push(value);
      } else if (/why it matters|管理层意义|业务影响|重要性/i.test(plain)) {
        const value = plain.replace(/^([^:：]+)[:：]\s*/, '').trim();
        if (value) currentEvent.why = value;
      } else if (/相关动态[:：]/.test(plain)) {
        const value = plain.replace(/^相关动态[:：]\s*/, '').trim();
        if (value) currentEvent.actions.push(value);
      } else if (/^@/.test(plain) || /https?:\/\//.test(plain)) {
        currentEvent.sources.push(plain);
      } else if (plain) {
        const isNoise = /^(---+|___+|\*\*\*+)$/.test(plain)
          || /^#{1,6}\s+/.test(plain)
          || /^相关动态[:：]?$/.test(plain)
          || /^热点解析[:：]?$/.test(plain);
        if (!isNoise) currentEvent.actions.push(plain);
      }
    } else if (!/^##\s+/.test(line)) {
      topSectionNotes.push(line.replace(/^[○■*-]\s+/, ''));
    }
  }
  if (currentEvent) events.push(currentEvent);

  const top3 = events.slice(0, 3);
  const secondary = events.slice(3);

  // Group secondary events by OpenAI's own ## section titles instead of re-classifying
  const grouped = new Map();
  for (const evt of secondary) {
    const topic = evt.sectionTitle || '其他动态';
    if (!grouped.has(topic)) grouped.set(topic, []);
    grouped.get(topic).push(evt);
  }
  const secondaryTopics = Array.from(grouped.entries())
    .map(([title, items]) => ({ title, items }))
    .filter((t) => t.items.length > 0)
    .slice(0, 4);

  const sectionTitle = (textValue) => `<h2 style="font-size:24px;line-height:1.35;margin:0;color:#111827;font-weight:700;">${formatInlineMarkdown(textValue)}</h2>`;

  const renderSectionBlock = (label, title, content) => `
    <div style="border:1px solid #E5E7EB;border-radius:12px;background:#FFFFFF;padding:16px 16px 10px 16px;margin:0 0 14px 0;">
      <div style="font-size:13px;line-height:1.4;font-weight:700;letter-spacing:0.6px;color:#2563EB;text-transform:uppercase;margin:0 0 6px 0;">${formatInlineMarkdown(label)}</div>
      <div style="margin:0 0 12px 0;">${sectionTitle(title)}</div>
      ${content}
    </div>
  `;

  const renderSourceTags = (items) => {
    if (!items || items.length === 0) return '';
    const tags = items.slice(0, 6).map((item) => `<span style="display:inline-block;margin:0 8px 8px 0;padding:6px 12px;border:1px solid #E5E7EB;border-radius:999px;background:#F8FAFC;font-size:14px;line-height:1.5;font-weight:500;color:#4B5563;">${formatInlineMarkdown(item)}</span>`).join('');
    return `<div style="margin-top:10px;">${tags}</div>`;
  };

  const renderEventCard = (event) => {
    const analysisText = event.analysis.join(' ').trim();
    const actions = event.actions.slice(0, 5).map((a) => `<li style="margin:0 0 8px 0;color:#111827;font-size:17px;line-height:1.78;">${formatInlineMarkdown(a)}</li>`).join('');
    return `
      <div style="margin:0 0 16px 0;padding:18px 20px;border:1px solid #E5E7EB;border-radius:12px;background:#FFFFFF;box-shadow:0 2px 8px rgba(17,24,39,0.05);">
        <div style="font-size:14px;color:#4B5563;font-weight:700;letter-spacing:0.4px;margin-bottom:10px;">HOT EVENT ${event.index}</div>
        <div style="font-size:20px;line-height:1.45;color:#111827;font-weight:700;margin-bottom:10px;">${formatInlineMarkdown(event.title)}</div>
        <div style="font-size:17px;line-height:1.8;color:#111827;margin-bottom:12px;"><span style="font-size:16px;font-weight:700;">热点解析：</span>${formatInlineMarkdown(analysisText || '今日核心动态持续演进，建议关注执行节奏与信号变化。')}</div>
        ${actions ? `<div style="font-size:16px;font-weight:700;color:#111827;margin:0 0 6px 0;">相关动态：</div><ul style="margin:0;padding-left:20px;">${actions}</ul>` : ''}
        ${renderSourceTags(event.sources)}
      </div>
    `;
  };

  const renderSecondaryTopicGroup = (topic, idx) => {
    const topicItems = topic.items.slice(0, 4).map((event, j) => {
      const dynamicText = (event.actions[0] || event.analysis[0] || event.title || '').trim();
      const sourceLink = (event.sources && event.sources.length > 0) ? event.sources[0] : '';
      const composed = sourceLink && !dynamicText.includes('http') ? `${dynamicText} ${sourceLink}`.trim() : dynamicText;
      return `<div style="margin:0 0 10px 0;padding:10px 12px;border:1px solid #E5E7EB;border-radius:8px;background:#FFFFFF;">
        <div style="font-size:16px;font-weight:700;line-height:1.55;color:#111827;margin-bottom:4px;">动态${j + 1}：${formatInlineMarkdown(event.title)}</div>
        <div style="font-size:16px;line-height:1.68;color:#4B5563;">${formatInlineMarkdown(composed)}</div>
      </div>`;
    }).join('');

    return `
      <div style="display:block;width:100%;margin:0 0 14px 0;padding:14px;border:1px solid #E5E7EB;border-radius:10px;background:#F8FAFC;box-sizing:border-box;">
        <div style="font-size:20px;line-height:1.45;color:#111827;font-weight:700;margin-bottom:10px;">热点${idx + 1}：${formatInlineMarkdown(topic.title)}</div>
        ${topicItems}
      </div>
    `;
  };


  const executiveSummary = summaryLines.length > 0
    ? summaryLines.map((t) => t.replace(/^[-•]\s*/, '').replace(/^[^：:]+[：:]\s*/, '')).join('；')
    : `今日高热度集中在AI产品化推进与模型能力迭代，主要关注方向为Top 3热点与中热度主题演进，监测范围覆盖Top20 active AI voices in the last 24h，对管理层的意义在于优化资源投放效率并把握竞争窗口。`;

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F5F7FA;padding:28px 0;margin:0;">
  <tr>
    <td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="720" style="width:720px;max-width:720px;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;">
        <tr>
          <td style="background:#111827;padding:24px 28px;">
            <div style="font-size:34px;line-height:1.25;font-weight:700;color:#ffffff;">${formatInlineMarkdown(reportTitle)}</div>
            <div style="margin-top:8px;font-size:13px;line-height:1.5;color:#d1d5db;">${today} · Auto-generated executive intelligence brief</div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px 6px 24px;">
            ${renderSectionBlock('Key Section', 'Top 3 Hot Events', top3.length > 0 ? top3.map(renderEventCard).join('') : '<div style="font-size:16px;color:#4b5563;padding:12px 0;line-height:1.7;">今日暂无可用热点事件。</div>')}
          </td>
        </tr>
        <tr>
          <td style="padding:0 24px 6px 24px;">
            ${renderSectionBlock('Key Section', 'Secondary Topics', secondaryTopics.length > 0 ? secondaryTopics.map((topic, i) => renderSecondaryTopicGroup(topic, i)).join('') : '<div style="font-size:16px;color:#4B5563;line-height:1.7;">今日中热度主题较少，建议持续观察明日信号。</div>')}
          </td>
        </tr>
        <tr>
          <td style="padding:0 24px 6px 24px;">
            ${renderSectionBlock('Summary', 'Executive Summary', `<div style="border:1px solid #d1d5db;border-left:4px solid #111827;border-radius:8px;background:#f9fafb;padding:14px 14px 12px 14px;"><div style="font-size:17px;line-height:1.8;color:#111827;">${formatInlineMarkdown(executiveSummary)}</div></div>`)}
          </td>
        </tr>
        ${appendixLines.length > 0 ? `<tr><td style="padding:0 24px 6px 24px;">${renderSectionBlock('Ranking', 'TOP20活跃人物', `<div style="font-size:15px;color:#4b5563;line-height:1.75;">${appendixLines.map((n) => `<div style="margin:0 0 6px 0;">${formatInlineMarkdown(n)}</div>`).join('')}</div>`)}</td></tr>` : ''}
        ${topSectionNotes.length > 0 ? `<tr><td style="padding:0 24px 12px 24px;"><div style="border:1px solid #E5E7EB;border-radius:12px;background:#FFFFFF;padding:12px 14px;"><div style="font-size:14px;color:#4b5563;line-height:1.7;">${topSectionNotes.map((n) => `<div style="margin:0 0 6px 0;">${formatInlineMarkdown(n)}</div>`).join('')}</div></div></td></tr>` : ''}
        <tr>
          <td style="padding:10px 24px 20px 24px;border-top:1px solid #e5e7eb;">
            <div style="font-size:13px;color:#6b7280;line-height:1.65;">This brief is generated for management quick-read. Source links are embedded in each event card for direct verification and follow-up.</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}


function getPromptTemplate() {
  return process.env.REPORT_PROMPT_TEMPLATE || `你是一个专业的AI行业分析师和情报Agent。
请根据提供的数据生成日报。

# AI Pulse - X Daily Brief

## 排名核心规则（必须遵守）
- **热度排名唯一标准是”参与人数”（participantCount）**，即有多少个不同的人讨论了这个话题
- 同一个人发多条推文/引用/回复，只算1个参与者
- 统计数据中的 participants 数组列出了每个话题的所有唯一参与者，请严格按此排序
- 仅在参与人数完全相同时，再参考 interactionGroupCount 和 count
- **输出中不要显示参与人数、participantCount 等统计数字，只用于排序**

## 输出格式（严格遵守）

### TOP3热度事件
用 ## 标题 + 编号列表输出，严格按 participantCount 排序（数据中已排好序）：

\`\`\`
## TOP3 热度事件

1. 事件标题A
   - **热点解析：** …
   - **相关动态：**
     - [@本名](url): 动态描述…
     - [@本名](url): 动态描述…

2. 事件标题B
   …

3. 事件标题C
   …
\`\`\`

### 中热度事件
用 ### 作为Topic标题，每个Topic下用编号列表输出事件，共输出7-12条事件，分成2-4个Topic。
**每个Topic内的事件也必须严格按 participantCount 从高到低排列**（数据中已按此顺序排好）：

\`\`\`
## 中热度话题

### Topic标题A
1. 事件标题X
   - **热点解析：** …
   - **相关动态：**
     - [@本名](url): 动态描述…

2. 事件标题Y
   …

### Topic标题B
1. 事件标题Z
   …
\`\`\`

### 通用规则
- 不需要按传统行业大类分类
- **关键约束：同一事件内，每个账号（@handle）最多只能出现1次。** 数据已按每人每话题去重，每条数据代表一个不同的人的观点，请全部使用，不要重复引用同一人
- 不要输出”聚类一/二/三”字样；不要输出”额外观察”与”AI大厂与投资机构资讯”板块
- 关联动态中的来源链接，不使用”查看原帖”，统一写成 [@本名](url)（本名不是X用户名）
- 文末新增 Today's Summary 板块，**必须用 ## Today's Summary 作为独立的二级标题**，内容用一个自然段完成（不分点，不超过200字）；**不得将 Today's Summary 作为编号列表中的一项**
- 输出Markdown，结构清晰，分级列表明确
`;
}

async function requestGeminiReportOnce({ apiKey, model, prompt }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3 * 60 * 1000); // 3 minutes
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2),
          maxOutputTokens: 8192,
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) throw new Error(`Gemini request failed: ${response.status} ${await response.text()}`);
  const json = await response.json();
  const text = (json?.candidates || [])
    .flatMap((c) => (c?.content?.parts || []).map((p) => p?.text).filter(Boolean))
    .join('\n')
    .trim();

  if (!text) throw new Error('Gemini returned empty textual output.');
  return text;
}

async function requestGeminiReport(params) {
  return withRetry(() => requestGeminiReportOnce(params), { label: 'Gemini report', retries: 2, baseDelayMs: 5000 });
}

async function runApify(input) {
  const token = normalizeApifyToken(requireEnv('APIFY_TOKEN'));
  const actorId = requireEnv('APIFY_ACTOR_ID');
  const items = await fetchApifyDatasetItems({ token, actorId, input });
  return { items, runData: { id: normalizeActorId(actorId), status: 'SUCCEEDED' }, datasetId: 'run-sync-output' };
}

// Split handles into batches and run Apify calls concurrently for faster fetching
async function runApifyBatched(templateInput, handles, since, until, { batchSize = 25, concurrency = 3, maxItems = 1000 } = {}) {
  const batches = [];
  for (let i = 0; i < handles.length; i += batchSize) {
    batches.push(handles.slice(i, i + batchSize));
  }

  console.log(`Splitting ${handles.length} handles into ${batches.length} batches (size=${batchSize}, concurrency=${concurrency})`);
  const allItems = [];
  // Process ALL batches with limited concurrency (not capped at concurrency total)
  for (let i = 0; i < batches.length; i += concurrency) {
    const chunk = batches.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map((batchHandles) => {
        const input = buildApifyInput(templateInput, batchHandles, since, until, maxItems);
        return runApify(input).then((r) => r.items).catch((err) => {
          console.error(`Apify batch failed (${batchHandles.length} handles): ${err.message}`);
          return []; // Don't let one batch failure kill the whole run
        });
      }),
    );
    for (const items of results) allItems.push(...items);
    if (i + concurrency < batches.length) {
      console.log(`Apify batch progress: ${Math.min(i + concurrency, batches.length)}/${batches.length} batches done`);
    }
  }

  console.log(`Apify batched fetch complete: ${batches.length} batches, ${allItems.length} total items`);
  return allItems;
}

async function generateReport(items, top20, stats, peopleStats) {
  if (!Array.isArray(items) || items.length === 0) {
    return `# AI Pulse - X Daily Brief\n\n今日无可用AI相关内容。\n`;
  }

  const apiKey = requireEnv('GEMINI_API_KEY');
  const model = requireEnv('GEMINI_MODEL');
  console.log(`Using GEMINI_MODEL=${model}`);

  const promptItems = buildPromptItems(items);
  // Extract only the fields OpenAI needs to reduce token usage
  const compactItems = promptItems.map((item) => {
    const handle = extractHandleFromItem(item);
    const text = extractTextFromItem(item);
    const url = item?.url || item?.tweetUrl || item?.link || '';
    const createdAt = item?.createdAt || item?.created_at || item?.date || '';
    const compact = { handle, text: text.slice(0, 500) };
    if (url) compact.url = url;
    if (createdAt) compact.date = typeof createdAt === 'string' ? createdAt.slice(0, 19) : createdAt;
    return compact;
  });
  const prompt = `${getPromptTemplate()}\n\n话题统计（已按participantCount降序排列，participants列出每个话题的唯一参与者）：\n${JSON.stringify(stats, null, 2)}\n\n去重后的参与样本（每人每话题仅保留1条最具代表性的内容，共${compactItems.length}条）：\n${JSON.stringify(compactItems, null, 2)}`;
  const markdown = await requestGeminiReport({ apiKey, model, prompt });
  const normalized = normalizeMarkdownLayout(markdown);
  const withRealNameLinks = relabelSourceLinksWithRealNames(normalized, top20);
  return appendTop20Appendix(withRealNameLinks, top20, peopleStats);
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

  const rosterHandles = roster.map((p) => p.handle);
  console.log(`Fetching weekly data for ${rosterHandles.length} people (${weekAgo} ~ ${today})...`);
  console.log(`Example weekly searchTerm: from:${roster[0].handle} since:${weekAgo} until:${today}`);
  // Use batched concurrent calls for large roster to speed up fetching
  const weeklyItems = rosterHandles.length > 30
    ? await runApifyBatched(templateInput, rosterHandles, weekAgo, today)
    : (await runApify(buildApifyInput(templateInput, rosterHandles, weekAgo, today, 1000))).items;
  console.log(`Weekly items: ${weeklyItems.length}`);

  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile('artifacts/all-outputs.json', JSON.stringify(weeklyItems, null, 2), 'utf8');

  const ranking = rankPeople(weeklyItems, roster);
  const top20 = ranking.slice(0, 20);
  await fs.writeFile('artifacts/top20-ranking.json', JSON.stringify(top20, null, 2), 'utf8');

  const tablePaths = await writeWeeklyCountsTable(ranking);
  console.log(`Weekly output table saved: ${tablePaths.artifactMarkdownPath}, ${tablePaths.artifactCsvPath}`);

  // NOTE: Twitter since/until uses UTC dates, but we generate BJT dates.
  // This causes ~8h offset: some older tweets included, some recent ones missed.
  // For better precision, filter by item.createdAt timestamp after fetching.
  const dailyInput = buildApifyInput(templateInput, top20.map((p) => p.handle), yesterday, today, 1000);
  if (top20.length > 0) console.log(`Example daily searchTerm: from:${top20[0].handle} since:${yesterday} until:${today}`);
  const daily = await runApify(dailyInput);
  const aiRelatedDaily = daily.items.filter(isAiRelatedItem);
  console.log(`Daily items: ${daily.items.length}, AI-related: ${aiRelatedDaily.length}`);
  const hotspotStats = getHotspotStats(aiRelatedDaily);
  const dailyPeopleStats = getDailyPeopleStats(aiRelatedDaily);

  const report = await generateReport(aiRelatedDaily, top20, hotspotStats, dailyPeopleStats);
  await fs.writeFile('artifacts/daily-report.md', report, 'utf8');

  await sendEmail(report);
  console.log('Daily report generated and emailed successfully.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
