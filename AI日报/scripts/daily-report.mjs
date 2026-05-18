import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { marked } from 'marked';

const ARTIFACT_DIR = path.resolve('artifacts');
const DEFAULT_HISTORY_PATH = path.join(ARTIFACT_DIR, 'twitter-history.json');
const TWITTER_SEARCH_URL = 'https://api.twitter.com/2/tweets/search/recent';

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
    .map((handle) => ({ handle, name: handle, title: '', description: '' }));
}

function chunkHandles(handles) {
  const chunks = [];
  let current = [];
  for (const handle of handles) {
    const next = [...current, handle];
    const query = next.map((h) => `from:${h}`).join(' OR ');
    // X recent search query 有长度限制；保守切分，避免账号多时失败。
    if (query.length > 420 && current.length > 0) {
      chunks.push(current);
      current = [handle];
    } else {
      current = next;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function fetchJson(url, options, label) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} 请求失败：${response.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function fetchTweets({ people, lookbackHours, maxTweets, label, startTime }) {
  if (people.length === 0) return [];
  const token = requireEnv('TWITTER_BEARER_TOKEN');
  const windowStart = startTime || new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const peopleByHandle = new Map(people.map((person) => [person.handle, person]));
  const tweetsById = new Map();

  const handleChunks = chunkHandles(people.map((person) => person.handle));
  const perChunkMax = Math.max(100, Math.ceil(maxTweets / Math.max(handleChunks.length, 1)));

  for (const handles of handleChunks) {
    const chunkTweetIds = new Set();
    let nextToken = '';
    do {
      const url = new URL(TWITTER_SEARCH_URL);
      url.searchParams.set('query', `(${handles.map((h) => `from:${h}`).join(' OR ')}) -is:retweet`);
      url.searchParams.set('start_time', windowStart);
      url.searchParams.set('max_results', '100');
      url.searchParams.set('sort_order', 'recency');
      url.searchParams.set('tweet.fields', 'author_id,created_at,public_metrics,referenced_tweets,entities,conversation_id');
      url.searchParams.set('expansions', 'author_id,referenced_tweets.id,referenced_tweets.id.author_id');
      url.searchParams.set('user.fields', 'username,name,description');
      if (nextToken) url.searchParams.set('next_token', nextToken);

      const data = await fetchJson(
        url,
        { headers: { Authorization: `Bearer ${token}` } },
        `Twitter/X ${label} recent search (${handles.join(', ')})`,
      );

      normalizeTweets(data, peopleByHandle).forEach((tweet) => {
        tweetsById.set(tweet.id, tweet);
        chunkTweetIds.add(tweet.id);
      });
      nextToken = data.meta?.next_token || '';
    } while (nextToken && chunkTweetIds.size < perChunkMax);
  }

  return [...tweetsById.values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
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
  const users = new Map((data.includes?.users || []).map((user) => [user.id, user]));
  const includedTweets = new Map((data.includes?.tweets || []).map((tweet) => [tweet.id, tweet]));

  return (data.data || []).map((tweet) => {
    const user = users.get(tweet.author_id) || {};
    const handle = normalizeHandle(user.username);
    const person = peopleByHandle.get(handle) || { handle, name: user.name || handle, title: '', description: '' };
    const referencedTweets = (tweet.referenced_tweets || []).map((ref) => {
      const included = includedTweets.get(ref.id) || {};
      const author = users.get(included.author_id) || {};
      return { type: ref.type, id: ref.id, authorHandle: normalizeHandle(author.username) };
    });

    return {
      id: tweet.id,
      url: `https://twitter.com/${handle}/status/${tweet.id}`,
      text: tweet.text || '',
      createdAt: tweet.created_at || '',
      author: person.name || user.name || handle,
      handle,
      title: person.title || '',
      description: person.description || '',
      metrics: tweet.public_metrics || {},
      referencedTweets,
      mentions: (tweet.entities?.mentions || []).map((mention) => normalizeHandle(mention.username)).filter(Boolean),
      conversationId: tweet.conversation_id || '',
    };
  }).filter((tweet) => tweet.handle);
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

async function readPromptRules() {
  try {
    return await fs.readFile('prompt-rules.md', 'utf8');
  } catch {
    return '';
  }
}

function buildPrompt(tweets, top20, rules) {
  const today = new Date().toISOString().slice(0, 10);
  const top20Text = top20.map((p, i) => `${i + 1}. ${p.name} (@${p.handle})：发帖 ${p.outputCount}，互动分 ${p.interactionScore}，综合分 ${p.compositeScore}`).join('\n');
  const sourceText = tweets.map((tweet, index) => {
    const m = tweet.metrics || {};
    return [
      `#${index + 1}`,
      `作者：${tweet.author} (@${tweet.handle}) ${tweet.title}`.trim(),
      `时间：${tweet.createdAt}`,
      `互动：赞${m.like_count || 0} 转${m.retweet_count || 0} 引${m.quote_count || 0} 评${m.reply_count || 0}`,
      `链接：${tweet.url}`,
      `内容：${tweet.text}`,
    ].join('\n');
  }).join('\n\n');

  return `你是一个 AI 行业日报编辑。请只基于下面的 Twitter/X 原始动态生成中文日报，不要编造未提供的事实。\n\n日期：${today}\n\nTOP20 活跃人物排名（近一周，综合分 = 动态数 + 互动分 × 2）：\n${top20Text || '无'}\n\n写作要求：\n- 输出 Markdown。\n- 开头给 5 条以内「今日要点」。\n- 然后写 3-6 个热点主题，每个主题包含：一句话结论、为什么重要、相关来源链接。\n- 相关来源必须尽量使用原帖链接。\n- 最后给「值得关注的账号」和「风险/不确定性」。\n- 不要在正文里重复完整 TOP20 表，脚本会在文末追加 TOP20 活跃人物。\n- 语言简洁，适合产品、战略、投资同事快速阅读。\n\n${rules ? `额外规则（来自 prompt-rules.md）：\n${rules}\n\n` : ''}原始动态：\n${sourceText || '过去窗口内没有抓到动态。请输出一份空状态说明，并提示检查账号列表或时间窗口。'}`;
}

async function generateReport(tweets, top20) {
  const apiKey = requireEnv('GEMINI_API_KEY');
  const model = requireEnv('GEMINI_MODEL').replace(/^models\//, '');
  const temperature = Number(env('GEMINI_TEMPERATURE', '0.3'));
  const prompt = buildPrompt(tweets, top20, await readPromptRules());
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const data = await fetchJson(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature },
      }),
    },
    'Gemini',
  );

  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n').trim();
  if (!text) throw new Error(`Gemini 没有返回正文：${JSON.stringify(data).slice(0, 500)}`);
  return appendTop20Appendix(text, top20, getPeopleStats(tweets));
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
  const promptTweets = [...dailyTweets].sort((a, b) => scoreTweet(b) - scoreTweet(a) || new Date(b.createdAt) - new Date(a.createdAt)).slice(0, dailyMaxTweets);
  await writeActionSheet(dailyTweets, top20);

  console.log(`抓到 ${dailyTweets.length} 条 TOP20 日动态，开始调用 Gemini 生成日报。`);
  const report = await generateReport(promptTweets, top20);
  await saveBaseArtifacts(report, dailyTweets, weeklyTweets, historyTweets);
  await sendEmail(report);

  console.log(`完成：${path.join(ARTIFACT_DIR, 'daily-report.md')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
