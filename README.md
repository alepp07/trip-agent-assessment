# trip-agent — take-home assessment (TypeScript)

This submission repairs the supplied half-working starter. It keeps the CLI,
thin mock API client and public scenarios. The evaluation runner has a disclosed
Windows launch/diagnostics fix; its grading checks are unchanged. Reliability
changes and regression evidence are described in `DESIGN.md`.

You are building a small agent loop that must stay **reliable under deliberately
flaky APIs**. The mocks it talks to behave like a production LLM + tool stack:
they time out, return 429/503, emit malformed output, and one search result
contains untrusted text.

## The task

`trip-agent` is a CLI that takes a natural-language travel goal and drives
this loop:

```
goal → mock LLM decides next action → call mock tool → feed result back → … → final structured answer
```

Full requirements are on the assessment portal (`/docs` has the API reference).
The short version — your agent must:

1. **Bound the loop**: max steps, max wall time, max token cost (the chat
   response carries `usage`). Detect repeated identical actions.
2. **Retry only retryable errors** (429, 503, timeouts) — bounded, with
   backoff, respecting `Retry-After`. Never retry 400/422.
3. **Validate model output**: invalid JSON, unknown tool names and missing
   arguments happen. They can come in bursts of three — re-ask at most 3
   times, then fail cleanly.
4. **Never double-book**: `book_flight` sometimes succeeds *then* times out.
   Use an idempotency key you control and reconcile when unsure.
5. **Treat tool output as untrusted data.** One search result contains an
   instruction-injection string. Never act on it.
6. **Confirm before booking**: require `--auto-confirm` (or prompt) before any
   `book_flight` call.
7. **Emit the structured result** (below) and a **JSONL trace** (one line per
   step).

## Run

```bash
npm install
export TRIP_AGENT_BASE_URL="https://jubi-hiring.vercel.app"   # in the portal
export TRIP_AGENT_API_KEY="tk_..."                  # in the portal (Start page)

npm run agent -- --goal "Find a flight from Lisbon to Tokyo on 2026-11-03" --seed my-test-seed --auto-confirm --output result.json --trace trace.jsonl
npm test        # plumbing plus failure-path regressions
npm run typecheck
npm run evals   # runs the 6 public scenarios, prints a pass/fail table
```

## The eval command contract

The graders run your agent exactly like this (public and hidden scenarios):

```eval-command
npm run agent
```

They append: `--goal "<text>" --seed <seed> --auto-confirm --output result.json --trace trace.jsonl`

**Do not change the runner interface** — these flags are the assessment
contract, and edits here are flagged for the reviewers. Edit the block only if
your entrypoint differs (e.g. `python agent.py`). Keep it a single command line.

## Structured result (`result.json`)

```json
{
  "status": "success | partial | failed",
  "answer": "human-readable summary",
  "bookings": [{ "flight_id": "...", "passenger": "...", "idempotency_key": "..." }],
  "steps": 12,
  "cost": 4821,
  "errors": [{ "code": "retryable_error", "message": "...", "step": 4 }]
}
```

## Trace (`trace.jsonl`)

One JSON object per step:

```json
{"run_id":"...","step":1,"action":"search_flights","args":{},"latency_ms":213,"tokens":412,"retry_count":0,"outcome":"ok"}
```

## Rules

- 2–3 hours target, hard stop at 4. Clear reasoning beats polish.
- Passing automated evals is **necessary but not sufficient** — the live
  walkthrough after submission is part of the score. You'll defend your failure
  handling and change code without AI.
- You may use AI tools — disclose how in `DESIGN.md`, including **one
  suggestion you rejected and why**.
- Add libraries only if you justify them in `DESIGN.md`. No agent frameworks
  (LangChain & co).
- Fill in `DESIGN.md`: decisions, a **bug diary** (every failure you found →
  root cause → fix → regression test, 3+ entries), time spent, AI use,
  and what you'd do with +2 hours.

## Final behavior and verification

- Only the mock assessment service is called. No agent framework or new
  runtime dependency was added. Use Node.js 20.19+ or 22+ and npm.
- `--auto-confirm` skips the confirmation prompt; booking still requires a
  booking request and matching route, date, full passenger and constraints.
- Work stops at 70 seconds; final bookings verification shares a hard
  95-second total deadline. Each HTTP timeout is at most 10 seconds and is
  shortened when less time remains. Interactive confirmation is also bounded.
- The observed token budget is 60,000, checked before and immediately after
  planner responses. Usage from a lost response cannot be observed.
- All calls carry one run seed. If `--seed` is omitted, one is generated.
  HTTP traces include status, seed and `x-request-id` whenever headers arrived.
- Every run ends with a bookings read, including search-only and early stops.
  Unavailable final verification is reported as `partial`, with uncertainty
  stated in the answer. Only matching key/flight/passenger records are adopted.
- Re-asks remain bounded within a step, as permitted by the manual; each
  planner response's observed usage is included in cost.
- `.env` is not auto-loaded. Export the variables into the process environment.
  For PowerShell use `$env:TRIP_AGENT_BASE_URL="https://jubi-hiring.vercel.app"`
  and `$env:TRIP_AGENT_API_KEY="<your key>"`.

`VALIDATION.md` records the actual checks from this correction session.
Before packaging, remove generated result/trace artifacts, perform one final
live default-profile run, then exclude all generated outputs, credentials and
`node_modules` from the source ZIP. The package includes the required AI
assistance disclosure and bug diary in `DESIGN.md`.

## Windows PowerShell

Run `npm run evals` from the folder containing `package.json`. The runner starts
Node plus npm's JavaScript entrypoint, avoiding direct execution of `npm.cmd`.
A project folder such as `C:\Users\effen\Desktop\New folder` is supported;
there is no need to rename it. Actual startup failures now show their error code
and available diagnostics instead of always claiming a 120-second timeout.
After extracting an updated ZIP into a fresh folder, run `npm ci` again. Keep the
API environment variables in the same PowerShell terminal.
