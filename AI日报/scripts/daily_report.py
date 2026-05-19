#!/usr/bin/env python3
import csv, json, os, re, ssl
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "artifacts"
ART.mkdir(parents=True, exist_ok=True)
UTC = timezone.utc


def now_utc(): return datetime.now(UTC)
def iso(dt): return dt.astimezone(UTC).isoformat().replace('+00:00', 'Z')
def parse_dt(s):
    try: return datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(UTC)
    except: return None

def env(name, default=None, req=False):
    v = os.getenv(name, default)
    if req and (v is None or str(v).strip()==""): raise SystemExit(f"missing env: {name}")
    return v

def b(name, d=False): return str(os.getenv(name, str(d))).lower() in {"1","true","yes","on"}

def split_handles(raw):
    if not raw: return []
    return [x.strip().lstrip('@').lower() for x in re.split(r'[\s,]+', raw) if x.strip()]

def parse_people():
    pj = os.getenv("TWITTER_PEOPLE_JSON", "").strip()
    if pj:
        arr = json.loads(pj)
        return [{"handle":(p.get("handle") or p.get("userName") or "").lstrip('@').lower(), **p} for p in arr if (p.get("handle") or p.get("userName"))]
    return [{"handle":h} for h in split_handles(env("TWITTER_HANDLES", req=True))]

def http_json(url, headers=None):
    req = Request(url, headers=headers or {})
    with urlopen(req, timeout=45) as r:
        return json.loads(r.read().decode('utf-8'))

def fetch_user_tweets(api_key, handle, cutoff, include_replies=True, cap=300):
    out, cursor = [], None
    while len(out) < cap:
        q = {"userName": handle, "includeReplies": str(include_replies).lower()}
        if cursor: q["cursor"] = cursor
        data = http_json(f"https://api.twitterapi.io/twitter/user/last_tweets?{urlencode(q)}", {"X-API-Key": api_key})
        tweets = data.get("tweets") or []
        if not tweets: break
        for t in tweets:
            created = parse_dt(t.get("createdAt") or t.get("created_at") or "")
            if not created: continue
            if created < cutoff: return out
            a = t.get("author") or {}
            ents = t.get("entities") or {}
            mentions = [m.get("userName","").lstrip('@').lower() for m in (ents.get("user_mentions") or []) if m.get("userName")]
            qtw = (t.get("quoted_tweet") or {}).get("author") or {}
            out.append({
                "id": str(t.get("id") or ""), "text": t.get("text") or "", "created_at": iso(created),
                "handle": (a.get("userName") or handle).lstrip('@').lower(), "mentions": mentions,
                "replied_to": (t.get("inReplyToUsername") or "").lstrip('@').lower() if t.get("isReply") else "",
                "quoted": (qtw.get("userName") or "").lstrip('@').lower(),
                "metrics": {"like": int(t.get("likeCount") or 0), "reply": int(t.get("replyCount") or 0), "retweet": int(t.get("retweetCount") or 0), "quote": int(t.get("quoteCount") or 0)}
            })
            if len(out) >= cap: break
        if not data.get("has_next_page"): break
        cursor = data.get("next_cursor")
        if not cursor: break
    return out

def merge_history(path, handles, cutoff, fresh):
    old=[]
    if path.exists():
        try: old = json.loads(path.read_text('utf-8'))
        except: old=[]
    keep = [x for x in old if x.get("handle") in handles and (parse_dt(x.get("created_at","")) or now_utc()) >= cutoff-timedelta(hours=24)]
    m={}
    for t in keep+fresh: m[t.get("id")+"|"+t.get("created_at")]=t
    merged=sorted(m.values(), key=lambda x:x.get("created_at",""), reverse=True)
    path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), 'utf-8')
    return merged

def rank_top20(tweets, handles):
    s={h:{"handle":h,"posts":0,"inter":0.0,"peer":0,"score":0.0} for h in handles}
    hs=set(handles)
    for t in tweets:
        h=t.get("handle")
        if h not in s: continue
        s[h]["posts"]+=1
        pts=0.0; peers=set()
        if t.get("quoted") in hs: pts+=1.5; peers.add(t.get("quoted"))
        if t.get("replied_to") in hs: pts+=1.0; peers.add(t.get("replied_to"))
        for m in t.get("mentions",[]):
            if m in hs and m!=h: pts+=0.5; peers.add(m)
        s[h]["inter"] += pts; s[h]["peer"] += len(peers)
    for v in s.values(): v["score"] = v["posts"]*1.0 + v["inter"]*1.2 + v["peer"]*0.8
    return sorted(s.values(), key=lambda x:x["score"], reverse=True)[:20], s

def filter_ai(tweets):
    kws=("ai","llm","agent","model","openai","gemini","claude","gpt","生成式","模型","智能体")
    return [t for t in tweets if any(k in (t.get("text") or "").lower() for k in kws)]

def cluster_topics(tweets):
    c=Counter()
    for t in tweets:
        txt=(t.get("text") or "").lower()
        for k in ["发布","开源","融资","评测","agent","gpt","gemini","benchmark","安全","多模态"]:
            if k in txt: c[k]+=1
    hot=[k for k,_ in c.most_common(3)]
    mid=[k for k,_ in c.items() if k not in hot]
    return {"top":hot,"mid":mid}

def gemini_report(api_key, model, tweets, top20, topics):
    prompt=f"""你是AI行业日报编辑。请基于给定推文输出中文Markdown日报。
要求保留：热点TOP3、中热度、今日总结；不要编造。
TOP20:{json.dumps(top20, ensure_ascii=False)}
话题:{json.dumps(topics, ensure_ascii=False)}
推文:{json.dumps(tweets[:120], ensure_ascii=False)}
"""
    body={"contents":[{"parts":[{"text":prompt}]}],"generationConfig":{"temperature":float(env('GEMINI_TEMPERATURE','0.3'))}}
    url=f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    data=http_json(url, {"Content-Type":"application/json"}) if False else None
    req=Request(url, data=json.dumps(body).encode('utf-8'), headers={"Content-Type":"application/json"})
    with urlopen(req, timeout=90) as r:
        obj=json.loads(r.read().decode('utf-8'))
    txt=((obj.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    text="\n".join([p.get("text","") for p in txt]).strip()
    if not text: text="# AI 日报\n\n暂无足够内容生成。"
    return text

def write_outputs(report, daily, weekly, ranking, all_scores):
    (ART/"daily-report.md").write_text(report, 'utf-8')
    (ART/"tweets.json").write_text(json.dumps(daily, ensure_ascii=False, indent=2),'utf-8')
    (ART/"weekly-tweets.json").write_text(json.dumps(weekly, ensure_ascii=False, indent=2),'utf-8')
    (ART/"top20-ranking.json").write_text(json.dumps(ranking, ensure_ascii=False, indent=2),'utf-8')
    with open(ART/"tweets.csv", "w", newline='', encoding='utf-8') as f:
        w=csv.writer(f); w.writerow(["id","created_at","handle","text","like","reply","retweet","quote"])
        for t in daily: w.writerow([t.get("id"),t.get("created_at"),t.get("handle"),t.get("text"),t["metrics"]["like"],t["metrics"]["reply"],t["metrics"]["retweet"],t["metrics"]["quote"]])
    rows=sorted(all_scores.values(), key=lambda x:x["score"], reverse=True)
    with open(ART/"ai-weekly-output-counts.csv", "w", newline='', encoding='utf-8') as f:
        w=csv.writer(f); w.writerow(["handle","posts","inter","peer","score"])
        for r in rows: w.writerow([r["handle"],r["posts"],f"{r['inter']:.2f}",r["peer"],f"{r['score']:.2f}"])

def send_email(md):
    if b("SKIP_EMAIL", False): return
    host,port,user,pwd=env("SMTP_HOST",req=True),int(env("SMTP_PORT",req=True)),env("SMTP_USER",req=True),env("SMTP_PASS",req=True)
    frm,to=env("MAIL_FROM",req=True),env("MAIL_TO",req=True)
    subject=env("MAIL_SUBJECT", f"AI 日报 {now_utc().date()}")
    html=f"<html><body><pre style='white-space:pre-wrap'>{md}</pre></body></html>"
    msg=MIMEMultipart('alternative'); msg['Subject']=subject; msg['From']=frm; msg['To']=to
    msg.attach(MIMEText(md,'plain','utf-8')); msg.attach(MIMEText(html,'html','utf-8'))
    import smtplib
    secure=b("SMTP_SECURE", True)
    if secure:
        with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context()) as s: s.login(user,pwd); s.sendmail(frm, to.split(','), msg.as_string())
    else:
        with smtplib.SMTP(host, port) as s: s.starttls(context=ssl.create_default_context()); s.login(user,pwd); s.sendmail(frm, to.split(','), msg.as_string())

def main():
    people=parse_people(); handles=[p["handle"] for p in people]
    api=env("TWITTERAPI_API_KEY", req=True)
    lookback_h=int(env("REPORT_LOOKBACK_HOURS","24")); weekly_h=int(env("REPORT_WEEKLY_LOOKBACK_HOURS","168"))
    now=now_utc(); day_cut=now-timedelta(hours=lookback_h); week_cut=now-timedelta(hours=weekly_h)
    history_path = ROOT / env("TWITTER_HISTORY_PATH", "artifacts/twitter-history.json")
    fresh=[]
    for h in handles: fresh += fetch_user_tweets(api, h, week_cut, b("TWITTER_INCLUDE_REPLIES", True), cap=300)
    weekly=merge_history(history_path, set(handles), week_cut, fresh)
    top20, all_scores = rank_top20([t for t in weekly if parse_dt(t.get('created_at','')) and parse_dt(t['created_at'])>=week_cut], handles)
    top_h={x['handle'] for x in top20}
    daily=[t for t in weekly if t.get('handle') in top_h and parse_dt(t.get('created_at','')) and parse_dt(t['created_at'])>=day_cut]
    daily=filter_ai(daily)
    topics=cluster_topics(daily)
    report=gemini_report(env("GEMINI_API_KEY", req=True), env("GEMINI_MODEL","gemini-2.5-flash"), daily, top20, topics)
    write_outputs(report, daily, weekly, top20, all_scores)
    send_email(report)
    print(f"完成: {ART/'daily-report.md'}")

if __name__ == '__main__': main()
