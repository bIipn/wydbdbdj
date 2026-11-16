#!/usr/bin/env python3
"""Plain-text reports for the HawkScan job (.github/workflows/hawkscan.yml). Everything goes to the job log, because
that log is the one thing every reader of a run can open.

  python3 scripts/hawkscan-report.py findings hawkscan-results.json   # what `hawk op scan get --format json` wrote
  python3 scripts/hawkscan-report.py server   server.log              # the app's own request log (pino JSON lines)

`server` answers the question a clean scan leaves open: did the scanner stay signed in, and did its requests reach
the handlers? It prints the answers by status, the scan user's session over time (GET /api/me, which the scanner
polls), and a table of route by status. Admin and cron routes answer 401 on purpose (the scan has neither token).
Prints no cookie, no password and no request body: the log lines it reads carry only method, path and status.
"""
import collections
import json
import re
import sys

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
PLAIN = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,23}$")
STATIC = re.compile(r"\.(js|css|png|svg|ico|html|json|webmanifest|txt|xml|map)$", re.I)


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
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0] or [-1])
    if start < 0:
        print("No JSON from the platform for this scan.")
        return
    try:
        data, _ = json.JSONDecoder().raw_decode(text[start:])
    except Exception as err:  # the platform's answer is not ours to trust
        print(f"Could not read the platform's answer ({err}).")
        print(text[:1500])
        return
    if not isinstance(data, dict):
        print("Unexpected answer:", json.dumps(data)[:800])
        return
    scan, summary = data.get("scan") or {}, data.get("summary") or {}
    print(f"scan {scan.get('id')} · {scan.get('status')} · {round((scan.get('duration_seconds') or 0) / 60)} min · "
          f"policy {scan.get('policy')} · URLs scanned {summary.get('urls_scanned')}")
    print("by severity:", json.dumps(summary.get("by_severity")), "· by status:", json.dumps(summary.get("by_status")))
    rows = data.get("findings") or []
    print(f"\n{len(rows)} check(s) with findings (severity | check | plugin | CWE | paths)")
    for f in rows:
        if not isinstance(f, dict):
            continue
        print(f"{f.get('severity')} | {f.get('plugin_name')} | {f.get('plugin_id')} | {f.get('cwe_id')} | {f.get('total_paths')}")
        for p in (f.get("paths") or [])[:60]:
            if isinstance(p, dict):
                where = " ".join(str(p.get(k)) for k in ("method", "request_method", "path", "uri", "url", "status", "triage_status") if p.get(k))
                extra = {k: v for k, v in p.items() if k in ("evidence", "param", "attack", "other_info") and v}
                print("    " + (where or json.dumps(p)[:300]) + (("  " + json.dumps(extra)[:400]) if extra else ""))
            else:
                print("    " + str(p)[:300])


def server(path: str) -> None:
    codes = collections.Counter()
    table = collections.defaultdict(collections.Counter)   # (method, route) -> status -> n
    session = collections.defaultdict(collections.Counter)  # 5-minute slot -> status of GET /api/me -> n
    open_requests = {}
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
        if route.startswith("/api/") and not route.startswith(("/api/admin", "/api/cron", "/api/auth", "/api/health")):
            for status, n in row.items():
                signed_in["401" if status == 401 else "answered by the handler or a rule (not 401)"] += n
    print("\nroutes behind the sign-in (not admin, cron, auth or health):", dict(signed_in))

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
