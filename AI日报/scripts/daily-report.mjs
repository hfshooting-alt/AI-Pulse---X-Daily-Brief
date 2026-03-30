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

async function fetchJsonWithRetry(url, { label, timeoutMs = 60_000 } = {}) {
  return withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      const text = await response.text();
      if (!response.ok) throw new Error(`${label || 'request'} failed: ${response.status} ${text.slice(0, 500)}`);
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timeout);
    }
  }, { label: label || 'HTTP JSON fetch', retries: 2, baseDelayMs: 2000 });
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function normalizeApifyInputForFingerprint(input) {
  const clone = input && typeof input === 'object' ? { ...input } : {};
  // searchTerms order shouldn't affect cache hit
  if (Array.isArray(clone.searchTerms)) {
    clone.searchTerms = clone.searchTerms.map((v) => String(v).trim()).filter(Boolean).sort();
  }
  return clone;
}

function getInputFingerprint(input) {
  return stableStringify(normalizeApifyInputForFingerprint(input));
}

async function fetchRunInput({ token, runId }) {
  const url = new URL(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}/key-value-store/records/INPUT`);
  url.searchParams.set('token', token);
  return fetchJsonWithRetry(url, { label: `Apify run INPUT ${runId}` });
}

async function fetchDatasetItemsById({ token, datasetId }) {
  const url = new URL(`https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items`);
  url.searchParams.set('token', token);
  url.searchParams.set('clean', 'true');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`Dataset items fetch failed: ${response.status} ${body.slice(0, 500)}`);
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) throw new Error('Dataset items response is not an array.');
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function listRecentActorRuns({ token, actorId, limit = 10 }) {
  const runsUrl = new URL(`https://api.apify.com/v2/acts/${encodeURIComponent(normalizeActorId(actorId))}/runs`);
  runsUrl.searchParams.set('token', token);
  runsUrl.searchParams.set('limit', String(limit));
  runsUrl.searchParams.set('desc', '1');
  runsUrl.searchParams.set('status', 'SUCCEEDED');
  const data = await fetchJsonWithRetry(runsUrl, { label: 'Apify recent runs list' });
  return Array.isArray(data?.data?.items) ? data.data.items : [];
}

function shouldReuseRecentRuns() {
  return parseBooleanEnv(process.env.APIFY_REUSE_RECENT_RUNS, true);
}

function getRecentRunsLimit() {
  const v = Number(process.env.APIFY_REUSE_RUNS_LIMIT || 10);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 50) : 10;
}

function getReuseMaxAgeHours() {
  const v = Number(process.env.APIFY_REUSE_MAX_AGE_HOURS || 36);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 24 * 14) : 36;
}

function isRunFreshEnough(run, maxAgeHours) {
  const startedAt = run?.startedAt || run?.started_at || run?.createdAt || run?.created_at;
  if (!startedAt) return false;
  const startedAtMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedAtMs)) return false;
  const ageMs = Date.now() - startedAtMs;
  return ageMs >= 0 && ageMs <= maxAgeHours * 60 * 60 * 1000;
}

const inProcessApifyCache = new Map();

async function tryReuseRecentRun({ token, actorId, input }) {
  if (!shouldReuseRecentRuns()) return null;
  const limit = getRecentRunsLimit();
  const maxAgeHours = getReuseMaxAgeHours();
  const expectedFingerprint = getInputFingerprint(input);
  const recentRuns = await listRecentActorRuns({ token, actorId, limit });
  if (recentRuns.length === 0) return null;
  let freshRuns = 0;
  let fingerprintMatches = 0;

  for (const run of recentRuns) {
    const runId = String(run?.id || '').trim();
    const datasetId = String(run?.defaultDatasetId || run?.defaultDataset || run?.datasetId || '').trim();
    if (!runId || !datasetId) continue;
    if (!isRunFreshEnough(run, maxAgeHours)) continue;
    freshRuns += 1;
    try {
      const runInput = await fetchRunInput({ token, runId });
      const fingerprint = getInputFingerprint(runInput);
      if (fingerprint !== expectedFingerprint) continue;
      fingerprintMatches += 1;
      const items = await fetchDatasetItemsById({ token, datasetId });
      console.log(`Apify cache hit: reused run ${runId} (dataset ${datasetId}, items=${items.length})`);
      return { items, runData: run, datasetId, reused: true };
    } catch (err) {
      console.warn(`Apify reuse candidate skipped (${runId}): ${err.message}`);
    }
  }
  console.log(`Apify reuse miss: checked=${recentRuns.length}, fresh=${freshRuns}, fingerprintMatched=${fingerprintMatches}`);
  return null;
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

function extractCreatedAtFromItem(item) {
  const raw = item?.createdAt || item?.created_at || item?.date || item?.time || '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function toBjtDateString(dateObj) {
  const bjtMs = dateObj.getTime() + 8 * 60 * 60 * 1000;
  const bjt = new Date(bjtMs);
  return `${bjt.getUTCFullYear()}-${String(bjt.getUTCMonth() + 1).padStart(2, '0')}-${String(bjt.getUTCDate()).padStart(2, '0')}`;
}

function extractItemBjtDate(item) {
  const createdAt = extractCreatedAtFromItem(item);
  if (!createdAt) return '';
  const parsed = parseDateLoose(createdAt);
  if (!parsed || Number.isNaN(parsed.getTime())) return '';
  return toBjtDateString(parsed);
}

function isDateInHalfOpenRange(dateStr, startInclusive, endExclusive) {
  if (!dateStr) return false;
  return dateStr >= startInclusive && dateStr < endExclusive;
}

function getItemUniqueKey(item) {
  const id = String(item?.id || item?.id_str || item?.tweetId || '').trim();
  if (id) return `id:${id}`;
  const url = String(item?.url || item?.tweetUrl || item?.link || '').trim();
  if (url) return `url:${url}`;
  const handle = extractHandleFromItem(item) || 'unknown';
  const createdAt = extractCreatedAtFromItem(item) || 'no-date';
  const text = extractTextFromItem(item).replace(/\s+/g, ' ').trim().slice(0, 80);
  return `fallback:${handle}:${createdAt}:${text}`;
}

function mergeUniqueItems(...groups) {
  const map = new Map();
  for (const group of groups) {
    for (const item of group || []) {
      const key = getItemUniqueKey(item);
      if (!map.has(key)) map.set(key, item);
    }
  }
  return Array.from(map.values());
}

function selectDailyItemsFromWeekly({ weeklyItems, top20Handles, dailySince, dailyUntil }) {
  const handleSet = new Set(top20Handles.map((h) => normalizeHandle(h)));
  return (weeklyItems || []).filter((item) => {
    const handle = normalizeHandle(extractHandleFromItem(item));
    if (!handle || !handleSet.has(handle)) return false;
    const bjtDate = extractItemBjtDate(item);
    return isDateInHalfOpenRange(bjtDate, dailySince, dailyUntil);
  });
}

function filterItemsByBjtDateRange(items, startInclusive, endExclusive) {
  return (items || []).filter((item) => {
    const bjtDate = extractItemBjtDate(item);
    return isDateInHalfOpenRange(bjtDate, startInclusive, endExclusive);
  });
}

function shouldSkipSecondDailyFetch({ candidateItems, top20, maxMissingHandles, minItems }) {
  if (!Array.isArray(candidateItems) || candidateItems.length < minItems) return false;
  const activeHandles = new Set(candidateItems.map((item) => normalizeHandle(extractHandleFromItem(item))).filter(Boolean));
  const missing = top20.filter((p) => !activeHandles.has(normalizeHandle(p.handle))).length;
  return missing <= maxMissingHandles;
}

function getDailyAiCoverage(items) {
  const aiItems = (items || []).filter(isAiRelatedItem);
  const aiHandles = new Set(aiItems.map((item) => normalizeHandle(extractHandleFromItem(item))).filter(Boolean));
  return { aiItems, aiCount: aiItems.length, aiHandleCount: aiHandles.size };
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
  return weakHits >= 2;
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

// Simple word-overlap similarity between two texts (Jaccard on word bigrams)
function textSimilarity(textA, textB) {
  const bigrams = (t) => {
    const words = t.replace(/https?:\/\/\S+/g, '').replace(/[^\w\u4e00-\u9fff]+/g, ' ').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const bg = new Set();
    for (let i = 0; i < words.length - 1; i++) bg.add(`${words[i]} ${words[i + 1]}`);
    return bg;
  };
  const a = bigrams(textA);
  const b = bigrams(textB);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function buildPromptItems(items) {
  // Two-pass dedup:
  // 1. Per handle+thread — collapse multi-tweet threads from same person
  // 2. Per handle text-similarity — only dedup near-duplicate texts from same person
  //    (NOT per broad category, so distinct events from same person are preserved)

  // Pass 1: thread-level dedup
  const threadDeduped = new Map();
  for (const item of items) {
    const handle = normalizeHandle(extractHandleFromItem(item)) || 'unknown';
    const threadKey = getItemThreadKey(item);
    const key = `${handle}::${threadKey}`;
    if (!threadDeduped.has(key)) threadDeduped.set(key, item);
  }

  // Pass 2: per-person text-similarity dedup — remove near-duplicate content
  // from the same person (similarity > 0.5), but keep distinct events even if
  // they share the same broad topic category.
  const SIMILARITY_THRESHOLD = 0.5;
  const perPerson = new Map();
  for (const item of threadDeduped.values()) {
    const handle = normalizeHandle(extractHandleFromItem(item)) || 'unknown';
    if (!perPerson.has(handle)) perPerson.set(handle, []);
    perPerson.get(handle).push(item);
  }

  const result = [];
  for (const personItems of perPerson.values()) {
    // Sort by text length descending — keep longer (more informative) items first
    personItems.sort((a, b) => extractTextFromItem(b).length - extractTextFromItem(a).length);
    const kept = [];
    for (const item of personItems) {
      const text = extractTextFromItem(item);
      const isDuplicate = kept.some((k) => textSimilarity(extractTextFromItem(k), text) > SIMILARITY_THRESHOLD);
      if (!isDuplicate) kept.push(item);
    }
    result.push(...kept);
  }

  return result;
}


// Analyze mutual interactions among a set of handles.
// Returns a Map: handle → { repliedTo: Set, quoted: Set, mentioned: Set, quotedBy: Set, mentionedBy: Set }
function analyzeInteractions(items, handleSet) {
  // Map each tweet ID to its author handle for cross-referencing
  const tweetAuthor = new Map();
  for (const item of items) {
    const handle = extractHandleFromItem(item);
    const id = String(item?.id || item?.id_str || item?.tweetId || '').trim();
    if (handle && id) tweetAuthor.set(id, handle);
  }

  const interactions = new Map();
  const ensureEntry = (h) => {
    if (!interactions.has(h)) interactions.set(h, { repliedTo: new Set(), quoted: new Set(), mentioned: new Set(), quotedBy: new Set(), mentionedBy: new Set() });
    return interactions.get(h);
  };

  for (const item of items) {
    const author = extractHandleFromItem(item);
    if (!author || !handleSet.has(author)) continue;

    // Reply: author replied to target's tweet
    const replyTo = String(item?.inReplyToStatusId || item?.inReplyToStatusIdStr || '').trim();
    if (replyTo && tweetAuthor.has(replyTo)) {
      const target = tweetAuthor.get(replyTo);
      if (target !== author && handleSet.has(target)) {
        ensureEntry(author).repliedTo.add(target);
        ensureEntry(target).mentionedBy.add(author);
      }
    }

    // Quote: author quoted target's tweet (distinct from reply)
    const quoteOf = String(item?.quotedStatusId || item?.quotedStatusIdStr || '').trim();
    if (quoteOf && tweetAuthor.has(quoteOf)) {
      const target = tweetAuthor.get(quoteOf);
      if (target !== author && handleSet.has(target)) {
        ensureEntry(author).quoted.add(target);
        ensureEntry(target).quotedBy.add(author);
      }
    }

    // @mention: author mentioned target in text
    const text = extractTextFromItem(item);
    const mentions = text.match(/@(\w+)/g) || [];
    for (const m of mentions) {
      const mentionedHandle = normalizeHandle(m);
      if (mentionedHandle !== author && handleSet.has(mentionedHandle)) {
        ensureEntry(author).mentioned.add(mentionedHandle);
        ensureEntry(mentionedHandle).mentionedBy.add(author);
      }
    }
  }

  return interactions;
}

const rankPeople = (items, roster) => {
  const counts = items.reduce((map, item) => {
    const handle = extractHandleFromItem(item);
    return handle ? (map.set(handle, (map.get(handle) || 0) + 1), map) : map;
  }, new Map());

  const allHandles = new Set(counts.keys());
  const interactions = analyzeInteractions(items, allHandles);

  const meta = new Map(roster.map((r) => [normalizeHandle(r.handle), { name: r.name || r.handle, title: r.title || '', description: r.description || '' }]));

  // Composite scoring: output volume as base, with interaction bonuses
  // - outputCount: how active this person is (base signal)
  // - interactionScore: how connected they are with peers (reply/quote/mention)
  // Weights are intentionally soft — interactions boost relevance but don't dominate
  const ranked = Array.from(counts.entries())
    .map(([handle, outputCount]) => {
      const inter = interactions.get(handle);
      // Unique peers this person interacted with (in any direction)
      const peersEngaged = inter ? new Set([...inter.repliedTo, ...inter.quoted, ...inter.mentioned, ...inter.quotedBy, ...inter.mentionedBy]).size : 0;
      // Weighted score: active engagement (reply/quote/mention) counts more than passive (being quoted/mentioned)
      const interactionScore = inter
        ? (inter.repliedTo.size * 1.0 + inter.quoted.size * 1.2 + inter.mentioned.size * 0.5
           + inter.quotedBy.size * 1.5 + inter.mentionedBy.size * 0.8)
        : 0;
      // Final score: 60% output volume (normalized) + 40% interaction richness
      // Both components are on similar scales after normalization (done in sort)
      const compositeScore = outputCount + interactionScore * 2;
      return {
        name: (meta.get(handle)?.name) || handle,
        title: (meta.get(handle)?.title) || '',
        description: (meta.get(handle)?.description) || '',
        handle,
        outputCount,
        interactionScore: Math.round(interactionScore * 10) / 10,
        peersEngaged,
        compositeScore: Math.round(compositeScore * 10) / 10,
      };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);

  if (ranked.length > 0) {
    console.log('Top 5 by composite score:');
    ranked.slice(0, 5).forEach((p, i) => console.log(`  ${i + 1}. @${p.handle}: output=${p.outputCount}, interaction=${p.interactionScore}, peers=${p.peersEngaged}, composite=${p.compositeScore}`));
  }

  return ranked;
};


async function writeWeeklyCountsTable(ranking) {
  const header = '| 排名 | 本名 | X账号 | 近一周动态数量 | 互动分 | 同行互动数 |\n|---:|---|---|---:|---:|---:|';
  const rows = ranking.map((p, i) => `| ${i + 1} | ${p.name} | @${p.handle} | ${p.outputCount} | ${p.interactionScore || 0} | ${p.peersEngaged || 0} |`);
  const markdown = `${header}\n${rows.join('\n')}\n`;
  const csvHeader = 'rank,name,handle,weekly_output_count,interaction_score,peers_engaged';
  const csvRows = ranking.map((p, i) => `${i + 1},"${String(p.name).replaceAll('"', '""')}",${p.handle},${p.outputCount},${p.interactionScore || 0},${p.peersEngaged || 0}`);
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

// Fallback profiles for TOP20 appendix — roster title/description takes priority.
// Only used when a person enters TOP20 but their roster entry lacks title/description.
const PEOPLE_PROFILE_MAP = {
  // OpenAI
  sama: { title: 'OpenAI CEO', bio: '生成式AI浪潮核心人物' },
  gdb: { title: 'OpenAI总裁兼联合创始人', bio: 'OpenAI工程产品核心' },
  merettm: { title: 'OpenAI首席科学家', bio: 'OpenAI研究新掌门' },
  woj_zaremba: { title: 'OpenAI联合创始人', bio: 'OpenAI早期技术核心' },
  bradlightcap: { title: 'OpenAI首席运营官', bio: 'OpenAI商业运营核心' },
  npew: { title: 'OpenAI副总裁兼总经理', bio: '产品化落地关键高管' },
  bobmcgrewai: { title: '前OpenAI首席研究官', bio: 'OpenAI早期研究核心' },
  _jasonwei: { title: 'OpenAI研究科学家', bio: '链式思维研究代表' },
  polynoamial: { title: 'OpenAI研究科学家', bio: '博弈与推理研究名将' },
  willdepue: { title: 'OpenAI研究工程师', bio: 'Sora与后训练核心成员' },
  joannejang: { title: 'OpenAI Labs总经理', bio: '模型行为产品负责人' },
  romainhuet: { title: 'OpenAI开发者体验负责人', bio: 'Codex开发者关系门面' },
  steipete: { title: 'OpenAI产品工程负责人', bio: '开发工具创业老兵' },
  borismpower: { title: 'OpenAI应用研究负责人', bio: '科研走向应用的推手' },
  sebastienbubeck: { title: 'OpenAI研究员', bio: '大模型推理研究强者' },
  millionint: { title: 'OpenAI研究员', bio: '推理与智能体研究者' },
  therealadamg: { title: 'OpenAI GTM负责人', bio: 'OpenAI产品传播账号' },
  aidan_mclau: { title: 'OpenAI研究科学家', bio: '聚焦推理与模型能力' },
  // Anthropic
  darioamodei: { title: 'Anthropic CEO', bio: 'AI安全派创业代表' },
  alexalbert__: { title: 'Anthropic Claude Relations', bio: 'Claude生态关键代言人' },
  amandaaskell: { title: 'Anthropic伦理研究员', bio: 'Claude价值观设计者' },
  jackclarksf: { title: 'Anthropic联合创始人兼政策主管', bio: 'AI政策与产业桥梁' },
  janleike: { title: 'Anthropic安全研究负责人', bio: '对齐研究代表人物' },
  mikeyk: { title: 'Anthropic首席产品官', bio: 'Instagram联创转战AI' },
  bcherny: { title: 'Anthropic Claude Code负责人', bio: 'AI编程工具核心产品人' },
  _sholtodouglas: { title: 'Anthropic RL研究员', bio: 'RL与编程智能体研究者' },
  // Google / DeepMind
  demishassabis: { title: 'Google DeepMind CEO', bio: '谷歌AGI主帅' },
  jeffdean: { title: 'Google首席科学家', bio: '谷歌AI基建元老' },
  sundarpichai: { title: 'Alphabet兼Google CEO', bio: '谷歌AI战略总负责人' },
  officiallogank: { title: 'Google AI Studio', bio: 'Gemini开发者生态代言' },
  shanelegg: { title: 'DeepMind首席AGI科学家', bio: 'AGI路线长期倡导者' },
  oriolvinyalsml: { title: 'DeepMind研究副总裁', bio: '多智能体强化学习专家' },
  goodfellow_ian: { title: 'DeepMind研究科学家', bio: 'GAN提出者' },
  noamshazeer: { title: 'DeepMind杰出科学家', bio: 'Transformer核心作者之一' },
  jiahui_yu_: { title: 'DeepMind研究科学家', bio: 'Gemini多模态核心研发' },
  goodside: { title: 'DeepMind提示工程师', bio: '提示注入研究代表' },
  // Meta
  ylecun: { title: 'Meta首席AI科学家', bio: '深度学习三巨头之一' },
  finkd: { title: 'Meta创始人兼CEO', bio: '社交巨头押注AI' },
  natfriedman: { title: 'Meta超级智能实验室', bio: 'GitHub前CEO' },
  soumithchintala: { title: 'PyTorch核心创建者', bio: 'Thinking Machines Lab CTO' },
  yuxin_wu_: { title: 'Meta AI研究科学家', bio: '视觉与多模态模型专家' },
  // Microsoft / xAI
  mustafasuleyman: { title: 'Microsoft AI CEO', bio: '消费级AI产品掌舵' },
  elonmusk: { title: 'xAI创始人', bio: 'AI与算力叙事中心' },
  ibab: { title: 'xAI联合创始人', bio: 'xAI核心技术负责人' },
  // 独立研究者 / 学者
  karpathy: { title: 'Eureka Labs创始人', bio: '自动驾驶与LLM名将' },
  ilyasut: { title: 'SSI联合创始人', bio: '深度学习传奇研究者' },
  fchollet: { title: 'Google AI研究员', bio: 'Keras之父' },
  drfeifei: { title: 'World Labs创始人兼CEO', bio: '视觉AI领军学者' },
  drjimfan: { title: 'NVIDIA具身智能负责人', bio: '机器人基础模型布道者' },
  andrewyng: { title: 'LandingAI创始人兼CEO', bio: 'AI教育产业化旗手' },
  emollick: { title: '沃顿商学院教授', bio: 'AI办公实践头部学者' },
  yejinchoinka: { title: '斯坦福大学教授', bio: '常识推理研究领军者' },
  erikbryn: { title: '斯坦福数字经济实验室主任', bio: 'AI生产率研究权威' },
  tri_dao: { title: '普林斯顿助理教授', bio: 'FlashAttention核心作者' },
  awnihannun: { title: 'Apple机器学习研究员', bio: 'MLX框架核心开发者' },
  // 创业者 / 产品人
  aravsrinivas: { title: 'Perplexity CEO', bio: 'AI搜索赛道代表' },
  arthurmensch: { title: 'Mistral AI CEO', bio: '欧洲大模型创业代表' },
  alexandr_wang: { title: 'Scale AI创始人兼CEO', bio: '数据基础设施与企业AI' },
  mntruell: { title: 'Cursor联合创始人兼CEO', bio: 'AI原生IDE代表人物' },
  clementdelangue: { title: 'Hugging Face CEO', bio: '开源AI社区旗手' },
  amasad: { title: 'Replit创始人兼CEO', bio: 'AI编程平台掌舵者' },
  miramurati: { title: 'Thinking Machines Lab创始人', bio: 'OpenAI前CTO创业' },
  hardmaru: { title: 'Sakana AI CEO', bio: '世界模型与演化研究者' },
  hwchase17: { title: 'LangChain CEO', bio: 'AI Agent开发框架先驱' },
  antonosika: { title: 'Lovable CEO', bio: 'Vibe coding创业代表' },
  btaylor: { title: 'Sierra CEO', bio: '客服AI创业代表' },
  _akhaliq: { title: 'Hugging Face ML工程师', bio: '高频转发AI论文产品' },
  simonw: { title: '独立开发者与作家', bio: '开源LLM工程布道者' },
  teknium: { title: 'Nous Research联合创始人', bio: '开源后训练社区代表' },
  jiayq: { title: 'Lepton AI创始人', bio: 'Caffe作者' },
  tqchen: { title: 'OctoML联合创始人', bio: 'TVM与XGBoost核心作者' },
  justinlin610: { title: '阿里通义千问高级技术专家', bio: 'Qwen核心研发与开源推动者' },
  tobi: { title: 'Shopify创始人兼CEO', bio: '电商平台拥抱AI代表' },
  // 投资人 / 商业
  billgates: { title: '盖茨基金会主席', bio: '科技慈善双栖代表' },
  reidhoffman: { title: 'Greylock合伙人', bio: 'LinkedIn联创与AI投资人' },
  vkhosla: { title: 'Khosla Ventures创始人', bio: '硬科技AI投资老兵' },
  paulg: { title: 'Y Combinator联合创始人', bio: '硅谷创业教父' },
  saranormous: { title: 'Conviction创始人', bio: 'AI创业投资女将' },
  deedydas: { title: 'Menlo Ventures合伙人', bio: '技术派AI投资人' },
  davidsacks: { title: '白宫AI与加密事务负责人', bio: '硅谷政商跨界人物' },
  ajassy: { title: 'Amazon总裁兼CEO', bio: '云与AI基础设施掌舵' },
  // 媒体 / 博主
  rowancheung: { title: 'The Rundown AI创始人', bio: 'AI资讯头部博主' },
  lexfridman: { title: 'MIT研究科学家兼播客主持', bio: '长访谈播客头部人物' },
  dylan522p: { title: 'SemiAnalysis创始人', bio: '算力与半导体分析师' },
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
      const peerInfo = p.peersEngaged > 0 ? `，与${p.peersEngaged}位同行互动` : '';
      return `${p.name}（@${p.handle}）| ${title}：${bio} | 今日action数量：${actionCount}，涉及到${hotspotCount}个热点${peerInfo}`;
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
  // Convert indented numbered items to dash items EARLY (before the newline-insertion
  // regex below strips their indentation).  The /m flag makes ^ match each line start.
  // Use [^\S\n]+ (non-newline whitespace) so that \s doesn't eat a \n and accidentally
  // match top-level items preceded by a blank line.
  text = text.replace(/^([^\S\n]+)\d+\.\s+/gm, '$1- ');

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

  // Convert indented numbered items to dash items so they are not mistaken
  // for top-level events after the parser trims all lines.
  for (let i = 0; i < cleaned.length; i += 1) {
    const indented = cleaned[i].match(/^(\s+)\d+\.\s+(.*)$/);
    if (indented) {
      cleaned[i] = `${indented[1]}- ${indented[2]}`;
    }
  }

  // renumber only top-level (non-indented) ordered items sequentially
  let idx = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const m = cleaned[i].match(/^(\d+)\.\s+(.*)$/);
    if (m) {
      idx += 1;
      cleaned[i] = `${idx}. ${m[2]}`;
    }
  }

  text = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // Remove 动态 entries (dash-prefixed lines under 相关动态) that have no source link
  text = stripSourcelessDynamic(text);

  return `${text}\n`;
}

/**
 * Remove 相关动态 entries that have no source link ([@...](url)).
 * These are entries that the LLM generated without attributing a source,
 * which violates the output format requirement.
 */
function stripSourcelessDynamic(text) {
  const lines = text.split('\n');
  const result = [];
  let inDynamicBlock = false;
  let strippedCount = 0;
  let dynamicListCount = 0;
  let keptWithSourceCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect start of 相关动态 block
    if (/\*\*相关动态[：:]?\*\*/.test(trimmed) || /^相关动态[：:]?$/.test(trimmed)) {
      inDynamicBlock = true;
      result.push(line);
      continue;
    }

    // If we're in a dynamic block and hit a list item (bullet/numbered), check for source
    if (inDynamicBlock && /^([-•*]\s+|\d+[.)、]\s+)/.test(trimmed)) {
      dynamicListCount += 1;
      // Check if this line contains a source link pattern [@...](url)
      if (/\[@[^\]]+\]\(https?:\/\/[^)]+\)/.test(trimmed)) {
        keptWithSourceCount += 1;
        result.push(line);
      } else {
        strippedCount += 1;
        // skip this line — no source
      }
      continue;
    }

    // If we hit a non-list, non-empty line while in dynamic block, leave the block
    if (inDynamicBlock && trimmed !== '' && !/^([-•*]\s+|\d+[.)、]\s+)/.test(trimmed)) {
      inDynamicBlock = false;
    }

    result.push(line);
  }

  // Safety valve: if strict stripping would wipe out essentially all dynamics,
  // keep original text to avoid empty report cards in email.
  if (dynamicListCount > 0 && keptWithSourceCount === 0 && strippedCount > 0) {
    console.warn(
      `stripSourcelessDynamic fallback: stripped=${strippedCount}, dynamicListCount=${dynamicListCount}, kept=${keptWithSourceCount}. Returning original markdown to avoid empty sections.`,
    );
    return text;
  }

  if (strippedCount > 0) {
    console.warn(`stripSourcelessDynamic: removed ${strippedCount} 动态 entries without source links`);
  }

  return result.join('\n');
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
  let inRelatedDynamicBlock = false;
  const topSectionNotes = [];
  const appendixLines = [];
  let inAppendix = false;
  // Track ## section headers from Gemini output to preserve its topic grouping
  let currentSectionTitle = '';

  for (let lineIndex = 0; lineIndex < contentLines.length; lineIndex += 1) {
    const line = contentLines[lineIndex];
    if (/^##\s*TOP20活跃人物/i.test(line)) {
      if (currentEvent) {
        events.push(currentEvent);
        currentEvent = null;
        inRelatedDynamicBlock = false;
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
        inRelatedDynamicBlock = false;
      }
      currentSectionTitle = sectionMatch[1].replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, '').trim();
      continue;
    }

    // Detect ### sub-section headers (e.g. "### 开发工具与Agent工作流优化")
    // Gemini sometimes uses ### for mid-heat topic groups under a ## parent section
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match) {
      if (currentEvent) {
        events.push(currentEvent);
        currentEvent = null;
        inRelatedDynamicBlock = false;
      }
      currentSectionTitle = h3Match[1].replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, '').trim();
      continue;
    }

    const ordered = line.match(/^(\d+)\.\s+(.+)/);
    // Also match bold standalone titles like "**事件标题**" (LLM sometimes uses this instead of numbered lists)
    const boldTitle = !ordered && line.match(/^\*\*([^*]+)\*\*\s*$/);
    const dynamicNumberedLine = /^\d+[.)、]\s+\[@[^\]]+\]\(https?:\/\/[^)]+\)/.test(line.trim());
    if (ordered || boldTitle) {
      if (currentEvent && inRelatedDynamicBlock && ordered) {
        // While inside "相关动态", numbered lines are dynamic entries, not new events.
      } else {
      const candidateTitle = ordered ? ordered[2] : boldTitle[1];
      // If this numbered item is actually "Today's Summary" / "今日总结", treat it as
      // the start of the summary section rather than an event item.
      if (/today'?s\s*summary|今日总结|executive\s*summary/i.test(candidateTitle)) {
          if (currentEvent) { events.push(currentEvent); currentEvent = null; }
          inRelatedDynamicBlock = false;
          // Collect remaining lines as summary until end or next ## section
          let k = lineIndex + 1;
        while (k < contentLines.length && !/^##\s+/.test(contentLines[k])) {
          const sl = contentLines[k].replace(/^[○■*-]\s+/, '').trim();
          if (sl) summaryLines.push(sl);
          k++;
        }
        break; // stop main loop; everything after is summary/appendix
      }
      if (currentEvent) events.push(currentEvent);
      inRelatedDynamicBlock = false;
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
        inRelatedDynamicBlock = false;
        const value = plain.replace(/^热点解析[:：]\s*/, '').trim();
        if (value) currentEvent.analysis.push(value);
      } else if (/why it matters|管理层意义|业务影响|重要性/i.test(plain)) {
        inRelatedDynamicBlock = false;
        const value = plain.replace(/^([^:：]+)[:：]\s*/, '').trim();
        if (value) currentEvent.why = value;
      } else if (/相关动态[:：]/.test(plain)) {
        inRelatedDynamicBlock = true;
        const value = plain.replace(/^相关动态[:：]\s*/, '').trim();
        if (value) currentEvent.actions.push(value);
      } else if (inRelatedDynamicBlock) {
        // Accept richer dynamic list formats:
        // - [@Name](url): ...
        // 1. [@Name](url) ...
        // 1) [@Name](url)：...
        // [@Name](url) ...
        const actionCandidate = plain
          .replace(/^[-•*]\s+/, '')
          .replace(/^\d+[.)、]\s+/, '')
          .trim();
        if (/^\[@[^\]]+\]\(https?:\/\/[^)]+\)/.test(actionCandidate)) {
          currentEvent.actions.push(actionCandidate);
          continue;
        }
        if (actionCandidate && /https?:\/\//.test(actionCandidate)) {
          currentEvent.actions.push(actionCandidate);
          continue;
        }
        // A non-link narrative line means we likely left the dynamic block.
        inRelatedDynamicBlock = false;
      } else if (/^\[@[^\]]+\]\(https?:\/\/[^)]+\)\s*[:：]/.test(plain)) {
        // Dynamic entry with source link — treat as action content, not a bare source
        currentEvent.actions.push(plain);
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
  inRelatedDynamicBlock = false;

  // Split events by section title: events under the TOP3 header go into top3,
  // everything else goes into secondary.  This is more robust than a blind
  // slice(0,3) which breaks whenever a phantom event shifts positions.
  const top3 = [];
  const secondary = [];
  for (const evt of events) {
    if (top3.length < 3 && /top\s*3|(?<!中)热度事件/i.test(evt.sectionTitle || '')) {
      top3.push(evt);
    } else {
      secondary.push(evt);
    }
  }
  // Fallback: if section-based split found no top3 (LLM didn't use expected header),
  // fall back to positional slice.
  if (top3.length === 0 && events.length > 0) {
    top3.push(...events.slice(0, Math.min(3, events.length)));
    secondary.length = 0;
    secondary.push(...events.slice(top3.length));
  }
  console.log(`Renderer parse stats: events=${events.length}, top3=${top3.length}, secondary=${secondary.length}`);

  // Group secondary events by Gemini's own ## section titles instead of re-classifying
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
请根据提供的原始动态数据生成日报。

# AI Pulse - X Daily Brief

## 聚类核心规则（必须遵守）
- **先逐条判断每条动态的具体主题**（例如”Claude 4发布”、”GPU供应链紧张”、”Cursor融资”等具体事件），而不是直接按预设大类归并
- **然后将主题相同或高度相关的动态聚类为一个”事件”**
- **每个事件的热度 = 涉及的不同人数（participantCount）**，即有多少个不同的人讨论了这个具体事件
- 同一个人发多条推文/引用/回复关于同一事件，只算1个参与者
- 提供的话题统计仅作宏观参考，不要直接用其分类结果，请你独立从数据中发现具体事件
- **输出中不要显示参与人数、participantCount 等统计数字，只用于排序**

## 输出格式（严格遵守）

### TOP3热度事件
从聚类结果中选出参与人数最多的3个具体事件。
**每条TOP3事件至少包含3条相关动态，每条动态必须有来源链接。**

\`\`\`
## TOP3 热度事件

1. 事件标题A
   - **热点解析：** …
   - **相关动态：**
     - [@本名](url): 动态描述…
     - [@本名](url): 动态描述…
     - [@本名](url): 动态描述…

2. 事件标题B
   - **热点解析：** …
   - **相关动态：**
     - [@本名](url): 动态描述…
     - [@本名](url): 动态描述…
     - [@本名](url): 动态描述…

3. 事件标题C
   - **热点解析：** …
   - **相关动态：**
     - [@本名](url): 动态描述…
     - [@本名](url): 动态描述…
     - [@本名](url): 动态描述…
\`\`\`

### 中热度事件
从剩余聚类结果中，选出参与人数次高的事件，共输出7-12条事件，分成2-4个Topic。
**每条事件都是一个具体的、独立的事件（如一个产品发布、一项研究突破、一次融资），而不是笼统的大类。**
**跨Topic排列规则：包含更高参与人数事件的Topic排在前面。**
**每个Topic内的事件也必须严格按参与人数从高到低排列。**
**每个Topic至少包含2条事件，每条事件至少包含2条相关动态。**
**即使只有1个人提到的独立事件，如果有足够信息价值，也可以作为中热度事件输出（放在靠后的Topic中）。**

\`\`\`
## 中热度话题

### Topic标题A
1. 事件标题X
   - **热点解析：** …
   - **相关动态：**
     - [@本名](url): 动态描述…
     - [@本名](url): 动态描述…

2. 事件标题Y
   - **热点解析：** …
   - **相关动态：**
     - [@本名](url): 动态描述…
     - [@本名](url): 动态描述…

### Topic标题B
1. 事件标题Z
   - **热点解析：** …
   - **相关动态：**
     - [@本名](url): 动态描述…
     - [@本名](url): 动态描述…
\`\`\`

### 通用规则
- 不需要按传统行业大类分类，请根据数据内容自行发现具体事件
- **关键约束：同一事件内，每个账号（@handle）最多只能出现1次。** 每条数据代表一个不同的人的观点，请全部使用，不要重复引用同一人
- 不要输出”聚类一/二/三”字样；不要输出”额外观察”与”AI大厂与投资机构资讯”板块
- 关联动态中的来源链接，不使用”查看原帖”，统一写成 [@本名](url)（本名不是X用户名）
- **【强制】每条”相关动态”都必须包含来源链接 [@本名](url)，没有来源链接的动态不要输出。每条动态的格式必须是： - [@本名](url): 描述文字… ，冒号前面是来源链接，冒号后面是描述。**
- **每条事件的”相关动态”至少2条，尽量3条以上。如果某事件只有1个来源，则将该事件合并到相关事件中，不要单独列出。**
- **不要输出 Today's Summary 板块**，Summary将在报告生成后单独生成
- 输出Markdown，结构清晰，分级列表明确
`;
}

async function requestGeminiReportOnce({ apiKey, model, prompt }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5 minutes (Gemini 3 thinking + large output needs more time)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Gemini 3.x recommends temperature=1.0; lower values (e.g. 0.2) may cause
  // looping or degraded output. Keep 1.0 as default for gemini-3 compatibility.
  const generationConfig = {
    temperature: Number(process.env.GEMINI_TEMPERATURE || 1.0),
    maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 65536),
  };

  // Gemini 3.x supports thinking_level (minimal/low/medium/high).
  // Set GEMINI_THINKING_LEVEL to control reasoning depth; omit to use model default.
  const thinkingLevel = process.env.GEMINI_THINKING_LEVEL;
  const thinkingConfig = thinkingLevel ? { thinkingConfig: { thinkingLevel: thinkingLevel.toUpperCase() } } : {};

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
        ...thinkingConfig,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) throw new Error(`Gemini request failed: ${response.status} ${await response.text()}`);
  const json = await response.json();

  // Check if output was truncated due to token limit
  const finishReason = json?.candidates?.[0]?.finishReason;
  if (finishReason === 'MAX_TOKENS') {
    console.error('ERROR: Gemini output was truncated due to maxOutputTokens limit. Report is incomplete. Consider increasing GEMINI_MAX_OUTPUT_TOKENS.');
  } else if (finishReason === 'SAFETY') {
    console.warn('WARNING: Gemini output was blocked or truncated due to safety filters.');
  }

  // Extract text parts, skipping thinking parts (Gemini 3 returns thought: true on internal reasoning)
  const text = (json?.candidates || [])
    .flatMap((c) => (c?.content?.parts || []).filter((p) => !p?.thought).map((p) => p?.text).filter(Boolean))
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
  const fingerprint = getInputFingerprint(input);
  const cacheMeta = {
    reuseEnabled: shouldReuseRecentRuns(),
    reuseLimit: getRecentRunsLimit(),
    reuseMaxAgeHours: getReuseMaxAgeHours(),
  };

  if (inProcessApifyCache.has(fingerprint)) {
    const cached = inProcessApifyCache.get(fingerprint);
    console.log(`Apify in-process cache hit: items=${cached.items.length}`);
    return { ...cached, reused: true };
  }

  if (cacheMeta.reuseEnabled) {
    console.log(`Apify reuse check enabled (limit=${cacheMeta.reuseLimit}, maxAgeHours=${cacheMeta.reuseMaxAgeHours})`);
  }
  const reused = await tryReuseRecentRun({ token, actorId, input });
  if (reused) {
    inProcessApifyCache.set(fingerprint, reused);
    return reused;
  }

  const items = await fetchApifyDatasetItems({ token, actorId, input });
  const fresh = { items, runData: { id: normalizeActorId(actorId), status: 'SUCCEEDED' }, datasetId: 'run-sync-output', reused: false };
  inProcessApifyCache.set(fingerprint, fresh);
  return fresh;
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

async function generateSummary({ apiKey, model, reportMarkdown }) {
  const summaryPrompt = `你是一个专业的AI行业分析师。以下是今天生成的AI日报内容，请根据日报内容撰写一段 Today's Summary。

要求：
- 用 ## Today's Summary 作为独立的二级标题
- 内容用一个自然段完成（不分点，不超过200字）
- 不得将 Today's Summary 作为编号列表中的一项
- 概括今天日报中最重要的趋势和事件
- 只输出 ## Today's Summary 部分，不要输出其他内容

日报内容：
${reportMarkdown}`;

  return requestGeminiReport({ apiKey, model, prompt: summaryPrompt });
}

async function loadPromptRules() {
  const rulesPath = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..', 'prompt-rules.md');
  try {
    const content = await fs.readFile(rulesPath, 'utf-8');
    // Strip markdown comments and metadata, keep only actual rules
    const rules = content
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^#\s+Prompt Rules.*$/m, '')
      .replace(/^>\s+.*$/gm, '')
      .replace(/^---$/gm, '')
      .replace(/^##\s+使用方法[\s\S]*?(?=^## 规则列表)/m, '')
      .replace(/^##\s+规则列表\s*/m, '')
      .trim();
    if (rules.length > 0) {
      console.log(`Loaded prompt-rules.md (${rules.length} chars)`);
      return rules;
    }
    console.log('prompt-rules.md is empty, no extra rules applied.');
    return '';
  } catch {
    console.log('No prompt-rules.md found, skipping extra rules.');
    return '';
  }
}

function extractSection(text, startPattern, endPattern) {
  const source = String(text || '');
  const startMatch = source.match(startPattern);
  if (!startMatch) return '';
  const startIdx = startMatch.index + startMatch[0].length;
  const rest = source.slice(startIdx);
  const endMatch = rest.match(endPattern);
  return endMatch ? rest.slice(0, endMatch.index) : rest;
}

function analyzeReportStructure(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  const top3Section = extractSection(text, /^##\s*TOP3[^\n]*\n?/im, /^##\s+/im);
  const secondarySection = extractSection(text, /^##\s*中热度[^\n]*\n?/im, /^##\s*(TOP20活跃人物|Today's Summary)\b/im);
  const top3EventCount = (top3Section.match(/^\d+\.\s+/gm) || []).length;
  const secondaryEventCount = (secondarySection.match(/^\d+\.\s+/gm) || []).length;
  const sourceLinkCount = (text.match(/\[@[^\]]+\]\(https?:\/\/[^)]+\)/g) || []).length;
  return { top3EventCount, secondaryEventCount, sourceLinkCount };
}

function isStructureWeak(structure) {
  return structure.top3EventCount < 3 || structure.secondaryEventCount < 4 || structure.sourceLinkCount < 10;
}

function buildFallbackReportFromItems(items, top20) {
  const nameMap = new Map((top20 || []).map((p) => [normalizeHandle(p.handle), p.name || p.handle]));
  const topicBuckets = new Map();
  for (const item of items || []) {
    const handle = normalizeHandle(extractHandleFromItem(item));
    if (!handle) continue;
    const text = extractTextFromItem(item).replace(/\s+/g, ' ').trim();
    const url = item?.url || item?.tweetUrl || item?.link || '';
    if (!text || !url) continue;
    const topic = classifyHotspots(text)[0] || '其他AI动态';
    if (!topicBuckets.has(topic)) topicBuckets.set(topic, []);
    topicBuckets.get(topic).push({ handle, name: nameMap.get(handle) || handle, text: text.slice(0, 180), url });
  }

  const sortedTopics = Array.from(topicBuckets.entries())
    .sort((a, b) => b[1].length - a[1].length);

  const eventCandidates = [];
  for (const [topic, entries] of sortedTopics) {
    // Split each topic into chunks so one hot topic can still generate multiple events.
    const chunkSize = 4;
    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      if (chunk.length === 0) continue;
      const suffix = i === 0 ? '' : `（扩展${Math.floor(i / chunkSize) + 1}）`;
      eventCandidates.push({ topic, title: `${topic}${suffix}`, entries: chunk, weight: chunk.length });
    }
  }
  eventCandidates.sort((a, b) => b.weight - a.weight);

  const buildEventBlock = (topic, entries, index) => {
    const dynamics = entries
      .slice(0, 4)
      .map((e) => `     - [@${e.name}](${e.url}): ${e.text}`)
      .join('\n');
    return `${index}. ${topic} 相关信号持续升温
   - **热点解析：** ${topic} 在今日监测样本中出现频率较高，涉及多位活跃账号，建议结合相关动态快速判断对业务的直接影响。
   - **相关动态：**
${dynamics}`;
  };

  const allEntries = sortedTopics.flatMap(([, entries]) => entries);
  while (eventCandidates.length < 7 && allEntries.length > 0) {
    const i = eventCandidates.length;
    const slice = allEntries.slice((i * 3) % allEntries.length, ((i * 3) % allEntries.length) + 3);
    const fallbackEntries = slice.length > 0 ? slice : allEntries.slice(0, 3);
    eventCandidates.push({
      topic: '其他AI动态',
      title: `补充信号${i + 1}`,
      entries: fallbackEntries,
      weight: fallbackEntries.length,
    });
  }

  const top3Candidates = eventCandidates.slice(0, 3);
  const secondaryCandidates = eventCandidates.slice(3, 7);
  const top3Sections = top3Candidates
    .map((evt, i) => buildEventBlock(evt.title, evt.entries, i + 1))
    .join('\n\n');
  const secondarySections = secondaryCandidates
    .map((evt, i) => (
      `### ${evt.topic}\n\n${buildEventBlock(`${evt.title} 进展`, evt.entries, i + 1)}`
    ))
    .join('\n\n');

  return `# AI Pulse - X Daily Brief

## TOP3 热度事件

${top3Sections || '1. 今日核心信号不足\n   - **热点解析：** 今日样本中可聚类信号有限，建议关注明日增量。\n   - **相关动态：**\n     - [@来源](https://x.com): 暂无可用来源。'}

## 中热度话题

${secondarySections || '### 其他观察\n\n1. 事件补充\n   - **热点解析：** 中热度事件不足，保留观察。\n   - **相关动态：**\n     - [@来源](https://x.com): 暂无可用来源。'}
`;
}

async function generateReport(items, top20, stats, peopleStats) {
  if (!Array.isArray(items) || items.length === 0) {
    return `# AI Pulse - X Daily Brief\n\n今日无可用AI相关内容。\n`;
  }

  const apiKey = requireEnv('GEMINI_API_KEY');
  const model = requireEnv('GEMINI_MODEL');
  console.log(`Using GEMINI_MODEL=${model}`);

  const promptItems = buildPromptItems(items);

  // Extract only the fields Gemini needs — do NOT tag with broad categories
  // so that Gemini clusters by actual content similarity, not our 9 predefined labels.
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
  const promptRules = await loadPromptRules();
  const rulesSection = promptRules ? `\n\n## 额外规则（基于历史反馈，必须遵守）\n${promptRules}` : '';
  const prompt = `${getPromptTemplate()}${rulesSection}\n\n话题统计（宏观参考，已按participantCount降序排列）：\n${JSON.stringify(stats, null, 2)}\n\n去重后的原始动态（共${compactItems.length}条）。请你独立判断每条动态的具体主题，然后按主题相似性聚类为具体事件，再根据每个事件涉及的不同人数（participantCount）排序：\n${JSON.stringify(compactItems, null, 2)}`;
  let markdown = await requestGeminiReport({ apiKey, model, prompt });
  let normalized = normalizeMarkdownLayout(markdown);
  let withRealNameLinks = relabelSourceLinksWithRealNames(normalized, top20);
  let reportBody = appendTop20Appendix(withRealNameLinks, top20, peopleStats);
  let structure = analyzeReportStructure(reportBody);
  console.log(
    `Report structure stats: top3=${structure.top3EventCount}, secondary=${structure.secondaryEventCount}, sourceLinks=${structure.sourceLinkCount}`,
  );

  const retryWeakStructure = parseBooleanEnv(process.env.GEMINI_RETRY_WEAK_STRUCTURE, true);
  if (retryWeakStructure && isStructureWeak(structure)) {
    console.warn(
      `Weak report structure detected. Retrying Gemini once (top3=${structure.top3EventCount}, secondary=${structure.secondaryEventCount}, links=${structure.sourceLinkCount})...`,
    );
    const repairPrompt = `${prompt}

上一次输出结构不达标，请重新输出并严格满足：
- TOP3热度事件必须正好3条（编号1-3）
- 中热度话题下至少4条事件
- 每条事件至少2条相关动态，且每条动态都必须包含 [@本名](url) 链接
- 不要跳号（例如 1 后直接到 4）`;
    markdown = await requestGeminiReport({ apiKey, model, prompt: repairPrompt });
    normalized = normalizeMarkdownLayout(markdown);
    withRealNameLinks = relabelSourceLinksWithRealNames(normalized, top20);
    reportBody = appendTop20Appendix(withRealNameLinks, top20, peopleStats);
    structure = analyzeReportStructure(reportBody);
    console.log(
      `Report structure stats after retry: top3=${structure.top3EventCount}, secondary=${structure.secondaryEventCount}, sourceLinks=${structure.sourceLinkCount}`,
    );
  }
  if (isStructureWeak(structure)) {
    console.warn(
      `Report structure still weak after retry. Falling back to deterministic structure from source items (top3=${structure.top3EventCount}, secondary=${structure.secondaryEventCount}, links=${structure.sourceLinkCount}).`,
    );
    const fallbackMarkdown = buildFallbackReportFromItems(promptItems, top20);
    normalized = normalizeMarkdownLayout(fallbackMarkdown);
    withRealNameLinks = relabelSourceLinksWithRealNames(normalized, top20);
    reportBody = appendTop20Appendix(withRealNameLinks, top20, peopleStats);
    structure = analyzeReportStructure(reportBody);
    console.log(
      `Report structure stats after deterministic fallback: top3=${structure.top3EventCount}, secondary=${structure.secondaryEventCount}, sourceLinks=${structure.sourceLinkCount}`,
    );
  }

  // Generate summary as a separate step based on the finished report
  console.log('Generating Today\'s Summary based on report content...');
  const summarySection = await generateSummary({ apiKey, model, reportMarkdown: reportBody });
  // Remove any existing summary from reportBody (in case Gemini still included one)
  const reportWithoutSummary = reportBody.replace(/## Today's Summary[\s\S]*?(?=\n## |\n---|\n\*\*|$)/, '').trimEnd();
  return `${reportWithoutSummary}\n\n${summarySection.trim()}\n`;
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

function parseDateLoose(value) {
  if (!value) return null;
  const asNumber = Number(String(value).trim());
  if (Number.isFinite(asNumber)) {
    // Support unix seconds / milliseconds timestamps
    const ms = asNumber > 1e12 ? asNumber : asNumber > 1e9 ? asNumber * 1000 : NaN;
    if (Number.isFinite(ms)) {
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const normalized = String(value).replace(/年|\/|\./g, '-').replace(/月/g, '-').replace(/日/g, '').trim();
  // If timestamp has no timezone info, assume UTC to avoid host-locale drift.
  const maybeNoTimezone = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(normalized)
    ? `${normalized.replace(' ', 'T')}Z`
    : normalized;
  const parsedNoTz = new Date(maybeNoTimezone);
  if (!Number.isNaN(parsedNoTz.getTime())) return parsedNoTz;
  const parsedNormalized = new Date(normalized);
  if (!Number.isNaN(parsedNormalized.getTime())) return parsedNormalized;
  return null;
}

function isWithinDays(date, days) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const now = Date.now();
  return now - date.getTime() <= days * 24 * 60 * 60 * 1000;
}

function stripHtmlTags(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

async function fetchTextWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AI-Pulse-DailyBrief/1.0)',
        Accept: 'text/html,application/xml,text/xml,application/rss+xml,application/atom+xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithFallback(url, timeoutMs = 15000) {
  try {
    return await fetchTextWithTimeout(url, timeoutMs);
  } catch (err) {
    const useJinaFallback = parseBooleanEnv(process.env.CROSS_VALIDATE_USE_JINA, true);
    if (!useJinaFallback) throw err;
    const jinaUrl = `https://r.jina.ai/http://${String(url).replace(/^https?:\/\//i, '')}`;
    return fetchTextWithTimeout(jinaUrl, timeoutMs);
  }
}

const TWITTER_NEWS_HINTS = ['twitter', 'x.com', 'tweet', 'tweets', '推特', '马斯克', '转帖', '转推', '发帖', '@'];

function isTwitterRelatedArticle(article) {
  const haystack = `${article?.title || ''} ${article?.description || ''}`.toLowerCase();
  return TWITTER_NEWS_HINTS.some((kw) => haystack.includes(kw.toLowerCase()));
}

function normalizeWeChatUrl(url) {
  try {
    const u = new URL(url);
    if (!/mp\.weixin\.qq\.com$/i.test(u.hostname)) return '';
    if (!u.pathname.startsWith('/s')) return '';
    const keep = new URLSearchParams();
    ['__biz', 'mid', 'idx', 'sn', 'scene'].forEach((k) => {
      const v = u.searchParams.get(k);
      if (v) keep.set(k, v);
    });
    u.search = keep.toString();
    return u.toString();
  } catch {
    return '';
  }
}

function extractWeChatArticleUrls(text) {
  const urls = String(text || '').match(/https?:\/\/mp\.weixin\.qq\.com\/s\?[^\s<>"')]+/gi) || [];
  return Array.from(new Set(urls.map(normalizeWeChatUrl).filter(Boolean)));
}

function parseWeChatArticleMeta(html, url, expectedMediaName) {
  const title = decodeXmlEntities(
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
    || '',
  );

  const accountName = decodeXmlEntities(
    html.match(/<meta[^>]+property=["']og:article:author["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/var\s+nickname\s*=\s*htmlDecode\("([^"]+)"\)/i)?.[1]
    || html.match(/var\s+nickname\s*=\s*"([^"]+)"/i)?.[1]
    || '',
  );

  const publishedText = decodeXmlEntities(
    html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/var\s+publish_time\s*=\s*"([^"]+)"/i)?.[1]
    || '',
  );

  const epochMatch = html.match(/var\s+ct\s*=\s*"?(?<ts>\d{10})"?/i);
  const epochDate = epochMatch?.groups?.ts ? new Date(Number(epochMatch.groups.ts) * 1000) : null;
  const publishedAtDate = epochDate && !Number.isNaN(epochDate.getTime()) ? epochDate : parseDateLoose(publishedText);

  const description = stripHtmlTags(
    decodeXmlEntities(
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || '',
    ),
  ).slice(0, 500);

  if (!title) return null;
  if (!accountName || !accountName.includes(expectedMediaName)) return null;

  return {
    media: expectedMediaName,
    title,
    link: url,
    publishedAt: publishedAtDate ? publishedAtDate.toISOString() : null,
    description,
    source: 'wechat',
    accountName,
  };
}

async function fetchRecentMediaArticles() {
  const targetMedia = ['量子位', '机器之心', '新智元'];
  const candidateUrls = new Map();

  for (const mediaName of targetMedia) {
    const searchQueries = [
      `${mediaName} 推特`,
      `${mediaName} Twitter X`,
      `${mediaName} AI`,
    ];
    for (const q of searchQueries) {
      const sogouUrl = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(q)}`;
      const bingUrl = `https://cn.bing.com/search?q=${encodeURIComponent(`site:mp.weixin.qq.com "${mediaName}" ${q}`)}`;
      for (const searchUrl of [sogouUrl, bingUrl]) {
        try {
          const page = await fetchTextWithFallback(searchUrl, 15000);
          const links = extractWeChatArticleUrls(page);
          if (!candidateUrls.has(mediaName)) candidateUrls.set(mediaName, new Set());
          links.forEach((u) => candidateUrls.get(mediaName).add(u));
        } catch (err) {
          console.warn(`Search fetch failed for ${mediaName} (${searchUrl}): ${err.message}`);
        }
      }
    }
  }

  const allArticles = [];
  for (const mediaName of targetMedia) {
    const urls = Array.from(candidateUrls.get(mediaName) || []).slice(0, 12);
    for (const url of urls) {
      try {
        const html = await fetchTextWithFallback(url, 15000);
        const article = parseWeChatArticleMeta(html, url, mediaName);
        if (!article) continue;
        allArticles.push(article);
      } catch (err) {
        console.warn(`Article fetch failed for ${mediaName} (${url}): ${err.message}`);
      }
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const article of allArticles) {
    const key = `${article.media}::${article.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(article);
  }

  const recent = deduped
    .filter((a) => !a.publishedAt || isWithinDays(parseDateLoose(a.publishedAt), 2))
    .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime());

  const twitterRelated = recent.filter(isTwitterRelatedArticle);
  return {
    recentArticles: recent.slice(0, 30),
    twitterArticles: twitterRelated.slice(0, 15),
  };
}

// Cross-validate report against three specific WeChat public accounts:
// 量子位, 机器之心, 新智元
async function crossValidateWithMedia({ apiKey, model, reportMarkdown }) {
  console.log('Starting cross-validation with Chinese AI media...');

  const mediaNames = ['量子位', '机器之心', '新智元'];
  const { recentArticles, twitterArticles } = await fetchRecentMediaArticles();
  const selectedArticles = twitterArticles.length > 0 ? twitterArticles : recentArticles;
  const articleLines = selectedArticles.map((a, idx) => {
    const when = a.publishedAt ? a.publishedAt.slice(0, 10) : '未知日期';
    return `${idx + 1}. [${a.media}] ${a.title}（${when}）\n   链接: ${a.link}\n   摘要: ${a.description || '无摘要'}`;
  });

  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile(
    'artifacts/media-cross-validation-sources.json',
    JSON.stringify({ generatedAt: new Date().toISOString(), recentArticles, twitterArticles }, null, 2),
    'utf8',
  );

  const crossValidationPrompt = `你是一个AI行业分析师，负责对比验证日报的覆盖质量。

以下是我们今天生成的AI日报：
---
${reportMarkdown.slice(0, 6000)}
---

以下是从"${mediaNames.join('、')}"公开站点实时抓取到的最近两天文章（优先Twitter/X相关新闻）：
${articleLines.length > 0 ? articleLines.join('\n') : '未抓取到可用外部文章，请明确指出“外部数据缺失”。'}

请你必须基于上面“实时抓取文章”来交叉验证日报（不要仅凭常识）：

1. **覆盖盲区**：这三家公众号近两天可能会重点报道、但我们日报中可能遗漏的重大事件有哪些？（只列真实可能发生的事件，不要编造）
2. **权重偏差**：我们日报中某些事件的重要性是否被高估或低估了？从国内视角看，哪些事件对中国AI从业者更重要？
3. **改进建议**：基于以上对比，给出 2-3 条具体、可执行的 prompt 改进规则，用于提升下次日报的覆盖质量。规则应该是通用的，不要太具体到某个事件。

请用以下格式输出（纯文本，不要 JSON）：

### 覆盖盲区
- ...

### 权重偏差
- ...

### 改进建议（可直接追加到 prompt-rules.md）
- ...
`;

  try {
    const result = await requestGeminiReport({ apiKey, model, prompt: crossValidationPrompt });
    console.log('Cross-validation complete.');
    return result;
  } catch (err) {
    console.warn(`Cross-validation failed (non-fatal): ${err.message}`);
    return null;
  }
}

// Save cross-validation results to iteration log for user review
async function saveIterationLog({ crossValidation, date }) {
  const logPath = 'artifacts/iteration-log.md';

  let existing = '';
  try {
    existing = await fs.readFile(logPath, 'utf-8');
  } catch { /* first run */ }

  const newEntry = `\n---\n\n## ${date} 交叉验证结果\n\n${crossValidation}\n`;

  // Prepend new entry after header (or create header)
  if (existing.includes('# 日报迭代日志')) {
    const insertAt = existing.indexOf('\n', existing.indexOf('# 日报迭代日志'));
    const updated = existing.slice(0, insertAt) + '\n' + newEntry + existing.slice(insertAt);
    await fs.writeFile(logPath, updated, 'utf8');
  } else {
    const content = `# 日报迭代日志\n\n> 每次生成日报后，自动与国内AI媒体（量子位、机器之心、新智元）交叉验证。\n> 用户审阅后，可将有价值的改进建议手动迁移到 prompt-rules.md 使其永久生效。\n${newEntry}`;
    await fs.writeFile(logPath, content, 'utf8');
  }

  console.log(`Iteration log saved: ${logPath}`);
  return logPath;
}

// Generate a full action sheet: ALL daily items from TOP20 people, grouped by topic.
// This is the "complete picture" — the daily report is a curated subset of this sheet.
async function generateActionSheet(allDailyItems, top20) {
  const nameMap = new Map(top20.map((p) => [normalizeHandle(p.handle), p.name || p.handle]));
  const top20Handles = new Set(top20.map((p) => normalizeHandle(p.handle)));

  // Group items by topic
  const topicGroups = new Map();

  for (const item of allDailyItems) {
    const handle = normalizeHandle(extractHandleFromItem(item));
    if (!handle || !top20Handles.has(handle)) continue;

    const text = extractTextFromItem(item);
    const url = item?.url || item?.tweetUrl || item?.link || '';
    const createdAt = item?.createdAt || item?.created_at || item?.date || '';
    const dateStr = typeof createdAt === 'string' ? createdAt.slice(0, 16) : '';
    const name = nameMap.get(handle) || handle;
    const topics = classifyHotspots(text);

    const entry = {
      name,
      handle,
      text: text.replace(/\n/g, ' ').slice(0, 200),
      url,
      date: dateStr,
    };

    for (const topic of topics) {
      if (!topicGroups.has(topic)) topicGroups.set(topic, []);
      topicGroups.get(topic).push(entry);
    }
  }

  // Sort topics by action count descending
  const sortedTopics = Array.from(topicGroups.entries())
    .sort((a, b) => b[1].length - a[1].length);

  // Generate Markdown
  const mdSections = sortedTopics.map(([topic, entries]) => {
    const uniquePeople = new Set(entries.map((e) => e.name));
    const header = `### ${topic}（${entries.length}条动态，${uniquePeople.size}人参与）\n`;
    const rows = entries.map((e) => {
      const link = e.url ? `[链接](${e.url})` : '无链接';
      return `- **${e.name}**（@${e.handle}）${e.date ? `| ${e.date}` : ''}\n  ${e.text}… ${link}`;
    });
    return header + rows.join('\n');
  });

  const totalActions = allDailyItems.filter((item) => top20Handles.has(normalizeHandle(extractHandleFromItem(item)))).length;
  const mdContent = `# TOP20 人物全量 Action Sheet\n\n> 共 ${totalActions} 条动态，覆盖 ${sortedTopics.length} 个话题领域\n> 日报内容是本表的子集与拓展\n\n${mdSections.join('\n\n')}\n`;

  // Generate CSV
  const csvHeader = 'topic,name,handle,date,text,url';
  const csvRows = sortedTopics.flatMap(([topic, entries]) =>
    entries.map((e) => {
      const escapeCsv = (s) => `"${String(s || '').replaceAll('"', '""')}"`;
      return [escapeCsv(topic), escapeCsv(e.name), escapeCsv(e.handle), escapeCsv(e.date), escapeCsv(e.text), escapeCsv(e.url)].join(',');
    }),
  );
  const csvContent = `${csvHeader}\n${csvRows.join('\n')}\n`;

  await fs.writeFile('artifacts/top20-action-sheet.md', mdContent, 'utf8');
  await fs.writeFile('artifacts/top20-action-sheet.csv', csvContent, 'utf8');
  console.log(`Action sheet saved: ${sortedTopics.length} topics, ${totalActions} total actions`);

  return { mdPath: 'artifacts/top20-action-sheet.md', csvPath: 'artifacts/top20-action-sheet.csv' };
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
  const tomorrow = formatBjtDateDaysAgo(-1);
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

  // We want BJT "today + yesterday". Since Twitter since/until is UTC-date based,
  // we query a slightly broader window then apply precise BJT-date filtering locally.
  const dailyTargetSince = yesterday;
  const dailyTargetUntil = tomorrow; // exclusive: include yesterday and today
  const dailyQuerySince = formatBjtDateDaysAgo(2);
  const dailyQueryUntil = tomorrow;
  const dailyInput = buildApifyInput(templateInput, top20.map((p) => p.handle), dailyQuerySince, dailyQueryUntil, 1000);
  if (top20.length > 0) {
    console.log(
      `Example daily searchTerm: from:${top20[0].handle} since:${dailyQuerySince} until:${dailyQueryUntil} (target BJT range: [${dailyTargetSince}, ${dailyTargetUntil}))`,
    );
  }
  const dailyFromWeekly = selectDailyItemsFromWeekly({
    weeklyItems,
    top20Handles: top20.map((p) => p.handle),
    dailySince: dailyTargetSince,
    dailyUntil: dailyTargetUntil,
  });
  const enableSkipSecondFetch = parseBooleanEnv(process.env.APIFY_SKIP_SECOND_FETCH_IF_SUFFICIENT, true);
  const dailyMinItems = Number(process.env.APIFY_DAILY_MIN_ITEMS || 80);
  const maxMissingHandles = Number(process.env.APIFY_DAILY_MAX_MISSING_TOP20 || 8);
  const dailyMinAiItems = Number(process.env.APIFY_DAILY_MIN_AI_ITEMS || 30);
  const dailyMinAiHandles = Number(process.env.APIFY_DAILY_MIN_AI_HANDLES || 8);
  const enoughByWeekly = shouldSkipSecondDailyFetch({
    candidateItems: dailyFromWeekly,
    top20,
    maxMissingHandles: Number.isFinite(maxMissingHandles) ? Math.max(0, Math.floor(maxMissingHandles)) : 8,
    minItems: Number.isFinite(dailyMinItems) ? Math.max(1, Math.floor(dailyMinItems)) : 80,
  });
  const weeklyAiCoverage = getDailyAiCoverage(dailyFromWeekly);
  const enoughAiCoverage = weeklyAiCoverage.aiCount >= (Number.isFinite(dailyMinAiItems) ? Math.max(1, Math.floor(dailyMinAiItems)) : 30)
    && weeklyAiCoverage.aiHandleCount >= (Number.isFinite(dailyMinAiHandles) ? Math.max(1, Math.floor(dailyMinAiHandles)) : 8);
  console.log(
    `Daily weekly-subset coverage: total=${dailyFromWeekly.length}, ai=${weeklyAiCoverage.aiCount}, aiHandles=${weeklyAiCoverage.aiHandleCount}, threshold(total>=${dailyMinItems}, ai>=${dailyMinAiItems}, aiHandles>=${dailyMinAiHandles})`,
  );

  let dailyItems;
  if (enableSkipSecondFetch && enoughByWeekly && enoughAiCoverage) {
    dailyItems = dailyFromWeekly;
    console.log(`Daily fetch skipped: reused weekly subset (${dailyItems.length} items, top20=${top20.length})`);
  } else {
    const daily = await runApify(dailyInput);
    dailyItems = mergeUniqueItems(dailyFromWeekly, daily.items);
    console.log(`Daily fetched via Apify and merged: weeklySubset=${dailyFromWeekly.length}, fetched=${daily.items.length}, merged=${dailyItems.length}`);
  }
  dailyItems = filterItemsByBjtDateRange(dailyItems, dailyTargetSince, dailyTargetUntil);
  console.log(`Daily items after precise BJT date filter [${dailyTargetSince}, ${dailyTargetUntil}): ${dailyItems.length}`);

  const aiRelatedDaily = dailyItems.filter(isAiRelatedItem);
  console.log(`Daily items: ${dailyItems.length}, AI-related: ${aiRelatedDaily.length}`);

  // Generate full action sheet (ALL daily items from TOP20, grouped by topic)
  // This runs independently and doesn't affect the daily report pipeline
  await generateActionSheet(dailyItems, top20);

  const hotspotStats = getHotspotStats(aiRelatedDaily);
  const dailyPeopleStats = getDailyPeopleStats(aiRelatedDaily);

  const report = await generateReport(aiRelatedDaily, top20, hotspotStats, dailyPeopleStats);
  await fs.writeFile('artifacts/daily-report.md', report, 'utf8');

  // Cross-validate with Chinese AI media and save iteration log
  const apiKey = requireEnv('GEMINI_API_KEY');
  const model = requireEnv('GEMINI_MODEL');
  const crossValidation = await crossValidateWithMedia({ apiKey, model, reportMarkdown: report });
  if (crossValidation) {
    await saveIterationLog({ crossValidation, date: today });
  }

  await sendEmail(report);
  console.log('Daily report generated and emailed successfully.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
