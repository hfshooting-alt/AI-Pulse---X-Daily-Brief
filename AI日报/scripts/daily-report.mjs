import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { marked } from 'marked';

const ARTIFACT_DIR = path.resolve('artifacts');
const DEFAULT_HISTORY_PATH = path.join(ARTIFACT_DIR, 'twitter-history.json');
const TWITTER_LAST_TWEETS_URL = 'https://api.twitterapi.io/twitter/user/last_tweets';

function env(name, defaultValue = '') {
  const value = process.env[name]?.trim();
  return value || defaultValue;
}

function requireEnv(name) {
  const value = env(name);
  if (!value) throw new Error(`缺少必要环境变量：${name}`);
  return value;
}

function toInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function normalizeHandle(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase();
}

function parsePeople() {
  const rawJson = env('TWITTER_PEOPLE_JSON');
  if (rawJson) {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) throw new Error('TWITTER_PEOPLE_JSON 必须是数组');
    return parsed
      .map((item) => {
        if (typeof item === 'string') return { handle: normalizeHandle(item), name: item, title: '', description: '' };
        const handle = normalizeHandle(item.handle || item.username || item.twitter || item.x || item.id);
        return {
          handle,
          userId: item.userId || item.user_id || item.twitterUserId || '',
          name: String(item.name || item.displayName || handle).trim(),
          title: String(item.title || item.role || item.position || '').trim(),
          description: String(item.description || item.desc || item.bio || item.note || '').trim(),
        };
      })
      .filter((item) => item.handle);
  }

  return env('TWITTER_HANDLES')
    .split(/[\n,\s]+/)
    .map(normalizeHandle)
    .filter(Boolean)
    .map((handle) => ({ handle, userId: '', name: handle, title: '', description: '' }));
}


async function fetchJson(url, options, label) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} 请求失败：${response.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function fetchTweets({ people, lookbackHours, maxTweets, label, startTime }) {
  if (people.length === 0) return [];
  const apiKey = requireEnv('TWITTERAPI_API_KEY');
  const windowStartMs = parseDateMs(startTime) || Date.now() - lookbackHours * 60 * 60 * 1000;
  const includeReplies = env('TWITTER_INCLUDE_REPLIES', 'true').toLowerCase() !== 'false';
  const perUserMax = Math.max(20, Math.ceil(maxTweets / Math.max(people.length, 1)) + 20);
  const tweetsById = new Map();

  for (const person of people) {
    let cursor = '';
    let fetchedForUser = 0;
    let reachedWindowStart = false;

    do {
      const url = new URL(TWITTER_LAST_TWEETS_URL);
      if (person.userId) url.searchParams.set('userId', person.userId);
      else url.searchParams.set('userName', person.handle);
      url.searchParams.set('includeReplies', String(includeReplies));
      if (cursor) url.searchParams.set('cursor', cursor);

      const data = await fetchJson(
        url,
        { headers: { 'X-API-Key': apiKey } },
        `TwitterAPI.io ${label} last_tweets (@${person.handle})`,
      );
      if (data.status && data.status !== 'success') throw new Error(`TwitterAPI.io 返回错误：${data.message || data.status}`);

      const normalizedTweets = normalizeTweets(data, new Map([[person.handle, person]]));
      for (const tweet of normalizedTweets) {
        const createdMs = parseDateMs(tweet.createdAt);
        if (createdMs && createdMs < windowStartMs) reachedWindowStart = true;
        if (createdMs >= windowStartMs && tweet.id) {
          tweetsById.set(tweet.id, tweet);
          fetchedForUser += 1;
        }
      }

      cursor = data.has_next_page ? data.next_cursor || '' : '';
    } while (cursor && !reachedWindowStart && fetchedForUser < perUserMax);
  }

  return [...tweetsById.values()]
    .sort((a, b) => parseDateMs(b.createdAt) - parseDateMs(a.createdAt))
    .slice(0, maxTweets);
}

function parseDateMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function getHistoryPath() {
  return path.resolve(env('TWITTER_HISTORY_PATH', DEFAULT_HISTORY_PATH));
}

async function loadTweetHistory(historyPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(historyPath, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.tweets)) return parsed.tweets;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`历史缓存读取失败，将从空缓存开始：${error.message}`);
  }
  return [];
}

function mergeTweets(...tweetLists) {
  const map = new Map();
  for (const tweet of tweetLists.flat()) {
    if (tweet?.id) map.set(String(tweet.id), tweet);
  }
  return [...map.values()].sort((a, b) => parseDateMs(b.createdAt) - parseDateMs(a.createdAt));
}

function filterTweetsByPeopleAndWindow(tweets, people, lookbackHours) {
  const handles = new Set(people.map((person) => person.handle));
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
  return tweets.filter((tweet) => handles.has(normalizeHandle(tweet.handle)) && parseDateMs(tweet.createdAt) >= cutoff);
}

function getIncrementalStartTime(cachedTweets, lookbackHours) {
  const fullWindowStart = Date.now() - lookbackHours * 60 * 60 * 1000;
  if (env('TWITTER_FORCE_FULL_FETCH').toLowerCase() === 'true' || cachedTweets.length === 0) {
    return new Date(fullWindowStart).toISOString();
  }

  const cachedTimes = cachedTweets.map((tweet) => parseDateMs(tweet.createdAt)).filter(Boolean);
  if (cachedTimes.length === 0) return new Date(fullWindowStart).toISOString();

  const newestCachedMs = Math.max(...cachedTimes);
  // 回退 5 分钟，避免边界时间或分页导致漏抓。
  const incrementalStart = Math.max(fullWindowStart, newestCachedMs - 5 * 60 * 1000);
  return new Date(incrementalStart).toISOString();
}

async function getWeeklyTweetsWithHistory(people, lookbackHours, maxTweets) {
  const historyPath = getHistoryPath();
  const oldHistory = await loadTweetHistory(historyPath);
  const cachedWeekly = filterTweetsByPeopleAndWindow(oldHistory, people, lookbackHours);
  const startTime = getIncrementalStartTime(cachedWeekly, lookbackHours);

  const cachedHandles = new Set(cachedWeekly.map((tweet) => normalizeHandle(tweet.handle)));
  const missingPeople = people.filter((person) => !cachedHandles.has(person.handle));
  console.log(`历史缓存：${oldHistory.length} 条；近 ${lookbackHours} 小时可复用 ${cachedWeekly.length} 条；本次从 ${startTime} 增量抓取。`);

  const incrementalTweets = await fetchTweets({ people, lookbackHours, maxTweets, label: 'weekly-incremental', startTime });
  const backfillTweets = missingPeople.length > 0 && env('TWITTER_FORCE_FULL_FETCH').toLowerCase() !== 'true'
    ? await fetchTweets({ people: missingPeople, lookbackHours, maxTweets, label: 'weekly-backfill-missing-handles' })
    : [];
  if (missingPeople.length > 0) console.log(`缓存中缺少 ${missingPeople.length} 个账号，已为这些账号补抓完整窗口。`);

  const freshTweets = mergeTweets(incrementalTweets, backfillTweets);
  const weeklyTweets = mergeTweets(cachedWeekly, freshTweets).slice(0, maxTweets);
  const keepHours = Math.max(lookbackHours, toInt(env('REPORT_LOOKBACK_HOURS'), 24)) + 6;
  const nextHistory = filterTweetsByPeopleAndWindow(mergeTweets(oldHistory, freshTweets), people, keepHours);

  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(historyPath, `${JSON.stringify({ updatedAt: new Date().toISOString(), tweets: nextHistory }, null, 2)}\n`, 'utf8');
  console.log(`历史缓存已更新：${historyPath}（保留 ${nextHistory.length} 条）`);

  return { weeklyTweets, historyTweets: nextHistory, historyPath };
}

function normalizeTweets(data, peopleByHandle) {
  return (data.tweets || [])
    .filter((tweet) => tweet && tweet.type !== 'retweet' && !tweet.retweeted_tweet)
    .map((tweet) => {
      const author = tweet.author || {};
      const handle = normalizeHandle(author.userName || author.username || tweet.userName || tweet.username);
      const person = peopleByHandle.get(handle) || { handle, name: author.name || handle, title: '', description: author.description || '' };
      const quotedAuthor = tweet.quoted_tweet?.author || tweet.quotedTweet?.author || {};
      const referencedTweets = [];
      if (tweet.isReply && tweet.inReplyToId) {
        referencedTweets.push({ type: 'replied_to', id: String(tweet.inReplyToId), authorHandle: normalizeHandle(tweet.inReplyToUsername) });
      }
      if ((tweet.quoted_tweet || tweet.quotedTweet) && (tweet.quoted_tweet?.id || tweet.quotedTweet?.id)) {
        referencedTweets.push({
          type: 'quoted',
          id: String(tweet.quoted_tweet?.id || tweet.quotedTweet?.id),
          authorHandle: normalizeHandle(quotedAuthor.userName || quotedAuthor.username),
        });
      }

      return {
        id: String(tweet.id || ''),
        url: tweet.url || `https://twitter.com/${handle}/status/${tweet.id}`,
        text: tweet.text || '',
        createdAt: tweet.createdAt || '',
        author: person.name || author.name || handle,
        handle,
        title: person.title || '',
        description: person.description || author.description || '',
        metrics: {
          like_count: tweet.likeCount || 0,
          retweet_count: tweet.retweetCount || 0,
          reply_count: tweet.replyCount || 0,
          quote_count: tweet.quoteCount || 0,
          view_count: tweet.viewCount || 0,
          bookmark_count: tweet.bookmarkCount || 0,
        },
        referencedTweets,
        mentions: (tweet.entities?.user_mentions || tweet.entities?.mentions || [])
          .map((mention) => normalizeHandle(mention.screen_name || mention.username || mention.userName))
          .filter(Boolean),
        conversationId: tweet.conversationId || '',
      };
    })
    .filter((tweet) => tweet.id && tweet.handle && tweet.createdAt);
}

function scoreTweet(tweet) {
  const m = tweet.metrics || {};
  return (m.like_count || 0) + (m.retweet_count || 0) * 2 + (m.reply_count || 0) * 2 + (m.quote_count || 0) * 3;
}

function analyzeInteractions(tweets, handleSet) {
  const interactions = new Map();
  const ensure = (handle) => {
    if (!interactions.has(handle)) {
      interactions.set(handle, { repliedTo: new Set(), quoted: new Set(), mentioned: new Set(), quotedBy: new Set(), mentionedBy: new Set() });
    }
    return interactions.get(handle);
  };

  for (const tweet of tweets) {
    const author = normalizeHandle(tweet.handle);
    if (!author || !handleSet.has(author)) continue;

    for (const ref of tweet.referencedTweets || []) {
      const target = normalizeHandle(ref.authorHandle);
      if (!target || target === author || !handleSet.has(target)) continue;
      if (ref.type === 'replied_to') {
        ensure(author).repliedTo.add(target);
        ensure(target).mentionedBy.add(author);
      }
      if (ref.type === 'quoted') {
        ensure(author).quoted.add(target);
        ensure(target).quotedBy.add(author);
      }
    }

    for (const target of tweet.mentions || []) {
      if (target !== author && handleSet.has(target)) {
        ensure(author).mentioned.add(target);
        ensure(target).mentionedBy.add(author);
      }
    }
  }

  return interactions;
}

function rankPeople(tweets, roster) {
  const counts = tweets.reduce((map, tweet) => {
    const handle = normalizeHandle(tweet.handle);
    return handle ? map.set(handle, (map.get(handle) || 0) + 1) : map;
  }, new Map());
  const handleSet = new Set(roster.map((person) => person.handle));
  const interactions = analyzeInteractions(tweets, handleSet);
  const meta = new Map(roster.map((person) => [person.handle, person]));

  return [...counts.entries()]
    .map(([handle, outputCount]) => {
      const inter = interactions.get(handle);
      const peersEngaged = inter ? new Set([...inter.repliedTo, ...inter.quoted, ...inter.mentioned, ...inter.quotedBy, ...inter.mentionedBy]).size : 0;
      // 五维度互动加权：被引用 1.5、主动引用 1.2、回复 1.0、被提及 0.8、主动提及 0.5。
      const interactionScore = inter
        ? inter.quotedBy.size * 1.5 + inter.quoted.size * 1.2 + inter.repliedTo.size * 1.0 + inter.mentionedBy.size * 0.8 + inter.mentioned.size * 0.5
        : 0;
      const person = meta.get(handle) || { handle };
      return {
        name: person.name || handle,
        title: person.title || '',
        description: person.description || '',
        handle,
        outputCount,
        interactionScore: Math.round(interactionScore * 10) / 10,
        peersEngaged,
        compositeScore: Math.round((outputCount + interactionScore * 2) * 10) / 10,
      };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore || b.outputCount - a.outputCount || a.handle.localeCompare(b.handle));
}

const HOTSPOT_RULES = [
  { label: '机器人与具身智能', en: ['robot', 'humanoid', 'optimus', 'embodied'], cn: ['机器人', '具身'] },
  { label: '算力与芯片', en: ['nvidia', 'gpu', 'chip', 'tpu', 'compute', 'hardware'], cn: ['算力', '芯片'] },
  { label: '多模态与视觉', en: ['multimodal', 'vision', 'image', 'video', 'diffusion', 'sora', 'ocr'], cn: ['多模态', '视觉', '图像', '视频'] },
  { label: '安全与治理', en: ['safety', 'alignment', 'regulation', 'governance', 'policy', 'ethics', 'risk'], cn: ['安全', '对齐', '监管', '治理'] },
  { label: '开源与社区', en: ['open source', 'opensource', 'huggingface', 'community', 'weights'], cn: ['开源', '社区', '权重'] },
  { label: 'Agent与自动化', en: ['agent', 'workflow', 'automation', 'mcp', 'tool use', 'function calling'], cn: ['智能体', '自动化', 'agent'] },
  { label: '开发工具与编程', en: ['coding', 'copilot', 'cursor', 'windsurf', 'devin', 'ide', 'vscode', 'developer'], cn: ['编程', '开发工具', '代码'] },
  { label: '产品发布与商业化', en: ['launch', 'release', 'pricing', 'funding', 'startup', 'revenue', 'customers'], cn: ['融资', '发布', '定价', '商业化', '上线'] },
  { label: '模型与推理能力', en: ['llm', 'inference', 'gpt', 'gemini', 'llama', 'mistral', 'reasoning', 'benchmark'], cn: ['大模型', '推理'] },
];

function classifyHotspots(text) {
  const lower = String(text || '').toLowerCase();
  const labels = HOTSPOT_RULES
    .filter((rule) => rule.cn.some((kw) => lower.includes(kw.toLowerCase())) || rule.en.some((kw) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)))
    .map((rule) => rule.label);
  return labels.length > 0 ? labels : ['其他AI动态'];
}


function extractHandleFromItem(item) {
  return normalizeHandle(item?.handle || item?.username || item?.author?.username || item?.author?.userName);
}

function extractTextFromItem(item) {
  return String(item?.text || item?.fullText || item?.full_text || item?.tweetText || '').trim();
}

function extractUrlFromItem(item) {
  return String(item?.url || item?.tweetUrl || item?.link || '').trim();
}

function getItemThreadKey(item) {
  const referenced = Array.isArray(item?.referencedTweets)
    ? item.referencedTweets.map((ref) => ref?.id).filter(Boolean).join(':')
    : '';
  return item?.conversationId || referenced || item?.id || extractTextFromItem(item).replace(/https?:\/\/\S+/g, '').slice(0, 80) || 'unknown-thread';
}

function isAiRelatedItem(item) {
  const text = extractTextFromItem(item);
  if (!text) return false;
  const lower = text.toLowerCase();
  const cnStrong = ['人工智能', '大模型', '智能体', '机器学习', '深度学习', '神经网络'];
  if (cnStrong.some((kw) => lower.includes(kw))) return true;

  const enStrong = [
    'openai', 'anthropic', 'deepmind', 'midjourney', 'hugging face', 'huggingface',
    'llm', 'gpt', 'chatgpt', 'gemini', 'claude', 'llama', 'mistral', 'copilot',
    'artificial intelligence', 'machine learning', 'deep learning', 'neural network',
    'transformer', 'diffusion model', 'foundation model', 'large language model',
    'grok', 'xai', 'deepseek', 'qwen', 'cursor', 'windsurf', 'devin', 'sora',
    'stable diffusion', 'perplexity', 'cohere', 'inflection', 'character.ai',
  ];
  if (enStrong.some((kw) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))) return true;

  let weakHits = 0;
  for (const kw of ['推理', '算力', '芯片', '训练']) if (lower.includes(kw)) weakHits += 1;
  for (const kw of ['ai', 'model', 'agent', 'training', 'inference', 'robot', 'nvidia', 'gpu', 'chip', 'benchmark', 'reasoning', 'embedding', 'token', 'prompt', 'rlhf', 'alignment']) {
    if (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) weakHits += 1;
  }
  return weakHits >= 2;
}

function getHotspotStats(items) {
  const topicMap = new Map();
  const groupedSignals = new Set();
  for (const item of items) {
    const labels = classifyHotspots(extractTextFromItem(item));
    const handle = extractHandleFromItem(item) || 'unknown';
    const threadKey = getItemThreadKey(item);
    for (const label of labels) {
      if (!topicMap.has(label)) topicMap.set(label, { participants: new Set(), interactionGroups: new Set(), rawCount: 0 });
      const entry = topicMap.get(label);
      entry.rawCount += 1;
      entry.participants.add(handle);
      entry.interactionGroups.add(`${handle}::${threadKey}`);
      groupedSignals.add(`${label}::${handle}::${threadKey}`);
    }
  }
  const hotspots = [...topicMap.entries()].map(([label, entry]) => ({
    label,
    participantCount: entry.participants.size,
    participants: [...entry.participants],
    interactionGroupCount: entry.interactionGroups.size,
    count: entry.rawCount,
  })).sort((a, b) => b.participantCount - a.participantCount || b.interactionGroupCount - a.interactionGroupCount || b.count - a.count);
  return { actionCount: items.length, groupedSignalCount: groupedSignals.size, hotspotCount: hotspots.length, hotspots };
}

function textSimilarity(textA, textB) {
  const bigrams = (text) => {
    const words = String(text || '').replace(/https?:\/\/\S+/g, '').replace(/[^\w\u4e00-\u9fff]+/g, ' ').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const result = new Set();
    for (let i = 0; i < words.length - 1; i += 1) result.add(`${words[i]} ${words[i + 1]}`);
    return result;
  };
  const a = bigrams(textA);
  const b = bigrams(textB);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function buildPromptItems(items) {
  const threadDeduped = new Map();
  for (const item of items) {
    const key = `${extractHandleFromItem(item) || 'unknown'}::${getItemThreadKey(item)}`;
    if (!threadDeduped.has(key)) threadDeduped.set(key, item);
  }

  const perPerson = new Map();
  for (const item of threadDeduped.values()) {
    const handle = extractHandleFromItem(item) || 'unknown';
    if (!perPerson.has(handle)) perPerson.set(handle, []);
    perPerson.get(handle).push(item);
  }

  const result = [];
  for (const personItems of perPerson.values()) {
    personItems.sort((a, b) => extractTextFromItem(b).length - extractTextFromItem(a).length);
    const kept = [];
    for (const item of personItems) {
      const text = extractTextFromItem(item);
      if (!kept.some((keptItem) => textSimilarity(extractTextFromItem(keptItem), text) > 0.5)) kept.push(item);
    }
    result.push(...kept);
  }
  return result;
}

function getPromptTemplate() {
  return `你是一个专业的AI行业分析师和情报Agent。请根据提供的原始动态数据生成日报。\n\n# AI Pulse - X Daily Brief\n\n## 聚类核心规则（必须遵守）\n- 先逐条判断每条动态的具体主题（例如“Claude 4发布”、“GPU供应链紧张”、“Cursor融资”等具体事件），而不是直接按预设大类归并。\n- 然后将主题相同或高度相关的动态聚类为一个“事件”。\n- 每个事件的热度 = 涉及的不同人数（participantCount），即有多少个不同的人讨论了这个具体事件。\n- 同一个人发多条推文/引用/回复关于同一事件，只算1个参与者，并在相关动态里合并描述。\n- 提供的话题统计仅作宏观参考，不要直接用其分类结果，请你独立从数据中发现具体事件。\n- 输出中不要显示参与人数、participantCount 等统计数字，只用于排序。\n\n## 输出格式（严格遵守）\n\n## TOP3 热度事件\n\n1. 事件标题A\n   - **热点解析：** 至少3句话，说明发生了什么、为什么热、对行业的意义。\n   - **相关动态：**\n     - [@本名](url): 动态描述…\n     - [@本名](url): 动态描述…\n     - [@本名](url): 动态描述…\n\n2. 事件标题B\n   - **热点解析：** …\n   - **相关动态：**\n     - [@本名](url): 动态描述…\n\n3. 事件标题C\n   - **热点解析：** …\n   - **相关动态：**\n     - [@本名](url): 动态描述…\n\n## 中热度话题\n\n### Topic标题A\n1. 事件标题X\n   - **热点解析：** …\n   - **相关动态：**\n     - [@本名](url): 动态描述…\n\n### Topic标题B\n1. 事件标题Y\n   - **热点解析：** …\n   - **相关动态：**\n     - [@本名](url): 动态描述…\n\n## 通用规则\n- 不需要按传统行业大类分类，请根据数据内容自行发现具体事件。\n- TOP3 选参与人数最多的3个具体事件；中热度话题选剩余4-8个次要事件，分成2-4个Topic。\n- 事件总数量宜多不宜少；允许只有1个来源的事件单独列出，但必须有明确的信息价值。\n- 关联动态中的来源链接统一写成 [@本名](url)，不要写“查看原帖”。\n- 每条相关动态都必须包含来源链接；没有来源链接的动态不要输出。\n- 不要输出“额外观察”“AI大厂与投资机构资讯”板块。\n- 不要输出 Today's Summary 板块，Summary 将在报告生成后单独生成。\n- 输出 Markdown，结构清晰，分级列表明确。`;
}

async function requestGeminiReport({ apiKey, model, prompt }) {
  const cleanModel = model.replace(/^models\//, '');
  const temperature = Number(env('GEMINI_TEMPERATURE', '0.3'));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature } }),
  }, 'Gemini');
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n').trim();
  if (!text) throw new Error(`Gemini 没有返回正文：${JSON.stringify(data).slice(0, 500)}`);
  return text;
}

function relabelSourceLinksWithRealNames(markdown, people) {
  const map = new Map((people || []).map((person) => [normalizeHandle(person.handle), person.name || person.handle]));
  return String(markdown || '').replace(/\[查看原帖\]\((https?:\/\/[^)]+)\)/g, (_, url) => {
    const handle = normalizeHandle(String(url).match(/(?:x|twitter)\.com\/([^/\s?#]+)/i)?.[1] || '');
    const name = map.get(handle);
    return name ? `[@${name}](${url})` : `[@${handle || '来源'}](${url})`;
  });
}

function normalizeMarkdownLayout(markdown) {
  return String(markdown || '')
    .replace(/\r\n/g, '\n')
    .replace(/^#{1}\s+AI Pulse - X Daily Brief\s*\n?/im, '# AI Pulse - X Daily Brief\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractSection(text, startPattern, endPattern) {
  const source = String(text || '');
  const startMatch = source.match(startPattern);
  if (!startMatch) return '';
  const rest = source.slice(startMatch.index + startMatch[0].length);
  const endMatch = rest.match(endPattern);
  return endMatch ? rest.slice(0, endMatch.index) : rest;
}

function analyzeReportStructure(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  const top3Section = extractSection(text, /^##\s*(?:[一二三四五六七八九十\d]*[、.．]\s*)?(?:TOP\s*3|前三|三大)[^\n]*\n?/im, /^##\s+/im);
  const secondarySection = extractSection(text, /^##\s*(?:[一二三四五六七八九十\d]*[、.．]\s*)?中热度[^\n]*\n?/im, /^##\s*(?:TOP20|Today|今日总结)/im);
  return {
    top3EventCount: (top3Section.match(/^\d+\.\s+/gm) || []).length,
    secondaryEventCount: (secondarySection.match(/^\d+\.\s+/gm) || []).length,
    sourceLinkCount: (text.match(/\[@[^\]]+\]\(https?:\/\/[^)]+\)/g) || []).length,
  };
}

function isStructureWeak(structure) {
  return structure.top3EventCount + structure.secondaryEventCount === 0 || structure.sourceLinkCount === 0;
}

function buildFallbackReportFromItems(items, top20) {
  const nameMap = new Map((top20 || []).map((person) => [normalizeHandle(person.handle), person.name || person.handle]));
  const topicBuckets = new Map();
  for (const item of items || []) {
    const handle = extractHandleFromItem(item);
    const text = extractTextFromItem(item).replace(/\s+/g, ' ').trim();
    const url = extractUrlFromItem(item);
    if (!handle || !text || !url) continue;
    const labels = classifyHotspots(text);
    let topic = labels[0] || '其他AI动态';
    for (const label of labels) {
      if ((topicBuckets.get(label)?.length || 0) < (topicBuckets.get(topic)?.length || 0)) topic = label;
    }
    if (!topicBuckets.has(topic)) topicBuckets.set(topic, []);
    if (!topicBuckets.get(topic).some((entry) => entry.handle === handle)) {
      topicBuckets.get(topic).push({ handle, name: nameMap.get(handle) || handle, text: text.slice(0, 150), url });
    }
  }
  const events = [...topicBuckets.entries()].sort((a, b) => b[1].length - a[1].length).map(([topic, entries]) => ({ topic, entries }));
  const block = (event, index) => `${index}. ${event.topic}\n   - **热点解析：** ${event.topic}方向今日有${event.entries.length}位活跃账号发布相关动态，建议结合原文判断对业务的影响。\n   - **相关动态：**\n${event.entries.slice(0, 5).map((entry) => `     - [@${entry.name}](${entry.url}): ${entry.text}`).join('\n')}`;
  return `# AI Pulse - X Daily Brief\n\n## TOP3 热度事件\n\n${events.slice(0, 3).map(block).join('\n\n') || '暂无足够数据生成热度事件。'}\n\n## 中热度话题\n\n${events.slice(3, 9).map((event, index) => `### ${event.topic}\n\n${block(event, index + 1)}`).join('\n\n') || '暂无中热度话题。'}\n`;
}

async function generateSummary({ apiKey, model, reportMarkdown }) {
  const prompt = `你是一个专业的AI行业分析师。以下是今天生成的AI日报内容，请根据日报内容撰写一段 Today's Summary。\n\n要求：\n- 用 ## Today's Summary 作为独立的二级标题\n- 必须使用中文撰写，不要使用英文\n- 内容用一个自然段完成（不分点，不超过200字）\n- 概括今天日报中最重要的趋势和事件\n- 只输出 ## Today's Summary 部分，不要输出其他内容\n\n日报内容：\n${reportMarkdown}`;
  return requestGeminiReport({ apiKey, model, prompt });
}

async function loadPromptRules() {
  try {
    return (await fs.readFile('prompt-rules.md', 'utf8')).trim();
  } catch {
    return '';
  }
}

function getPeopleStats(tweets) {
  const stats = new Map();
  for (const tweet of tweets) {
    const handle = normalizeHandle(tweet.handle);
    if (!stats.has(handle)) stats.set(handle, { actionCount: 0, hotspots: new Set() });
    const entry = stats.get(handle);
    entry.actionCount += 1;
    classifyHotspots(tweet.text).forEach((label) => entry.hotspots.add(label));
  }
  return stats;
}

async function writeRankingArtifacts(ranking, top20) {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  const header = '| 排名 | 本名 | X账号 | 近一周动态数量 | 互动分 | 同行互动数 | 综合分 |\n|---:|---|---|---:|---:|---:|---:|';
  const rows = ranking.map((p, i) => `| ${i + 1} | ${p.name} | @${p.handle} | ${p.outputCount} | ${p.interactionScore} | ${p.peersEngaged} | ${p.compositeScore} |`);
  const csvRows = ranking.map((p, i) => [i + 1, p.name, p.handle, p.outputCount, p.interactionScore, p.peersEngaged, p.compositeScore].map(csvCell).join(','));

  await fs.writeFile(path.join(ARTIFACT_DIR, 'ai-weekly-output-counts.md'), `${header}\n${rows.join('\n')}\n`, 'utf8');
  await fs.writeFile(path.join(ARTIFACT_DIR, 'ai-weekly-output-counts.csv'), `rank,name,handle,weekly_output_count,interaction_score,peers_engaged,composite_score\n${csvRows.join('\n')}\n`, 'utf8');
  await fs.writeFile(path.join(ARTIFACT_DIR, 'top20-ranking.json'), `${JSON.stringify(top20, null, 2)}\n`, 'utf8');
}

async function writeActionSheet(tweets, top20) {
  const top20Handles = new Set(top20.map((person) => person.handle));
  const nameMap = new Map(top20.map((person) => [person.handle, person.name || person.handle]));
  const topicGroups = new Map();

  for (const tweet of tweets.filter((item) => top20Handles.has(item.handle))) {
    for (const topic of classifyHotspots(tweet.text)) {
      if (!topicGroups.has(topic)) topicGroups.set(topic, []);
      topicGroups.get(topic).push({
        topic,
        name: nameMap.get(tweet.handle) || tweet.handle,
        handle: tweet.handle,
        date: tweet.createdAt.slice(0, 16),
        text: tweet.text.replace(/\s+/g, ' ').slice(0, 240),
        url: tweet.url,
      });
    }
  }

  const sortedTopics = [...topicGroups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const mdSections = sortedTopics.map(([topic, entries]) => {
    const peopleCount = new Set(entries.map((entry) => entry.handle)).size;
    const rows = entries.map((entry) => `- **${entry.name}**（@${entry.handle}）${entry.date ? `| ${entry.date}` : ''}\n  ${entry.text}… [链接](${entry.url})`);
    return `### ${topic}（${entries.length}条动态，${peopleCount}人参与）\n${rows.join('\n')}`;
  });
  const dailyTop20Count = tweets.filter((tweet) => top20Handles.has(tweet.handle)).length;
  const markdown = `# TOP20 人物全量 Action Sheet\n\n> 共 ${dailyTop20Count} 条动态，覆盖 ${sortedTopics.length} 个话题领域。\n> 日报正文是本表的子集与提炼。\n\n${mdSections.join('\n\n')}\n`;
  const csvRows = sortedTopics.flatMap(([, entries]) => entries.map((entry) => [entry.topic, entry.name, entry.handle, entry.date, entry.text, entry.url].map(csvCell).join(',')));

  await fs.writeFile(path.join(ARTIFACT_DIR, 'top20-action-sheet.md'), markdown, 'utf8');
  await fs.writeFile(path.join(ARTIFACT_DIR, 'top20-action-sheet.csv'), `topic,name,handle,date,text,url\n${csvRows.join('\n')}\n`, 'utf8');
}

function appendTop20Appendix(markdown, top20, peopleStats) {
  const rows = top20.map((person) => {
    const stat = peopleStats.get(person.handle) || { actionCount: 0, hotspots: new Set() };
    const title = person.title || 'AI从业者';
    const description = person.description ? `：${person.description}` : '';
    const peerInfo = person.peersEngaged > 0 ? `，与 ${person.peersEngaged} 位同行互动` : '';
    return `- ${person.name}（@${person.handle}）| ${title}${description} | 今日 action 数量：${stat.actionCount}，涉及 ${stat.hotspots.size} 个热点${peerInfo}。`;
  }).join('\n');
  return `${markdown.trim()}\n\n## TOP20 活跃人物\n\n${rows}\n`;
}

async function generateReport(items, top20, stats, peopleStats) {
  if (!Array.isArray(items) || items.length === 0) return '# AI Pulse - X Daily Brief\n\n今日无可用AI相关内容。\n';

  const apiKey = requireEnv('GEMINI_API_KEY');
  const model = requireEnv('GEMINI_MODEL');
  const promptItems = buildPromptItems(items);
  const compactItems = promptItems.map((item) => ({
    handle: extractHandleFromItem(item),
    text: extractTextFromItem(item).slice(0, 500),
    url: extractUrlFromItem(item),
    date: String(item?.createdAt || '').slice(0, 19),
  })).filter((item) => item.handle && item.text && item.url);

  const promptRules = await loadPromptRules();
  const rulesSection = promptRules ? `\n\n## 额外规则（基于历史反馈，必须遵守）\n${promptRules}` : '';
  const prompt = `${getPromptTemplate()}${rulesSection}\n\n话题统计（宏观参考，已按participantCount降序排列）：\n${JSON.stringify(stats, null, 2)}\n\n去重后的原始动态（共${compactItems.length}条）。请你独立判断每条动态的具体主题，然后按主题相似性聚类为具体事件，再根据每个事件涉及的不同人数（participantCount）排序：\n${JSON.stringify(compactItems, null, 2)}`;

  let markdown = await requestGeminiReport({ apiKey, model, prompt });
  let normalized = normalizeMarkdownLayout(markdown);
  let reportBody = appendTop20Appendix(relabelSourceLinksWithRealNames(normalized, top20), top20, peopleStats);
  let structure = analyzeReportStructure(reportBody);
  console.log(`Report structure stats: top3=${structure.top3EventCount}, secondary=${structure.secondaryEventCount}, sourceLinks=${structure.sourceLinkCount}`);

  if (isStructureWeak(structure)) {
    const repairPrompt = `${prompt}\n\n上一次输出结构不达标，请重新输出并严格满足：\n- TOP3热度事件必须正好3条（编号1-3）\n- 中热度话题下至少4-8条事件，允许只有1个来源的事件单独列出\n- 每条动态都必须包含 [@本名](url) 链接；同一人多条推文合并为1条动态\n- 不要跳号（例如 1 后直接到 4）`;
    markdown = await requestGeminiReport({ apiKey, model, prompt: repairPrompt });
    normalized = normalizeMarkdownLayout(markdown);
    reportBody = appendTop20Appendix(relabelSourceLinksWithRealNames(normalized, top20), top20, peopleStats);
    structure = analyzeReportStructure(reportBody);
    console.log(`Report structure stats after retry: top3=${structure.top3EventCount}, secondary=${structure.secondaryEventCount}, sourceLinks=${structure.sourceLinkCount}`);
  }

  if (isStructureWeak(structure)) {
    console.warn('Report structure still weak; falling back to deterministic topic structure.');
    reportBody = appendTop20Appendix(relabelSourceLinksWithRealNames(normalizeMarkdownLayout(buildFallbackReportFromItems(promptItems, top20)), top20), top20, peopleStats);
  }

  const summarySection = await generateSummary({ apiKey, model, reportMarkdown: reportBody });
  const reportWithoutSummary = reportBody.replace(/## Today's Summary[\s\S]*?(?=\n## |\n---|\n\*\*|$)/, '').trimEnd();
  return `${reportWithoutSummary}\n\n${summarySection.trim()}\n`;
}

function csvCell(value) {
  return `"${String(value || '').replaceAll('"', '""')}"`;
}

function tweetsToCsv(tweets) {
  const rows = [['createdAt', 'author', 'handle', 'score', 'url', 'text']];
  for (const tweet of tweets) rows.push([tweet.createdAt, tweet.author, tweet.handle, String(scoreTweet(tweet)), tweet.url, tweet.text]);
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

async function saveBaseArtifacts(report, dailyTweets, weeklyTweets, historyTweets) {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await fs.writeFile(path.join(ARTIFACT_DIR, 'daily-report.md'), report, 'utf8');
  await fs.writeFile(path.join(ARTIFACT_DIR, 'tweets.json'), `${JSON.stringify(dailyTweets, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(ARTIFACT_DIR, 'tweets.csv'), `${tweetsToCsv(dailyTweets)}\n`, 'utf8');
  await fs.writeFile(path.join(ARTIFACT_DIR, 'weekly-tweets.json'), `${JSON.stringify(weeklyTweets, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(ARTIFACT_DIR, 'twitter-history.json'), `${JSON.stringify({ updatedAt: new Date().toISOString(), tweets: historyTweets }, null, 2)}\n`, 'utf8');
}


function stripHtmlTags(text) {
  return String(text || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function isWithinDays(date, days) {
  const ms = date instanceof Date ? date.getTime() : parseDateMs(date);
  if (!ms) return false;
  return Date.now() - ms <= days * 24 * 60 * 60 * 1000;
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
  } catch (error) {
    if (env('CROSS_VALIDATE_USE_JINA', 'true').toLowerCase() === 'false') throw error;
    const jinaUrl = `https://r.jina.ai/http://${String(url).replace(/^https?:\/\//i, '')}`;
    return fetchTextWithTimeout(jinaUrl, timeoutMs);
  }
}

function normalizeWeChatUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/mp\.weixin\.qq\.com$/i.test(parsed.hostname) || !parsed.pathname.startsWith('/s')) return '';
    const keep = new URLSearchParams();
    ['__biz', 'mid', 'idx', 'sn', 'scene'].forEach((key) => {
      const value = parsed.searchParams.get(key);
      if (value) keep.set(key, value);
    });
    parsed.search = keep.toString();
    return parsed.toString();
  } catch {
    return '';
  }
}

function extractWeChatArticleUrls(text) {
  const urls = String(text || '').match(/https?:\/\/mp\.weixin\.qq\.com\/s\?[^\s<>"')]+/gi) || [];
  return [...new Set(urls.map(normalizeWeChatUrl).filter(Boolean))];
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
  const epoch = html.match(/var\s+ct\s*=\s*"?(\d{10})"?/i)?.[1];
  const publishedAt = epoch ? new Date(Number(epoch) * 1000).toISOString() : (parseDateMs(publishedText) ? new Date(parseDateMs(publishedText)).toISOString() : null);
  const description = stripHtmlTags(decodeXmlEntities(
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || '',
  )).slice(0, 500);

  if (!title || !accountName.includes(expectedMediaName)) return null;
  return { media: expectedMediaName, title, link: url, publishedAt, description, source: 'wechat', accountName };
}

function isTwitterRelatedArticle(article) {
  const haystack = `${article?.title || ''} ${article?.description || ''}`.toLowerCase();
  return ['twitter', 'x.com', 'tweet', 'tweets', '推特', '马斯克', '转帖', '转推', '发帖', '@'].some((kw) => haystack.includes(kw.toLowerCase()));
}

async function fetchRecentMediaArticles() {
  const targetMedia = ['量子位', '机器之心', '新智元'];
  const candidateUrls = new Map();
  for (const mediaName of targetMedia) {
    for (const query of [`${mediaName} 推特`, `${mediaName} Twitter X`, `${mediaName} AI`]) {
      const searchUrls = [
        `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(query)}`,
        `https://cn.bing.com/search?q=${encodeURIComponent(`site:mp.weixin.qq.com "${mediaName}" ${query}`)}`,
      ];
      for (const searchUrl of searchUrls) {
        try {
          const page = await fetchTextWithFallback(searchUrl, 15000);
          if (!candidateUrls.has(mediaName)) candidateUrls.set(mediaName, new Set());
          extractWeChatArticleUrls(page).forEach((url) => candidateUrls.get(mediaName).add(url));
        } catch (error) {
          console.warn(`Search fetch failed for ${mediaName}: ${error.message}`);
        }
      }
    }
  }

  const articles = [];
  for (const mediaName of targetMedia) {
    for (const url of [...(candidateUrls.get(mediaName) || [])].slice(0, 12)) {
      try {
        const article = parseWeChatArticleMeta(await fetchTextWithFallback(url, 15000), url, mediaName);
        if (article) articles.push(article);
      } catch (error) {
        console.warn(`Article fetch failed for ${mediaName}: ${error.message}`);
      }
    }
  }

  const seen = new Set();
  const recentArticles = articles
    .filter((article) => {
      const key = `${article.media}::${article.link}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return !article.publishedAt || isWithinDays(article.publishedAt, 2);
    })
    .sort((a, b) => parseDateMs(b.publishedAt) - parseDateMs(a.publishedAt));
  return { recentArticles: recentArticles.slice(0, 30), twitterArticles: recentArticles.filter(isTwitterRelatedArticle).slice(0, 15) };
}

async function crossValidateWithMedia({ apiKey, model, reportMarkdown }) {
  if (env('CROSS_VALIDATE_WITH_MEDIA', 'true').toLowerCase() === 'false') return null;
  console.log('Starting cross-validation with Chinese AI media...');
  const mediaNames = ['量子位', '机器之心', '新智元'];
  const { recentArticles, twitterArticles } = await fetchRecentMediaArticles();
  const selectedArticles = twitterArticles.length > 0 ? twitterArticles : recentArticles;
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await fs.writeFile(path.join(ARTIFACT_DIR, 'media-cross-validation-sources.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), recentArticles, twitterArticles }, null, 2)}\n`, 'utf8');

  const articleLines = selectedArticles.map((article, index) => `${index + 1}. [${article.media}] ${article.title}（${article.publishedAt ? article.publishedAt.slice(0, 10) : '未知日期'}）\n   链接: ${article.link}\n   摘要: ${article.description || '无摘要'}`);
  const prompt = `你是一个AI行业分析师，负责对比验证日报的覆盖质量。\n\n以下是我们今天生成的AI日报：\n---\n${reportMarkdown.slice(0, 6000)}\n---\n\n以下是从"${mediaNames.join('、')}"公开站点实时抓取到的最近两天文章（优先Twitter/X相关新闻）：\n${articleLines.length > 0 ? articleLines.join('\n') : '未抓取到可用外部文章，请明确指出“外部数据缺失”。'}\n\n请你必须基于上面“实时抓取文章”来交叉验证日报（不要仅凭常识）：\n\n1. **覆盖盲区**：这三家公众号近两天可能会重点报道、但我们日报中可能遗漏的重大事件有哪些？（只列真实可能发生的事件，不要编造）\n2. **权重偏差**：我们日报中某些事件的重要性是否被高估或低估了？从国内视角看，哪些事件对中国AI从业者更重要？\n3. **改进建议**：基于以上对比，给出 2-3 条具体、可执行的 prompt 改进规则，用于提升下次日报的覆盖质量。\n\n请用以下格式输出（纯文本，不要 JSON）：\n\n### 覆盖盲区\n- ...\n\n### 权重偏差\n- ...\n\n### 改进建议（可直接追加到 prompt-rules.md）\n- ...`;
  try {
    return await requestGeminiReport({ apiKey, model, prompt });
  } catch (error) {
    console.warn(`Cross-validation failed (non-fatal): ${error.message}`);
    return null;
  }
}

async function saveIterationLog({ crossValidation, date }) {
  const logPath = path.join(ARTIFACT_DIR, 'iteration-log.md');
  const entry = `\n---\n\n## ${date} 交叉验证结果\n\n${crossValidation}\n`;
  let existing = '';
  try {
    existing = await fs.readFile(logPath, 'utf8');
  } catch {}
  await fs.writeFile(logPath, existing ? `${existing.trimEnd()}${entry}` : `# 日报迭代日志\n\n> 每次生成日报后，自动与国内AI媒体（量子位、机器之心、新智元）交叉验证。\n${entry}`, 'utf8');
}

async function sendEmail(report) {
  if (env('SKIP_EMAIL').toLowerCase() === 'true') {
    console.log('SKIP_EMAIL=true，跳过邮件发送。');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: requireEnv('SMTP_HOST'),
    port: toInt(requireEnv('SMTP_PORT'), 465),
    secure: env('SMTP_SECURE', 'true').toLowerCase() !== 'false',
    auth: { user: requireEnv('SMTP_USER'), pass: requireEnv('SMTP_PASS') },
  });

  await transporter.sendMail({
    from: requireEnv('MAIL_FROM'),
    to: requireEnv('MAIL_TO'),
    subject: env('MAIL_SUBJECT', `AI 日报 ${new Date().toISOString().slice(0, 10)}`),
    text: report,
    html: marked.parse(report),
  });
}

async function main() {
  const people = parsePeople();
  if (people.length === 0) throw new Error('请配置 TWITTER_HANDLES 或 TWITTER_PEOPLE_JSON。');

  const weeklyLookbackHours = Math.min(toInt(env('REPORT_WEEKLY_LOOKBACK_HOURS'), 24 * 7), 24 * 7);
  const weeklyMaxTweets = Math.min(toInt(env('REPORT_WEEKLY_MAX_TWEETS'), 1000), 3000);
  console.log(`准备近一周 Twitter/X 数据：${people.length} 个账号，窗口 ${weeklyLookbackHours} 小时。`);
  const { weeklyTweets, historyTweets } = await getWeeklyTweetsWithHistory(people, weeklyLookbackHours, weeklyMaxTweets);
  const ranking = rankPeople(weeklyTweets, people);
  const top20 = ranking.slice(0, 20);
  await writeRankingArtifacts(ranking, top20);
  console.log(`TOP20 已生成：${top20.map((p) => `@${p.handle}`).join(', ')}`);

  const dailyPeople = top20.length > 0 ? top20 : people;
  const dailyLookbackHours = toInt(env('REPORT_LOOKBACK_HOURS'), 24);
  const dailyMaxTweets = Math.min(toInt(env('REPORT_MAX_TWEETS'), 120), 500);
  console.log(`从历史/本次增量数据中筛选 TOP20 近 ${dailyLookbackHours} 小时动态。`);
  const dailyTweets = filterTweetsByPeopleAndWindow(weeklyTweets, dailyPeople, dailyLookbackHours).slice(0, dailyMaxTweets);
  const aiRelatedDaily = dailyTweets.filter(isAiRelatedItem);
  const promptTweets = [...aiRelatedDaily].sort((a, b) => scoreTweet(b) - scoreTweet(a) || new Date(b.createdAt) - new Date(a.createdAt)).slice(0, dailyMaxTweets);
  await writeActionSheet(dailyTweets, top20);

  const hotspotStats = getHotspotStats(promptTweets);
  const dailyPeopleStats = getPeopleStats(promptTweets);
  console.log(`抓到 ${dailyTweets.length} 条 TOP20 日动态，其中 ${promptTweets.length} 条 AI 相关，开始调用 Gemini 生成日报。`);
  const report = await generateReport(promptTweets, top20, hotspotStats, dailyPeopleStats);
  await saveBaseArtifacts(report, dailyTweets, weeklyTweets, historyTweets);

  const crossValidation = await crossValidateWithMedia({
    apiKey: requireEnv('GEMINI_API_KEY'),
    model: requireEnv('GEMINI_MODEL'),
    reportMarkdown: report,
  });
  if (crossValidation) await saveIterationLog({ crossValidation, date: new Date().toISOString().slice(0, 10) });

  await sendEmail(report);

  console.log(`完成：${path.join(ARTIFACT_DIR, 'daily-report.md')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
