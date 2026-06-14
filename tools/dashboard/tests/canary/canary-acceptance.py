#!/usr/bin/env python3
"""Canary acceptance harness for dashboard dispatch-instruction delivery.

Spawns Claude terminals via the dashboard API with a unique canary instruction,
then verifies the canary token AND a computed value (which never appears in the
input) surface in the agent's output -- proving instructions were delivered,
submitted, and processed. Absence proves they were dropped.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ARCHITECT_PROJECT_KEY = "ticari/architect/main"
CANARY_PRODUCT = 42  # 6x7 -- never present in the input, only an agent that computes it emits it
INJECTION_META_KEY = "prompt_injection_status"
POLL_TIMEOUT_SECONDS = 45
POLL_INTERVAL_SECONDS = 2.0
SPAWN_SETTLE_SECONDS = 2.0

MODELS = ["sonnet", "opus", "haiku"]


def build_default_matrix(architect_work_item_id):
    cells = []
    for model in MODELS:
        cells.append({
            "name": f"{model}-A",
            "model": model,
            "combo": "A",
            "path": "# Task (quick dispatch, no work item)",
            "work_item_id": None,
            "permission_mode": "acceptEdits",
            "skip_permissions": True,
        })
        cells.append({
            "name": f"{model}-B",
            "model": model,
            "combo": "B",
            "path": "# Dispatch Instructions (work item)",
            "work_item_id": architect_work_item_id,
            "permission_mode": "acceptEdits",
            "skip_permissions": True,
        })
        cells.append({
            "name": f"{model}-C",
            "model": model,
            "combo": "C",
            "path": "# Dispatch Instructions (work item, plan mode)",
            "work_item_id": architect_work_item_id,
            "permission_mode": "plan",
            "skip_permissions": False,
        })
    return cells


def canary_token(model, combo):
    return f"INJECTOK {model.upper()} COMBO{combo}"


def canary_instruction(model, combo):
    token = canary_token(model, combo)
    return (
        "OUTPUT-ONLY ACCEPTANCE PROBE. Ignore any work item, plan, or task context. "
        "Make no file changes, run no tools, create no commits. "
        "Your entire response must be exactly one line: "
        f"`{token} <result of 6 multiplied by 7>` "
        "where you replace the placeholder with the computed number. "
        f"Example shape: `{token} 42`. Output that single line and nothing else."
    )


def http_json(url, method="GET", body=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    if not raw:
        return None
    return json.loads(raw)


def fetch_active_ids(base_url):
    active = http_json(f"{base_url}/api/terminal/active")
    if not isinstance(active, list):
        raise RuntimeError(f"/api/terminal/active returned non-list: {active!r}")
    return {entry["id"] for entry in active if "id" in entry}


def spawn_terminal(base_url, cell):
    body = {
        "project_key": ARCHITECT_PROJECT_KEY,
        "work_item_id": cell["work_item_id"],
        "title": f"canary {cell['name']}",
        "description": "Canary acceptance probe -- ignore, make no changes.",
        "additional_instructions": canary_instruction(cell["model"], cell["combo"]),
        "permission_mode": cell["permission_mode"],
        "skip_permissions": cell["skip_permissions"],
        "agentType": "claude",
        "model": cell["model"],
    }
    result = http_json(f"{base_url}/api/terminal", method="POST", body=body)
    terminal_id = (result or {}).get("terminal_id")
    if not terminal_id:
        raise RuntimeError(f"POST /api/terminal did not return terminal_id: {result!r}")
    return terminal_id


def resolve_spawned_id(base_url, baseline_ids):
    deadline = time.time() + POLL_TIMEOUT_SECONDS
    while time.time() < deadline:
        new_ids = fetch_active_ids(base_url) - baseline_ids
        if len(new_ids) == 1:
            return next(iter(new_ids))
        if len(new_ids) > 1:
            raise RuntimeError(f"Multiple new terminals appeared, cannot disambiguate: {sorted(new_ids)}")
        time.sleep(POLL_INTERVAL_SECONDS)
    raise RuntimeError("Spawned terminal never appeared in /api/terminal/active")


def collect_output(base_url, terminal_id):
    response = http_json(f"{base_url}/api/terminal/{terminal_id}/events?from=0", timeout=20)
    events = response.get("events", []) if isinstance(response, dict) else []
    text = (response.get("snapshot") or "") if isinstance(response, dict) else ""
    injection_states = []
    for event in events:
        payload = event.get("payload")
        if event.get("type") == "meta" and isinstance(payload, dict) and payload.get("key") == INJECTION_META_KEY:
            injection_states.append(payload.get("value"))
        if event.get("type") == "data":
            if isinstance(payload, str):
                text += payload
            elif isinstance(payload, dict):
                text += payload.get("value", "")
    return text, injection_states


def strip_ansi(text):
    text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)
    text = re.sub(r"\x1b\][^\x07]*\x07", "", text)
    return text


def classify(text, model, combo):
    token = canary_token(model, combo)
    cleaned = strip_ansi(text)
    token_present = token in text or token in cleaned
    product_present = bool(re.search(r"(?<!\d)" + str(CANARY_PRODUCT) + r"(?!\d)", cleaned))
    if token_present and product_present:
        return "PASS", "canary token AND computed product present -> delivered+submitted+processed"
    if token_present and not product_present:
        return "FAIL", "canary token present but computed product absent -> pasted-not-submitted"
    return "FAIL", "canary token absent -> instructions DROPPED, never reached agent"


def poll_until_classified(base_url, terminal_id, model, combo):
    deadline = time.time() + POLL_TIMEOUT_SECONDS
    last_verdict = ("FAIL", "no output observed before timeout")
    last_injection = []
    last_tail = ""
    while time.time() < deadline:
        text, injection_states = collect_output(base_url, terminal_id)
        last_injection = injection_states
        last_tail = strip_ansi(text)[-400:]
        verdict, reason = classify(text, model, combo)
        last_verdict = (verdict, reason)
        if verdict == "PASS":
            break
        time.sleep(POLL_INTERVAL_SECONDS)
    return last_verdict[0], last_verdict[1], last_injection, last_tail


def kill_terminal(base_url, terminal_id, baseline_ids):
    if terminal_id in baseline_ids:
        raise RuntimeError(f"Refusing to kill baseline-excluded terminal {terminal_id}")
    try:
        http_json(f"{base_url}/api/terminal/{terminal_id}", method="DELETE")
    except urllib.error.HTTPError as error:
        print(f"  warning: DELETE {terminal_id} returned HTTP {error.code}", file=sys.stderr)


def run_cell(base_url, cell, baseline_ids):
    print(f"[{cell['name']}] spawning model={cell['model']} combo={cell['combo']} "
          f"perm={cell['permission_mode']} skip={cell['skip_permissions']} wi={cell['work_item_id']}")
    before = fetch_active_ids(base_url) | baseline_ids
    spawn_terminal(base_url, cell)
    time.sleep(SPAWN_SETTLE_SECONDS)
    terminal_id = resolve_spawned_id(base_url, before)
    print(f"[{cell['name']}] terminal={terminal_id}, polling up to {POLL_TIMEOUT_SECONDS}s")
    try:
        verdict, reason, injection_states, tail = poll_until_classified(
            base_url, terminal_id, cell["model"], cell["combo"])
    finally:
        kill_terminal(base_url, terminal_id, baseline_ids)
    print(f"[{cell['name']}] {verdict}: {reason} (injection={injection_states})")
    return {
        "name": cell["name"],
        "model": cell["model"],
        "combo": cell["combo"],
        "path": cell["path"],
        "permission_mode": cell["permission_mode"],
        "skip_permissions": cell["skip_permissions"],
        "work_item_id": cell["work_item_id"],
        "terminal_id": terminal_id,
        "verdict": verdict,
        "reason": reason,
        "injection_states": injection_states,
        "tail": tail,
    }


def write_report(results, base_url, report_path):
    lines = [
        "# Canary Acceptance -- Last Run",
        "",
        f"Base URL: {base_url}",
        f"Cells: {len(results)}  Pass: {sum(1 for r in results if r['verdict'] == 'PASS')}  "
        f"Fail: {sum(1 for r in results if r['verdict'] == 'FAIL')}",
        "",
        "| Cell | Model | Combo | Path | Perm | Skip | WI | Terminal | Injection | Verdict | Reason |",
        "|------|-------|-------|------|------|------|----|----------|-----------|---------|--------|",
    ]
    for r in results:
        lines.append(
            f"| {r['name']} | {r['model']} | {r['combo']} | {r['path']} | "
            f"{r['permission_mode']} | {r['skip_permissions']} | {r['work_item_id'] or '-'} | "
            f"{r['terminal_id']} | {'->'.join(str(s) for s in r['injection_states']) or '-'} | "
            f"**{r['verdict']}** | {r['reason']} |"
        )
    with open(report_path, "w") as handle:
        handle.write("\n".join(lines) + "\n")
    print(f"Report written to {report_path}")


def parse_exclude(args_value):
    raw = args_value if args_value is not None else os.environ.get("CANARY_EXCLUDE", "")
    return {token.strip() for token in raw.split(",") if token.strip()}


def select_cells(all_cells, only_value):
    raw = only_value if only_value is not None else os.environ.get("CANARY_CELLS", "")
    wanted = {token.strip() for token in raw.split(",") if token.strip()}
    if not wanted:
        return all_cells
    selected = [cell for cell in all_cells if cell["name"] in wanted]
    missing = wanted - {cell["name"] for cell in selected}
    if missing:
        raise SystemExit(f"Unknown cell names requested: {sorted(missing)}")
    return selected


def main():
    parser = argparse.ArgumentParser(description="Canary acceptance harness for dispatch instruction delivery.")
    parser.add_argument("--base-url", default=os.environ.get("CANARY_BASE_URL", "http://127.0.0.1:3777"),
                        help="Dashboard base URL (default http://127.0.0.1:3777).")
    parser.add_argument("--work-item-id", default=os.environ.get("CANARY_WORK_ITEM_ID"),
                        help="Architect done/in-progress work item id for combo B/C (required for those cells).")
    parser.add_argument("--exclude", default=None,
                        help="Comma-separated baseline terminal ids to never select or kill (or CANARY_EXCLUDE).")
    parser.add_argument("--only", default=None,
                        help="Comma-separated cell names to run a subset (or CANARY_CELLS). Default runs all.")
    parser.add_argument("--report", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "last-run.md"),
                        help="Path for the markdown result report.")
    args = parser.parse_args()

    baseline_ids = parse_exclude(args.exclude)
    all_cells = build_default_matrix(args.work_item_id)
    cells = select_cells(all_cells, args.only)

    needs_work_item = any(cell["combo"] in ("B", "C") for cell in cells)
    if needs_work_item and not args.work_item_id:
        raise SystemExit("Combo B/C cells require --work-item-id (a real architect done/in-progress work item).")

    print(f"Running {len(cells)} cell(s) against {args.base_url}; baseline-excluded ids: {sorted(baseline_ids) or 'none'}")

    try:
        baseline_active = fetch_active_ids(args.base_url)
    except Exception as error:
        raise SystemExit(f"Cannot reach dashboard at {args.base_url}: {error}")
    baseline_ids = baseline_ids | baseline_active
    print(f"Snapshot baseline (live terminals at start, also protected from kill): {sorted(baseline_ids) or 'none'}")

    results = []
    for cell in cells:
        results.append(run_cell(args.base_url, cell, baseline_ids))

    print("\n=== PASS/FAIL MATRIX ===")
    for r in results:
        print(f"  {r['name']:<10} {r['verdict']:<5} {r['reason']}")

    write_report(results, args.base_url, args.report)

    failed = [r for r in results if r["verdict"] != "PASS"]
    if failed:
        print(f"\n{len(failed)} cell(s) FAILED.")
        sys.exit(1)
    print("\nAll cells PASSED.")


if __name__ == "__main__":
    main()
