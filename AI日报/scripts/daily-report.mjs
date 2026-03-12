import fs from 'node:fs/promises';
import path from 'node:path';
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
    if (rule.kws.some((k) => lower.includes(k))) {
      return rule.label;
    }
  }
  return '其他AI动态';
}

const getHotspotStats = (items) => {
  const counts = items.reduce((map, item) => {
    const label = classifyHotspot(extractTextFromItem(item));
    map.set(label, (map.get(label) || 0) + 1);
    return map;
  }, new Map());

  const hotspots = Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  return {
    actionCount: items.length,
    hotspotCount: hotspots.length,
    hotspots,
  };
};


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

async function writeWeeklyCountsTable(ranking) {
  const header = '| 排名 | 本名 | X账号 | 近一周动态数量 |\n|---:|---|---|---:|';
  const rows = ranking.map((p, i) => `| ${i + 1} | ${p.name} | @${p.handle} | ${p.outputCount} |`);
  const markdown = `${header}\n${rows.join('\n')}\n`;
  const csvHeader = 'rank,name,handle,weekly_output_count';
  const csvRows = ranking.map((p, i) => `${i + 1},"${String(p.name).replaceAll('"', '""')}",${p.handle},${p.outputCount}`);
  const csv = `${csvHeader}\n${csvRows.join('\n')}\n`;

  const desktopDir = path.join(process.env.HOME || '.', 'Desktop');
  await fs.mkdir(desktopDir, { recursive: true });
  const markdownPath = path.join(desktopDir, 'ai-weekly-output-counts.md');
  const csvPath = path.join(desktopDir, 'ai-weekly-output-counts.csv');

  const artifactsDir = 'artifacts';
  await fs.mkdir(artifactsDir, { recursive: true });
  const artifactMarkdownPath = path.join(artifactsDir, 'ai-weekly-output-counts.md');
  const artifactCsvPath = path.join(artifactsDir, 'ai-weekly-output-counts.csv');

  await fs.writeFile(markdownPath, markdown, 'utf8');
  await fs.writeFile(csvPath, csv, 'utf8');
  await fs.writeFile(artifactMarkdownPath, markdown, 'utf8');
  await fs.writeFile(artifactCsvPath, csv, 'utf8');

  return { markdownPath, csvPath, artifactMarkdownPath, artifactCsvPath };
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

function appendTop20Appendix(markdown, top20) {
  const rows = top20
    .map((p, i) => {
      const profile = PEOPLE_PROFILE_MAP[normalizeHandle(p.handle)] || {};
      const title = profile.title || p.title || 'AI从业者';
      const bio = profile.bio || p.description || '持续活跃于AI一线动态';
      return `${i + 1}. ${p.name}（@${p.handle}）｜${title}：${bio}`;
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

    const ordered = line.match(/^(\d+)\.\s+(.+)/);
    if (ordered) {
      if (currentEvent) events.push(currentEvent);
      currentEvent = { index: Number(ordered[1]), title: ordered[2], analysis: [], why: '', actions: [], sources: [] };
      continue;
    }

    if (currentEvent) {
      const normalized = line.replace(/^[○■*-]\s+/, '');
      if (/热点解析[:：]/.test(normalized)) {
        currentEvent.analysis.push(normalized.replace(/^热点解析[:：]\s*/, ''));
      } else if (/why it matters|管理层意义|业务影响|重要性/i.test(normalized)) {
        currentEvent.why = normalized.replace(/^([^:：]+)[:：]\s*/, '');
      } else if (/相关动态[:：]/.test(normalized)) {
        const value = normalized.replace(/^相关动态[:：]\s*/, '');
        if (value) currentEvent.actions.push(value);
      } else if (/^@/.test(normalized) || /https?:\/\//.test(normalized)) {
        currentEvent.sources.push(normalized);
      } else {
        currentEvent.actions.push(normalized);
      }
    } else if (!/^##\s+/.test(line)) {
      topSectionNotes.push(line.replace(/^[○■*-]\s+/, ''));
    }
  }
  if (currentEvent) events.push(currentEvent);

  const top3 = events.slice(0, 3);
  const secondary = events.slice(3);

  const topicRules = [
    { title: '模型与推理能力', kws: ['模型', '推理', 'gpt', 'claude', 'gemini', 'model', 'inference'] },
    { title: 'Agent与自动化落地', kws: ['agent', '自动化', 'workflow', '编排'] },
    { title: '产品发布与商业化', kws: ['发布', '商业化', '融资', 'pricing', 'launch', 'funding'] },
    { title: '算力与基础设施', kws: ['gpu', '芯片', '算力', 'infra', 'nvidia'] },
  ];

  const grouped = new Map(topicRules.map((r) => [r.title, []]));
  for (const evt of secondary) {
    const hay = `${evt.title} ${evt.analysis.join(' ')}`.toLowerCase();
    const hit = topicRules.find((r) => r.kws.some((k) => hay.includes(String(k).toLowerCase())));
    grouped.get(hit ? hit.title : topicRules[2].title).push(evt);
  }
  const secondaryTopics = Array.from(grouped.entries())
    .map(([title, items]) => ({ title, items }))
    .filter((t) => t.items.length > 0)
    .slice(0, 4);

  const sectionTitle = (textValue) => `<h2 style="font-size:22px;line-height:1.3;margin:0 0 12px;color:#111827;font-weight:700;">${formatInlineMarkdown(textValue)}</h2>`;

  const renderSourceTags = (items) => {
    if (!items || items.length === 0) return '';
    const tags = items.slice(0, 6).map((item) => `<span style="display:inline-block;margin:0 8px 8px 0;padding:4px 10px;border:1px solid #d1d5db;border-radius:999px;font-size:12px;line-height:1.4;color:#374151;">${formatInlineMarkdown(item)}</span>`).join('');
    return `<div style="margin-top:10px;">${tags}</div>`;
  };

  const renderEventCard = (event) => {
    const analysisText = event.analysis.join(' ').trim();
    const actions = event.actions.slice(0, 5).map((a) => `<li style="margin:0 0 6px 0;color:#1f2937;font-size:14px;line-height:1.65;">${formatInlineMarkdown(a)}</li>`).join('');
    return `
      <div style="margin:0 0 14px 0;padding:16px 18px;border:1px solid #e5e7eb;border-radius:10px;background:#ffffff;">
        <div style="font-size:12px;color:#6b7280;font-weight:600;letter-spacing:0.3px;margin-bottom:6px;">HOT EVENT ${event.index}</div>
        <div style="font-size:19px;line-height:1.45;color:#111827;font-weight:700;margin-bottom:10px;">${formatInlineMarkdown(event.title)}</div>
        <div style="font-size:14px;line-height:1.7;color:#1f2937;margin-bottom:10px;">${formatInlineMarkdown(analysisText || '今日核心动态持续演进，建议关注执行节奏与信号变化。')}</div>
        <div style="margin:0 0 10px 0;padding:10px 12px;background:#f9fafb;border-left:3px solid #111827;font-size:13px;line-height:1.65;color:#111827;"><strong>Why it matters:</strong> ${formatInlineMarkdown(event.why || '对业务节奏、资源配置与外部竞争态势有直接影响。')}</div>
        ${actions ? `<ul style="margin:0;padding-left:18px;">${actions}</ul>` : ''}
        ${renderSourceTags(event.sources)}
      </div>
    `;
  };

  const renderTopicCard = (event, idx) => {
    const summary = (event.analysis.join(' ') || event.actions[0] || '该方向活跃度提升，建议持续跟踪。').trim();
    return `
      <div style="margin:0 0 10px 0;padding:12px 14px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;">
        <div style="font-size:12px;color:#6b7280;font-weight:600;margin-bottom:5px;">TOPIC ${idx + 1}</div>
        <div style="font-size:15px;line-height:1.55;color:#111827;font-weight:700;margin-bottom:6px;">${formatInlineMarkdown(event.title)}</div>
        <div style="font-size:13px;line-height:1.6;color:#374151;">${formatInlineMarkdown(summary)}</div>
      </div>
    `;
  };

  const executiveSummary = summaryLines.length > 0
    ? summaryLines.map((t) => t.replace(/^[-•]\s*/, '').replace(/^[^：:]+[：:]\s*/, '')).join('；')
    : `今日高热度集中在AI产品化推进与模型能力迭代，主要关注方向为Top 3热点与中热度主题演进，监测范围覆盖Top20 active AI voices in the last 24h，对管理层的意义在于优化资源投放效率并把握竞争窗口。`;

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;padding:24px 0;margin:0;">
  <tr>
    <td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="720" style="width:720px;max-width:720px;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
        <tr>
          <td style="background:#111827;padding:22px 28px;">
            <div style="font-size:30px;line-height:1.25;font-weight:700;color:#ffffff;">${formatInlineMarkdown(reportTitle)}</div>
            <div style="margin-top:8px;font-size:13px;line-height:1.5;color:#d1d5db;">${today} · Auto-generated executive intelligence brief</div>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 24px 4px 24px;">
            ${sectionTitle('Top 3 Hot Events')}
            ${top3.length > 0 ? top3.map(renderEventCard).join('') : '<div style="font-size:14px;color:#4b5563;padding:12px 0;">今日暂无可用热点事件。</div>'}
          </td>
        </tr>
        <tr>
          <td style="padding:8px 24px 8px 24px;">
            ${sectionTitle('Secondary Topics')}
            ${secondaryTopics.length > 0 ? secondaryTopics.map((topic, i) => `<div style=\"margin-bottom:12px;\"><div style=\"font-size:13px;color:#374151;font-weight:700;margin:0 0 6px 0;\">${i + 1}. ${formatInlineMarkdown(topic.title)}</div>${topic.items.slice(0, 4).map(renderTopicCard).join('')}</div>`).join('') : '<div style="font-size:13px;color:#6b7280;">今日中热度主题较少，建议持续观察明日信号。</div>'}
          </td>
        </tr>
        <tr>
          <td style="padding:8px 24px 8px 24px;">
            <div style="border:1px solid #d1d5db;border-left:4px solid #111827;border-radius:8px;background:#f9fafb;padding:14px 14px 12px 14px;">
              ${sectionTitle('Executive Summary')}
              <div style="font-size:14px;line-height:1.75;color:#1f2937;">${formatInlineMarkdown(executiveSummary)}</div>
            </div>
          </td>
        </tr>
        ${appendixLines.length > 0 ? `<tr><td style="padding:8px 24px 10px 24px;"><div style="border-top:1px solid #e5e7eb;padding-top:10px;">${sectionTitle('TOP20活跃人物')}<div style="font-size:12px;color:#6b7280;line-height:1.65;">${appendixLines.map((n) => `<div style="margin:0 0 4px 0;">${formatInlineMarkdown(n)}</div>`).join('')}</div></div></td></tr>` : ''}
        ${topSectionNotes.length > 0 ? `<tr><td style="padding:6px 24px 12px 24px;"><div style="font-size:13px;color:#6b7280;line-height:1.65;">${topSectionNotes.map((n) => `<div style="margin:0 0 5px 0;">${formatInlineMarkdown(n)}</div>`).join('')}</div></td></tr>` : ''}
        <tr>
          <td style="padding:10px 24px 20px 24px;border-top:1px solid #e5e7eb;">
            <div style="font-size:12px;color:#9ca3af;line-height:1.6;">This brief is generated for management quick-read. Source links are embedded in each event card for direct verification and follow-up.</div>
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

输出要求：
1) 先输出TOP3热度事件（按相关输出量排序）
2) 再输出7-12条中热度事件，按2-4个Topic组织（Topic标题不要出现“聚类”二字）
3) 不需要按传统行业大类分类
4) 每个事件统一结构：\n   - ○ **热点解析：** [事件抽象总结]\n   - ○ **相关动态：** [参与者动态，分点列出]\n5) 不要输出“聚类一/二/三”字样；不要输出“额外观察”与“AI大厂与投资机构资讯”板块\n6) 关联动态中的来源链接，不使用“查看原帖”，统一写成 [@本名](url)（本名不是X用户名）\n7) 文末新增 Today's Summary 板块，用一个自然段完成（不分点，不超过200字）\n8) 输出Markdown，结构清晰，分级列表明确
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
  return appendTop20Appendix(withRealNameLinks, top20);
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

  const tablePaths = await writeWeeklyCountsTable(ranking);
  console.log(`Weekly output table saved: ${tablePaths.markdownPath}, ${tablePaths.csvPath}, ${tablePaths.artifactMarkdownPath}, ${tablePaths.artifactCsvPath}`);

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
