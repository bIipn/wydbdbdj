#!/usr/bin/env python3
"""The HawkScan job's own copy of the API spec (.github/workflows/hawkscan.yml, before `hawk validate`).

  python3 scripts/hawkscan-spec.py docs/api/openapi.yaml "$RUNNER_TEMP/openapi-scan.yaml"

Why a copy: every path id in docs/api/openapi.yaml is called "{id}" (test/openapi.test.ts keeps the spec equal to
the server's ":id" routes, so the repository's spec stays as it is). stackhawk.yml's customVariables are keyed by
the parameter's name, and their "path" scoping did not take effect in runs 2 to 4: one value (the other account's
id) went into every "{id}", so the job routes were attacked with an id that is not a job (most answers 404 at the
first look-up). In the copy each kind of path id has its own name, so a customVariable keyed by name alone cannot
land on the wrong route:

  /api/jobs/{id}...  and /api/admin/jobs/{id}/remove           -> {jobId}    (customVariables: the seeded jobs)
  /api/people/{id}... and /api/admin/people/{id}/...           -> {personId} (the other TEST account)
  /api/bids/{id} and /api/swipe/{id}                           -> {bidRef}   (the seeded, saved bid)

It also, in the copy only:
  - puts the seed's real ids (SCAN_JOB_ID, SCAN_PERSON_ID, SCAN_BID_ID in the environment, written by
    scripts/hawkscan-seed.mjs) in place of the spec's placeholder examples, so a request built from the examples
    reaches the handler too;
  - gives POST /api/estimate a COMPLETE cost request (made-up inputs, the shape of test/estimate-route.test.ts's I-1
    vector) for the saved bid, as the body's schema (every field with its example) and as its example. In run 4 the
    route answered 404 bid_not_found to 725 of 755 requests: the scanner built the body from the schema, with a
    made-up bidId. The spec's quick form, even with a real bid, answers 200 "incomplete" (13 fields needed) and never
    prices anything, so the engine's arithmetic was not attacked.

Then it checks its own output and exits 1 with a sentence when a check fails: every "{name}" in every path key has a
path parameter of that name declared for each operation under it (inline or through the $ref it names) and nothing
else; no "{id}" is left; no path key was lost or duplicated; the operations are the same (renames aside) and as many.
Standard library only (the repository has no YAML library): it reads the one layout the spec is written in, the
layout test/openapi.test.ts enforces.
"""
import json
import os
import re
import sys

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
METHODS = ("get", "put", "post", "delete", "patch")

# (path key prefix, new name for its {id}). Every "{id}" path key must start with one of these.
RENAMES = (
    ("/api/jobs/{id}", "jobId"),
    ("/api/admin/jobs/{id}/", "jobId"),
    ("/api/people/{id}", "personId"),
    ("/api/admin/people/{id}/", "personId"),
    ("/api/bids/{id}", "bidRef"),
    ("/api/swipe/{id}", "bidRef"),
)
# components/parameters whose "name: id" is renamed, and to what. Each must be used only under its own kind of path
# (the check below finds out if not).
COMPONENTS = {"JobId": "jobId", "BidIdPath": "bidRef"}

# The spec's placeholder ids (its header says the scan puts real ones in) and the seed's variable for each.
PLACEHOLDERS = (
    ("00000000-0000-4000-8000-000000000001", "SCAN_JOB_ID", "uuid"),
    ("00000000-0000-4000-8000-000000000002", "SCAN_PERSON_ID", "uuid"),
    ("'questcdn:1903611:10385980'", "SCAN_BID_ID", "bid"),
)


def estimate_request(bid_id: str) -> dict:
    """A cost request the engine prices completely (status "complete", no "needed"). Made-up inputs, labelled."""
    return {
        "bidId": bid_id,
        "job": {"ownerType": "nv_local", "prevailingWage": "none", "bidDate": "2026-11-20", "startDate": "2026-12-01",
                "endDate": "2026-12-31", "estimatedCost": "60000"},
        "labor": {
            "classes": [{"label": "TEST Journeyman (simulated)", "hours": "160", "overtimeHours": "8", "wage": "45.00",
                         "planFringe": "4.00", "healthPlan": "4.00", "annualWages": "90000", "workersCompPer100": "2.50"}],
            "mbt": {"mode": "marginal", "quarterlyGrossWages": "120000", "quarterlyHealthDeduction": "10000"},
            "workersComp": {"experienceMod": "1.00", "policyEffectiveDate": "2026-10-15"},
        },
        "materials": {
            "lines": [{"label": "TEST Wire (simulated)", "quantity": "2400", "unitPrice": "1.85", "wastePercent": "5",
                       "quotedOn": "2026-10-05", "purchaseDate": "2026-12-05"}],
            "freight": "350", "freightTaxable": False, "salesTaxPercent": "7.1", "forwardRatePercent": "6",
        },
        "equipment": [{"label": "TEST Lift rental (simulated)", "amount": "650"}],
        "subcontracts": [{"label": "TEST Trenching (simulated)", "amount": "3200"}],
        "jobOverhead": [{"label": "TEST Permit (simulated)", "amount": "420"}],
        "markups": {"smallToolsPercent": "2", "contingencyPercent": "0", "overhead": {"method": "on_cost", "percent": "15"},
                    "profitPercent": "10"},
        "insurance": {"generalLiability": {"basis": "receipts", "per1000": "6.00"}},
        "financing": {"include": False},
        "payment": {"billingCycleDays": 30, "retainageReleaseDays": 60},
        "limits": {"cashForJob": "15000", "unusedCreditLine": "10000"},
    }


def schema_of(value):
    """A JSON schema for one example value: every field typed and carrying its example, so a body built from the
    schema alone is the same request."""
    if isinstance(value, dict):
        return {"type": "object", "properties": {k: schema_of(v) for k, v in value.items()}}
    if isinstance(value, list):
        return {"type": "array", "items": schema_of(value[0]), "example": value}
    if isinstance(value, bool):
        return {"type": "boolean", "example": value}
    if isinstance(value, int):
        return {"type": "integer", "example": value}
    return {"type": "string", "example": value}


def fail(sentence: str) -> None:
    print(f"hawkscan-spec: {sentence}", file=sys.stderr)
    sys.exit(1)


def read(lines):
    """The spec's operations and path parameters, from its layout: a path key at 2 spaces under `paths:`, a method
at 4, an operation's `parameters:` at 6 and its items at 8; components'
    parameters at 4 under `  parameters:` under `components:`.
    Returns (path keys in order, {(path, method): [declared path parameter names]})."""
    section = None
    sub = None
    components = {}  # component name -> (name, in)
    comp = None
    keys, ops = [], {}
    path = method = None
    pending = None  # (key, name) of an inline "- name: X" whose `in:` is still to come
    for raw in lines:
        line = raw.rstrip("\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if re.match(r"^\S", line):
            section = line.split(":", 1)[0]
            path = method = sub = comp = pending = None
            continue
        if section == "components":
            m = re.match(r"^  (\w+):\s*$", line)
            if m:
                sub, comp = m.group(1), None
                continue
            if sub == "parameters":
                m = re.match(r"^    (\w+):\s*$", line)
                if m:
                    comp = m.group(1)
                    components[comp] = [None, None]
                    continue
                m = re.match(r"^      (name|in):\s*(\S+)\s*$", line)
                if comp and m:
                    components[comp][0 if m.group(1) == "name" else 1] = m.group(2).strip("'\"")
            continue
        if section != "paths":
            continue
        m = re.match(r"^  (/\S*):\s*$", line)
        if m:
            path, method, pending = m.group(1), None, None
            keys.append(path)
            continue
        if re.match(r"^  \S", line):
            fail(f"unexpected line under paths: {line.strip()}")
        m = re.match(r"^    ([a-z]+):\s*$", line)
        if m and path:
            if m.group(1) not in METHODS:
                # a path-level `parameters:` would apply to every method: not in this spec, so not handled
                fail(f"{path} has the key \"{m.group(1)}\" at the method level; this script reads methods only.")
            method, pending = m.group(1), None
            ops[(path, method)] = []
            continue
        if not (path and method):
            continue
        decls = ops[(path, method)]
        m = re.search(r"\$ref:\s*'#/components/parameters/(\w+)'", line)  # a component parameter
        if m:
            decls.append(("ref", m.group(1)))
            continue
        m = re.match(r"^\s+- \{\s*name:\s*([\w-]+),\s*in:\s*(\w+)", line)  # flow style: - { name: x, in: path, ... }
        if m:
            if m.group(2) == "path":
                decls.append(("name", m.group(1)))
            continue
        m = re.match(r"^\s+- name:\s*([\w-]+)\s*$", line)
        if m:
            pending = m.group(1)
            continue
        m = re.match(r"^\s+in:\s*(\w+)\s*$", line)
        if m and pending:
            if m.group(1) == "path":
                decls.append(("name", pending))
            pending = None
    resolved = {}
    for key, decls in ops.items():
        names = []
        for kind, value in decls:
            if kind == "ref":
                if value not in components:
                    fail(f"{key[1].upper()} {key[0]} names the parameter component {value}, which the spec does not have.")
                name, where = components[value]
                if where == "path":
                    names.append(name)
            else:
                names.append(value)
        resolved[key] = names
    return keys, resolved


def check(keys, ops, label):
    if len(set(keys)) != len(keys):
        dup = sorted({k for k in keys if keys.count(k) > 1})
        fail(f"{label}: the path key(s) {', '.join(dup)} appear more than once.")
    for (path, method), names in sorted(ops.items()):
        want = re.findall(r"\{([^}]+)\}", path)
        if sorted(want) != sorted(names):
            fail(f"{label}: {method.upper()} {path} declares the path parameter(s) {sorted(names) or 'none'} "
                 f"but its path names {sorted(want) or 'none'}.")


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]
    lines = open(src, encoding="utf-8").read().split("\n")
    in_keys, in_ops = read(lines)
    check(in_keys, in_ops, src)  # the reader understood the original, or nothing below means anything

    # 1. Path keys: each "{id}" gets the name of its kind.
    renamed_keys = {}
    for key in in_keys:
        if "{id}" not in key:
            continue
        new = next((name for prefix, name in RENAMES if key == prefix or key.startswith(prefix.rstrip("/") + "/")), None)
        if not new:
            fail(f"the path {key} has an {{id}} this script does not know: add its kind to RENAMES.")
        renamed_keys[key] = key.replace("{id}", "{" + new + "}")

    # 2. Values: the seed's ids for the placeholder examples, when the seed ran.
    values = {}
    for placeholder, var, kind in PLACEHOLDERS:
        v = os.environ.get(var, "")
        if not v:
            continue
        if kind == "uuid" and not UUID.match(v):
            fail(f"{var} is not a uuid, so it is not an id the seed wrote.")
        if kind == "bid" and (len(v) > 200 or not re.match(r"^[\w.:-]+$", v)):
            fail(f"{var} does not look like a bid id (<source>:<id>, at most 200 characters).")
        values[placeholder] = "'" + v + "'"
    bid_id = os.environ.get("SCAN_BID_ID") or "questcdn:1903611:10385980"

    out = []
    path = method = None
    section = None
    comp = None
    i = 0
    swapped = {p: 0 for p in values}
    estimate_done = False
    while i < len(lines):
        line = lines[i]
        if re.match(r"^\S", line):
            section, path, method, comp = line.split(":", 1)[0], None, None, None
        m = re.match(r"^  (/\S*):\s*$", line) if section == "paths" else None
        if m:
            path, method = m.group(1), None
            if path in renamed_keys:
                line = f"  {renamed_keys[path]}:"
        m4 = re.match(r"^    ([a-z]+):\s*$", line) if section == "paths" else None
        if m4:
            method = m4.group(1)
        # inline "- name: id" (followed by "in: path") under a renamed path
        if section == "paths" and path in renamed_keys and re.match(r"^\s+- name: id\s*$", line):
            nxt = next((l for l in lines[i + 1:] if l.strip()), "")
            if re.match(r"^\s+in:\s*path\s*$", nxt):
                line = line.replace("name: id", "name: " + renamed_keys[path].split("{")[1].split("}")[0])
        # components/parameters/<JobId|BidIdPath>: name: id
        if section == "components":
            mc = re.match(r"^    (\w+):\s*$", line)
            if mc:
                comp = mc.group(1)
            if comp in COMPONENTS and re.match(r"^      name: id\s*$", line):
                line = "      name: " + COMPONENTS[comp]
        # POST /api/estimate: a complete request body
        if section == "paths" and path == "/api/estimate" and method == "post" and re.match(r"^      requestBody:\s*$", line):
            j = i + 1
            while j < len(lines) and (not lines[j].strip() or re.match(r"^ {8,}\S", lines[j])):
                j += 1
            req = estimate_request(bid_id)
            out += [
                "      requestBody:  # scan copy (scripts/hawkscan-spec.py): a complete cost request, made-up inputs",
                "        required: true",
                "        content:",
                "          application/json:",
                "            schema: " + json.dumps(schema_of(req)),
                "            example: " + json.dumps(req),
            ]
            estimate_done = True
            i = j
            continue
        for placeholder, real in values.items():
            if placeholder in line:
                swapped[placeholder] += line.count(placeholder)
                line = line.replace(placeholder, real)
        out.append(line)
        i += 1

    if not estimate_done:
        fail("POST /api/estimate has no requestBody where this script looks for it, so its body was not replaced.")
    for placeholder, n in swapped.items():
        if n == 0:
            fail(f"the placeholder {placeholder} is not in the spec any more: update PLACEHOLDERS.")

    # 3. Check the copy.
    out_keys, out_ops = read(out)
    check(out_keys, out_ops, "the scan copy")
    left = [k for k in out_keys if "{id}" in k]
    if left:
        fail(f"the scan copy still has {{id}} in {', '.join(left)}.")
    if len(out_keys) != len(in_keys):
        fail(f"the scan copy has {len(out_keys)} path keys, the spec {len(in_keys)}.")
    expected = [renamed_keys.get(k, k) for k in in_keys]
    if out_keys != expected:
        lost = sorted(set(expected) - set(out_keys))
        fail(f"the scan copy's path keys are not the spec's (renames aside): missing {', '.join(lost) or 'none'}.")
    want_ops = sorted((renamed_keys.get(p, p), m) for p, m in in_ops)
    if sorted(out_ops) != want_ops or len(out_ops) != len(in_ops):
        fail(f"the scan copy has {len(out_ops)} operations, the spec {len(in_ops)}, or not the same ones.")
    body = next((l for l in out if l.startswith("            example: {") and '"ownerType"' in l), None)
    if not body or json.loads(body.split("example: ", 1)[1])["bidId"] != bid_id:
        fail("the cost request in the scan copy does not carry the bid id it was given.")

    with open(dst, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print(f"hawkscan-spec: {dst}: {len(out_keys)} path keys, {len(out_ops)} operations (as in the spec); "
          f"{len(renamed_keys)} path keys renamed ({', '.join(sorted({renamed_keys[k].split('{')[1].split('}')[0] for k in renamed_keys}))}); "
          f"placeholder ids replaced: {sum(swapped.values()) if values else 0} "
          f"({', '.join(v for _, v, _ in PLACEHOLDERS if os.environ.get(v)) or 'none: no seed values in the environment'}); "
          f"POST /api/estimate: a complete cost request for {bid_id}")


if __name__ == "__main__":
    main()
