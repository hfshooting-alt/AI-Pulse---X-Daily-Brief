#!/usr/bin/env python3
from __future__ import annotations
import csv, json, os, re, ssl, smtplib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, quote_plus
from urllib.request import Request, urlopen

UTC = timezone.utc
ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "artifacts"
ART.mkdir(parents=True, exist_ok=True)
TW_URL = "https://api.twitterapi.io/twitter/user/last_tweets"


def env(k, d=""):
    return (os.getenv(k, d) or d).strip()


def req(k):
    v = env(k)
    if not v:
        raise SystemExit(f"missing env: {k}")
    return v


def b(k, d=False):
    return env(k, str(d)).lower() in {"1", "true", "yes", "on"}


def i(k, d):
    try:
        return int(env(k, str(d)))
    except Exception:
        return d


def parse_dt(s):
    try:
        return datetime.fromisoformat((s or "").replace("Z", "+00:00")).astimezone(UTC)
    except Exception:
        return None


def iso(dt):
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def http_json(url: str, headers=None, data=None, timeout=60):
    req_ = Request(url, headers=headers or {}, data=data)
    with urlopen(req_, timeout=timeout) as r:
        t = r.read().decode("utf-8")
        return json.loads(t) if t else {}


def normalize_handle(x):
    return str(x or "").strip().lstrip("@").lower()


def parse_people():
    raw = env("TWITTER_PEOPLE_JSON")
    if raw:
        arr = json.loads(raw)
        out = []
        for p in arr:
            if isinstance(p, str):
                out.append({"handle": normalize_handle(p), "userId": "", "name": p})
            else:
                h = normalize_handle(p.get("handle") or p.get("username") or p.get("userName") or p.get("twitter"))
                if h:
                    out.append({"handle": h, "userId": p.get("userId") or p.get("user_id") or "", "name": p.get("name") or h, "title": p.get("title") or "", "description": p.get("description") or p.get("bio") or ""})
        return out
    hs = [normalize_handle(x) for x in re.split(r"[\s,]+", req("TWITTER_HANDLES")) if x.strip()]
    return [{"handle": h, "userId": "", "name": h, "title": "", "description": ""} for h in hs]


def normalize_tweet(t: dict, person: dict):
    a = t.get("author") or {}
    ents = t.get("entities") or {}
    qtw = (t.get("quoted_tweet") or {}).get("author") or {}
    mentions = [normalize_handle(m.get("userName") or m.get("username")) for m in (ents.get("user_mentions") or []) if (m.get("userName") or m.get("username"))]
    return {
        "id": str(t.get("id") or ""),
        "url": t.get("url") or f"https://twitter.com/{person['handle']}/status/{t.get('id','')}",
        "text": t.get("text") or "",
        "createdAt": t.get("createdAt") or t.get("created_at") or "",
        "handle": normalize_handle(a.get("userName") or a.get("username") or person["handle"]),
        "author": person.get("name") or person["handle"],
        "title": person.get("title", ""),
        "description": person.get("description", ""),
        "metrics": {
            "like_count": int(t.get("likeCount") or 0),
            "reply_count": int(t.get("replyCount") or 0),
            "retweet_count": int(t.get("retweetCount") or 0),
            "quote_count": int(t.get("quoteCount") or 0),
        },
        "mentions": [m for m in mentions if m],
        "replied_to": normalize_handle(t.get("inReplyToUsername")) if t.get("isReply") else "",
        "quoted": normalize_handle(qtw.get("userName") or qtw.get("username")),
    }


def fetch_tweets(people, lookback_hours, max_tweets, start_time=None, label=""):
    api = req("TWITTERAPI_API_KEY")
    include_replies = env("TWITTER_INCLUDE_REPLIES", "true").lower() != "false"
    ws = parse_dt(start_time) if start_time else datetime.now(UTC) - timedelta(hours=lookback_hours)
    out = {}
    per_user_cap = max(20, int(max_tweets / max(len(people), 1)) + 20)
    for p in people:
        cursor = ""
        got, stop = 0, False
        while not stop:
            q = {"includeReplies": str(include_replies).lower()}
            if p.get("userId"): q["userId"] = p["userId"]
            else: q["userName"] = p["handle"]
            if cursor: q["cursor"] = cursor
            data = http_json(f"{TW_URL}?{urlencode(q)}", headers={"X-API-Key": api})
            tweets = data.get("tweets") or []
            for t in tweets:
                n = normalize_tweet(t, p)
                dt = parse_dt(n["createdAt"])
                if not dt: continue
                if dt < ws:
                    stop = True
                    break
                if n["id"]:
                    out[n["id"]] = n
                    got += 1
                    if got >= per_user_cap:
                        stop = True
                        break
            if stop or not data.get("has_next_page"):
                break
            cursor = data.get("next_cursor") or ""
            if not cursor:
                break
    rows = sorted(out.values(), key=lambda x: parse_dt(x.get("createdAt")) or datetime(1970,1,1,tzinfo=UTC), reverse=True)
    return rows[:max_tweets]


def get_history_path():
    return ROOT / env("TWITTER_HISTORY_PATH", "artifacts/twitter-history.json")


def load_history(p: Path):
    if not p.exists(): return []
    try:
        obj = json.loads(p.read_text("utf-8"))
        if isinstance(obj, list): return obj
        if isinstance(obj, dict) and isinstance(obj.get("tweets"), list): return obj["tweets"]
    except Exception:
        return []
    return []


def merge_tweets(*lists):
    m = {}
    for t in [x for lst in lists for x in lst]:
        if t.get("id"): m[str(t["id"])] = t
    return sorted(m.values(), key=lambda x: parse_dt(x.get("createdAt")) or datetime(1970,1,1,tzinfo=UTC), reverse=True)


def filter_people_window(tweets, handles, lookback):
    cutoff = datetime.now(UTC) - timedelta(hours=lookback)
    hs = set(handles)
    return [t for t in tweets if normalize_handle(t.get("handle")) in hs and (parse_dt(t.get("createdAt")) or cutoff) >= cutoff]


def incremental_start(cached, lookback):
    full_start = datetime.now(UTC) - timedelta(hours=lookback)
    if b("TWITTER_FORCE_FULL_FETCH", False) or not cached:
        return iso(full_start)
    mx = max([(parse_dt(t.get("createdAt")) or full_start) for t in cached])
    st = max(full_start, mx - timedelta(minutes=5))
    return iso(st)


def rank_people(weekly, people):
    hs = [normalize_handle(p["handle"]) for p in people]
    s = {h: {"handle": h, "name": next((p.get("name",h) for p in people if normalize_handle(p['handle'])==h), h), "weekly_output_count":0, "interaction_score":0.0, "peers_engaged":0, "composite_score":0.0} for h in hs}
    hset = set(hs)
    for t in weekly:
        h = normalize_handle(t.get("handle"))
        if h not in s: continue
        s[h]["weekly_output_count"] += 1
        peers = set()
        score = 0.0
        if normalize_handle(t.get("quoted")) in hset: score += 1.5; peers.add(normalize_handle(t.get("quoted")))
        if normalize_handle(t.get("replied_to")) in hset: score += 1.0; peers.add(normalize_handle(t.get("replied_to")))
        for m in t.get("mentions",[]):
            m = normalize_handle(m)
            if m in hset and m != h: score += 0.5; peers.add(m)
        s[h]["interaction_score"] += score
        s[h]["peers_engaged"] += len(peers)
    for v in s.values():
        v["composite_score"] = v["weekly_output_count"] + v["interaction_score"]*1.2 + v["peers_engaged"]*0.8
    return sorted(s.values(), key=lambda x: x["composite_score"], reverse=True)


def is_ai_related(text):
    t = (text or "").lower()
    kws = ["ai","llm","agent","gpt","gemini","claude","openai","anthropic","模型","大模型","智能体","多模态","推理"]
    return any(k in t for k in kws)


def classify_hotspots(text):
    t = (text or "").lower()
    tags=[]
    mp={"模型发布":["release","发布","launch"],"开源":["open source","开源"],"融资并购":["funding","融资","acquisition","并购"],"评测基准":["benchmark","评测"],"安全治理":["safety","安全","governance","治理"]}
    for k,arr in mp.items():
        if any(x in t for x in arr): tags.append(k)
    return tags or ["其他"]


def build_prompt(items, top20, prompt_rules=""):
    return f"""你是AI行业日报编辑。请基于输入推文生成中文Markdown日报。
必须包含：## 热点TOP3、## 中热度、## Today's Summary。
要求：去重同事件；保留来源链接；不要编造。
额外规则：\n{prompt_rules or '无'}
TOP20人物：{json.dumps(top20, ensure_ascii=False)}
输入推文：{json.dumps(items[:200], ensure_ascii=False)}
"""


def request_gemini(prompt):
    key = req("GEMINI_API_KEY")
    model = env("GEMINI_MODEL", "gemini-2.5-flash")
    temp = float(env("GEMINI_TEMPERATURE", "0.3"))
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    body = {"contents":[{"parts":[{"text":prompt}]}], "generationConfig":{"temperature":temp}}
    obj = http_json(url, headers={"Content-Type":"application/json"}, data=json.dumps(body).encode("utf-8"), timeout=90)
    parts = (((obj.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
    txt = "\n".join([p.get("text","") for p in parts]).strip()
    if not txt:
        raise RuntimeError(f"Gemini empty response: {str(obj)[:300]}")
    return txt


def fallback_report(items, top20):
    lines=["# AI 日报", "", "## 热点TOP3"]
    for idx,t in enumerate(items[:3],1): lines.append(f"{idx}. {t.get('text','')[:140]}（@{t.get('handle','')}）")
    lines += ["", "## 中热度"]
    for t in items[3:15]: lines.append(f"- {t.get('text','')[:120]}（@{t.get('handle','')}）")
    lines += ["", "## Today's Summary", f"- 今日共处理 {len(items)} 条 AI 相关动态；TOP20 入榜人数 {len(top20)}。"]
    return "\n".join(lines)


def load_prompt_rules():
    p = ROOT / "prompt-rules.md"
    return p.read_text("utf-8").strip() if p.exists() else ""


def cross_validate(report):
    if env("CROSS_VALIDATE_WITH_MEDIA","true").lower()=="false":
        return None
    media=["量子位","机器之心","新智元"]
    arts=[]
    for m in media:
        try:
            u=f"https://cn.bing.com/search?q={quote_plus(f'site:mp.weixin.qq.com {m} AI')}"
            html = urlopen(Request(u, headers={"User-Agent":"Mozilla/5.0"}), timeout=20).read().decode("utf-8","ignore")
            for x in re.findall(r'https://mp\.weixin\.qq\.com/s\?[^"\'\s<>]+', html)[:4]:
                arts.append({"media":m, "link":x})
        except Exception:
            pass
    (ART/"media-cross-validation-sources.json").write_text(json.dumps({"generatedAt":iso(datetime.now(UTC)),"articles":arts}, ensure_ascii=False, indent=2),"utf-8")
    prompt = f"请基于以下日报与外部媒体链接给出覆盖盲区、权重偏差、改进建议。\n日报:\n{report[:5000]}\n外部数据:\n{json.dumps(arts, ensure_ascii=False)}"
    try:
        out = request_gemini(prompt)
    except Exception as e:
        out = f"### 覆盖盲区\n- 外部数据不足\n\n### 权重偏差\n- 暂无法判定\n\n### 改进建议\n- {e}"
    (ART/"iteration-log.md").write_text(out+"\n", "utf-8")


def save_artifacts(report, daily, weekly, history, ranking, top20):
    (ART/"daily-report.md").write_text(report if report.endswith("\n") else report+"\n", "utf-8")
    (ART/"tweets.json").write_text(json.dumps(daily, ensure_ascii=False, indent=2)+"\n", "utf-8")
    (ART/"weekly-tweets.json").write_text(json.dumps(weekly, ensure_ascii=False, indent=2)+"\n", "utf-8")
    (ART/"twitter-history.json").write_text(json.dumps({"updatedAt":iso(datetime.now(UTC)),"tweets":history}, ensure_ascii=False, indent=2)+"\n", "utf-8")
    (ART/"top20-ranking.json").write_text(json.dumps(top20, ensure_ascii=False, indent=2)+"\n", "utf-8")

    with open(ART/"tweets.csv","w",newline="",encoding="utf-8") as f:
        w=csv.writer(f); w.writerow(["id","createdAt","handle","text","url","like","reply","retweet","quote"])
        for t in daily:
            m=t.get("metrics",{})
            w.writerow([t.get("id"),t.get("createdAt"),t.get("handle"),t.get("text"),t.get("url"),m.get("like_count",0),m.get("reply_count",0),m.get("retweet_count",0),m.get("quote_count",0)])

    rows=[]
    for idx,r in enumerate(ranking,1):
        rows.append(f"{idx}. {r['name']} (@{r['handle']}) | 周发帖 {r['weekly_output_count']} | 互动分 {r['interaction_score']:.2f} | 同行互动数 {r['peers_engaged']} | 综合分 {r['composite_score']:.2f}")
    (ART/"ai-weekly-output-counts.md").write_text("# AI 周活跃统计\n\n"+"\n".join(rows)+"\n","utf-8")
    with open(ART/"ai-weekly-output-counts.csv","w",newline="",encoding="utf-8") as f:
        w=csv.writer(f); w.writerow(["rank","name","handle","weekly_output_count","interaction_score","peers_engaged","composite_score"])
        for idx,r in enumerate(ranking,1): w.writerow([idx,r["name"],r["handle"],r["weekly_output_count"],f"{r['interaction_score']:.2f}",r["peers_engaged"],f"{r['composite_score']:.2f}"])

    # Action sheet
    top_h={x["handle"] for x in top20}; grouped={}
    for t in daily:
        if t.get("handle") not in top_h: continue
        for tag in classify_hotspots(t.get("text")):
            grouped.setdefault(tag, []).append(t)
    md=["# TOP20 Action Sheet",""]
    csv_rows=[]
    for tag,arr in grouped.items():
        md.append(f"## {tag}")
        for t in arr:
            md.append(f"- @{t.get('handle')}: {t.get('text','')[:180]}\n  - {t.get('url','')}")
            csv_rows.append([tag,t.get("author",""),t.get("handle",""),(t.get("createdAt") or "")[:10],t.get("text",""),t.get("url","")])
        md.append("")
    (ART/"top20-action-sheet.md").write_text("\n".join(md)+"\n","utf-8")
    with open(ART/"top20-action-sheet.csv","w",newline="",encoding="utf-8") as f:
        w=csv.writer(f); w.writerow(["topic","name","handle","date","text","url"]); w.writerows(csv_rows)


def send_mail(report):
    if b("SKIP_EMAIL", False): return
    host,port,user,pw=req("SMTP_HOST"),int(req("SMTP_PORT")),req("SMTP_USER"),req("SMTP_PASS")
    frm,to=req("MAIL_FROM"),req("MAIL_TO")
    subject=env("MAIL_SUBJECT", f"AI 日报 {datetime.now(UTC).date()}")
    html=f"<html><body><pre style='white-space:pre-wrap'>{report}</pre></body></html>"
    msg=MIMEMultipart("alternative"); msg["Subject"]=subject; msg["From"]=frm; msg["To"]=to
    msg.attach(MIMEText(report,"plain","utf-8")); msg.attach(MIMEText(html,"html","utf-8"))
    if b("SMTP_SECURE", True):
        with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context()) as s: s.login(user,pw); s.sendmail(frm,[x.strip() for x in to.split(',') if x.strip()], msg.as_string())
    else:
        with smtplib.SMTP(host, port) as s: s.starttls(context=ssl.create_default_context()); s.login(user,pw); s.sendmail(frm,[x.strip() for x in to.split(',') if x.strip()], msg.as_string())


def main():
    people = parse_people()
    if not people: raise SystemExit("请配置 TWITTER_HANDLES 或 TWITTER_PEOPLE_JSON")
    weekly_h=min(i("REPORT_WEEKLY_LOOKBACK_HOURS",168),168)
    weekly_max=min(i("REPORT_WEEKLY_MAX_TWEETS",1000),3000)
    daily_h=min(i("REPORT_LOOKBACK_HOURS",24),168)
    daily_max=min(i("REPORT_MAX_TWEETS",120),500)

    history_path=get_history_path(); old=load_history(history_path)
    handles=[p["handle"] for p in people]
    cached=filter_people_window(old, handles, weekly_h)
    st=incremental_start(cached, weekly_h)
    inc=fetch_tweets(people, weekly_h, weekly_max, start_time=st, label="weekly-incremental")
    weekly=merge_tweets(cached, inc)[:weekly_max]
    keep_h=max(weekly_h,daily_h)+6
    history=filter_people_window(merge_tweets(old,inc), handles, keep_h)

    ranking=rank_people(weekly, people)
    top20=ranking[:20]
    top_handles={x["handle"] for x in top20} if top20 else set(handles)
    daily=[t for t in weekly if normalize_handle(t.get("handle")) in top_handles]
    cutoff=datetime.now(UTC)-timedelta(hours=daily_h)
    daily=[t for t in daily if (parse_dt(t.get("createdAt")) or cutoff)>=cutoff][:daily_max]
    prompt_items=[t for t in daily if is_ai_related(t.get("text"))]

    rules=load_prompt_rules()
    prompt=build_prompt(prompt_items, top20, rules)
    try:
        report=request_gemini(prompt)
    except Exception:
        report=fallback_report(prompt_items, top20)

    save_artifacts(report, daily, weekly, history, ranking, top20)
    cross_validate(report)
    send_mail(report)
    print(f"完成: {ART / 'daily-report.md'}")


if __name__ == "__main__":
    main()
