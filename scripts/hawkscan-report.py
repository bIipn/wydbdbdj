#!/usr/bin/env python3
"""Plain-text reports for the HawkScan job (.github/workflows/hawkscan.yml). Everything goes to the job log, because
that log is the one thing every reader of a run can open.

  python3 scripts/hawkscan-report.py findings hawkscan-results.json   # what `hawk op scan get --format json` wrote
  python3 scripts/hawkscan-report.py server   server.log              # the app's own request log (pino JSON lines)

`server` answers the question a clean scan leaves open: did the scanner stay signed in, and did its requests reach
the handlers? It prints the answers by status, the scan user's session over time (GET /api/me, which the scanner
polls), how many requests to the job routes (/api/jobs/{id}/...) were answered 404 (run 4: the scanner's job ids were
not jobs), and a table of route by status. Admin and cron routes answer 401 on purpose (the scan has neither token).
`server` prints no cookie, no password and no request body: the log lines it reads carry only method, path and
status. `findings` prints the platform's evidence for each path, shortened, with session cookie values and e-mail
addresses hidden (run 3 printed the contact address the scanner had found on the legal pages).
"""
import collections
import os
import json
import re
import sys

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
PLAIN = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,23}$")
STATIC = re.compile(r"\.(js|css|png|svg|ico|html|json|webmanifest|txt|xml|map)$", re.I)
# The seed's two jobs (scripts/hawkscan-seed.mjs writes them to GITHUB_ENV), to tell them from ids that are not jobs.
SEEDED_JOBS = {v for v in (os.environ.get("SCAN_JOB_ID", ""), os.environ.get("SCAN_OWN_JOB_ID", "")) if v}
COOKIE = re.compile(r"(bs_session=)[^;\s\"'\\]+")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Routes that answer signed out: they say nothing about the scan user's session.
PUBLIC = ("/api/admin", "/api/cron", "/api/auth", "/api/health", "/api/trades", "/api/geo", "/api/jobs/rules", "/api/push/key")


def safe(text, limit: int = 160) -> str:
    """A value from the platform, fit for a log: no session cookie, no e-mail address, not long."""
    out = EMAIL.sub("[an e-mail address]", COOKIE.sub(r"\1[hidden]", str(text)))
    out = " ".join(out.split())
    return out if len(out) <= limit else out[:limit] + "…"


def route_of(url: str) -> str:
    """A request path with its ids folded away, so 10,000 fuzzed requests to one route are one row."""
    path = url.split("?", 1)[0].split("#", 1)[0]
    if not path.startswith("/api/"):
        return "(static file)" if STATIC.search(path) or path == "/" else "(other path)"
    out = []
    for seg in path.split("/")[1:8]:
        if UUID.match(seg):
            out.append("{id}")
        elif seg.isdigit():
            out.append("{n}")
        elif PLAIN.match(seg):
            out.append(seg)
        else:
            out.append("{x}")  # a bid id (questcdn:…), an encoded value, or whatever the scanner put there
    return "/" + "/".join(out)


def findings(path: str) -> None:
    text = open(path, errors="replace").read()
    # The CLI may print a line or two before the JSON (a notice, a banner with brackets in it): take the first
    # position that parses to an object.
    data = None
    for match in re.finditer(r"\{", text):
        try:
            candidate, _ = json.JSONDecoder().raw_decode(text[match.start():])
        except Exception:
            continue
        if isinstance(candidate, dict):
            data = candidate
            break
    if data is None:
        print("No JSON object from the platform for this scan." + (f" It said: {safe(text, 300)}" if text.strip() else ""))
        return
    scan = data.get("scan") if isinstance(data.get("scan"), dict) else {}
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    try:
        minutes = round(float(scan.get("duration_seconds") or 0) / 60)
    except (TypeError, ValueError):
        minutes = "?"
    print(f"scan {safe(scan.get('id'))} · {safe(scan.get('status'))} · {minutes} min · "
          f"policy {safe(scan.get('policy'))} · URLs scanned {safe(summary.get('urls_scanned'))}")
    print("by severity:", safe(json.dumps(summary.get("by_severity"))), "· by status:", safe(json.dumps(summary.get("by_status"))))
    rows = data.get("findings") if isinstance(data.get("findings"), list) else []
    print(f"\n{len(rows)} check(s) with findings (severity | check | plugin | CWE | paths)")
    for f in rows:
        if not isinstance(f, dict):
            continue
        print(" | ".join(safe(f.get(k)) for k in ("severity", "plugin_name", "plugin_id", "cwe_id", "total_paths")))
        paths = f.get("paths") if isinstance(f.get("paths"), list) else []
        for p in paths[:60]:
            if isinstance(p, dict):
                where = " ".join(safe(p.get(k), 120) for k in ("method", "request_method", "path", "uri", "url", "status", "triage_status") if p.get(k))
                extra = "; ".join(f"{k}: {safe(p.get(k))}" for k in ("evidence", "param", "attack") if p.get(k))
                print("    " + (where or safe(json.dumps(p), 300)) + (f"  [{extra}]" if extra else ""))
            else:
                print("    " + safe(p, 300))
        if len(paths) > 60:
            print(f"    … and {len(paths) - 60} more paths")


def server(path: str) -> None:
    codes = collections.Counter()
    table = collections.defaultdict(collections.Counter)   # (method, route) -> status -> n
    session = collections.defaultdict(collections.Counter)  # 5-minute slot -> status of GET /api/me -> n
    open_requests = {}
    job_ids = collections.defaultdict(collections.Counter)  # (method, what after the id) -> seeded/other counts
    slow, errors = [], []
    first = last = None
    for line in open(path, errors="replace"):
        try:
            d = json.loads(line)
        except Exception:
            if line.strip():
                errors.append(line.strip()[:300])
            continue
        if not isinstance(d, dict):
            continue
        t = d.get("time")
        first = first or t
        last = t or last
        req, res, rid = d.get("req"), d.get("res") or {}, d.get("reqId")
        if isinstance(req, dict) and rid:
            open_requests[rid] = (str(req.get("method")), str(req.get("url") or ""))
        if "statusCode" in res:
            status = res["statusCode"]
            codes[status] += 1
            method, url = open_requests.pop(rid, ("?", ""))
            table[(method, route_of(url))][status] += 1
            # Which id each job-route request carried: the seed's own jobs, or something else (run 5: cancel and
            # back-out got the seeded ids, messages/confirm/complete/read got ids that were not jobs).
            parts = url.split("?", 1)[0].split("/")
            if len(parts) >= 4 and parts[1:3] == ["api", "jobs"] and UUID.match(parts[3]):
                kind = "seeded job" if parts[3] in SEEDED_JOBS else "other id"
                tail = "/".join(parts[4:6]) or "(the job itself)"
                job_ids[(method, tail)][kind] += 1
                if status == 404:
                    job_ids[(method, tail)][kind + " 404"] += 1
            if method == "GET" and url.split("?", 1)[0] == "/api/me" and first and t:
                session[int((t - first) // 300000)][status] += 1
            ms = d.get("responseTime") or 0
            if ms > 5000:
                slow.append((round(ms), method, route_of(url)))
        if d.get("level", 0) >= 50:
            errors.append(str(d.get("msg") or (d.get("err") or {}).get("message"))[:300])

    print("answers by status:", dict(sorted(codes.items())))
    if first and last:
        print(f"log covers {round((last - first) / 60000)} minutes")
    print(f"answers slower than 5 s: {len(slow)}", slow[:10])
    print(f"error lines (level 50+ or not JSON): {len(errors)}")
    for text, n in collections.Counter(errors).most_common(15):
        print("  ", n, "x", text)

    print("\nthe scan user's session, GET /api/me per 5 minutes (200 = signed in, 401 = signed out):")
    for slot in sorted(session):
        row = session[slot]
        print(f"  minute {slot * 5:>3}: " + "  ".join(f"{s} x {n}" for s, n in sorted(row.items())))
    if not session:
        print("  no GET /api/me in the log")

    statuses = sorted(codes)
    signed_in = collections.Counter()
    for (method, route), row in table.items():
        if route.startswith("/api/") and not route.startswith(PUBLIC):
            for status, n in row.items():
                label = {401: "401 signed out", 429: "429 refused by a limit", 409: "409 refused by a state rule"}.get(status, "reached the handler (any other answer)")
                signed_in[label] += n
    total = sum(signed_in.values())
    print("\nroutes behind the sign-in (not admin, cron, auth, health or the public look-ups):")
    for label, n in signed_in.most_common():
        print(f"  {n:>6}  {round(100 * n / total) if total else 0:>3}%  {label}")
    print("  (a stream the scan guard cut after 2 s has no line in the app's log and is not counted)")

    # Run 4: the job routes got an id that is not a job, so most of their answers were the first look-up's 404.
    # (/api/jobs/rules, /mine, /conversations… are plain words, not ids, and are left out.)
    jobs = collections.Counter()
    for (method, route), row in table.items():
        parts = route.split("/")
        if len(parts) >= 4 and parts[1:3] == ["api", "jobs"] and parts[3] in ("{id}", "{n}", "{x}"):
            for status, n in row.items():
                jobs["404" if status == 404 else "other"] += n
    total_jobs = sum(jobs.values())
    print("\nthe job routes (/api/jobs/{id} and below): "
          + (f"{total_jobs} requests, {jobs['404']} answered 404 ({round(100 * jobs['404'] / total_jobs)}%), "
             f"{jobs['other']} anything else" if total_jobs else "no request in the log"))
    print("  (mostly 404 = the scanner's job ids do not exist, and the handlers stopped at the first look-up)")
    if job_ids:
        print("  by the id the request carried" + ("" if SEEDED_JOBS else " (SCAN_JOB_ID / SCAN_OWN_JOB_ID not set: every id counts as other)") + ":")
        print("  " + "seeded".rjust(7) + " (404)" + "   other".rjust(8) + " (404)  method route")
        for (method, tail), c in sorted(job_ids.items(), key=lambda kv: -sum(v for k, v in kv[1].items() if not k.endswith("404"))):
            print(f"  {c['seeded job']:>7} ({c['seeded job 404']:>3}) {c['other id']:>7} ({c['other id 404']:>3})  {method} /api/jobs/{{id}}/{tail}")

    print("\nroute by status (ids folded: {id} a UUID, {n} a number, {x} anything else), most requests first:")
    print("  " + "total".rjust(6) + "  " + "  ".join(str(s).rjust(6) for s in statuses) + "  method route")
    ranked = sorted(table.items(), key=lambda kv: -sum(kv[1].values()))
    for (method, route), row in ranked[:90]:
        print("  " + str(sum(row.values())).rjust(6) + "  " + "  ".join((str(row.get(s, "")) or "").rjust(6) for s in statuses) + f"  {method} {route}")
    rest = ranked[90:]
    if rest:
        print(f"  … and {len(rest)} more rows with {sum(sum(r.values()) for _, r in rest)} requests")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("findings", "server"):
        print(__doc__)
        sys.exit(2)
    (findings if sys.argv[1] == "findings" else server)(sys.argv[2])
