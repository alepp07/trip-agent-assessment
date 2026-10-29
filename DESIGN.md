# DESIGN.md: trip-agent

## How I spent my time

**Total completion time: 1 hour 40 minutes (100 minutes).** This is my reported
total for the assessment, including reading the brief and starter, discussing
ideas with Claude, implementation and debugging with ChatGPT/Codex as the working
coding agent, regression testing, live API checks, the Windows PowerShell launcher
correction, local verification and final documentation/packaging.

Claude contributed ideas and planning. ChatGPT/Codex performed the implementation
and execution work. I supplied direction and confirmed that the final public
evaluation suite passed all six scenarios on my Windows PowerShell setup.

## Design decisions

| Decision | Why | What I gave up |
|---|---|---|
| Kept the starter's structure and exports, but replaced its three separate retry loops (planner, tools, booking) with one `withRetries` helper | The loops had drifted apart, which is where the bugs were (booking retried differently from reads). One policy means one place to fix and one place to test | A bigger diff than "patch each bug" |
| Retry only 429, 5xx, timeouts, network errors, and 200 responses with a body that fails validation. Never other 4xx | Retrying a 400/422 cannot succeed and burns the 60 req/min budget | Nothing |
| Backoff 400ms x 2^n, capped at 4s, with jitter. `Retry-After` replaces the backoff exactly, including values over 30s and HTTP dates. A wait that would pass the applicable deadline ends the run as `partial` | Respect the server, but never hang the grader | A 429 with a very long Retry-After ends the run instead of waiting |
| One booking key per intent: `sha256(flight_id + passenger)`. Every retry and replay reuses it | Different key plus same flight and passenger is a recorded duplicate. The key is derived from intent, not from the attempt number | Rebooking the same person on the same flight is impossible by design |
| After a booking timeout, check `GET /bookings` for our key, flight and passenger before retrying | The server may commit and then hang. Checking saves a 12s hang and avoids blind retries | One extra GET per timeout |
| Before booking, adopt any existing booking for the same flight and passenger (any key) instead of sending a new one | A different key is recorded as a duplicate. Reruns, older code or other tools can leave bookings this process never made | One extra GET per booking. If it fails we stop without a new write, because the account may already hold the booking under another key |
| End of run: `result.bookings` is rebuilt from `GET /bookings`, filtered to the key, flight and passenger intents this run attempted or adopted | The server decides what happened. A local record the server does not hold is dropped and reported | If `/bookings` is unreachable, keep acknowledged records with an explicit unverified label and return `partial`; do not claim server confirmation |
| Booking guard before any write: the user must have requested a booking; flight_id must come from this run's search results and match the requested origin, destination and date; the full passenger name, price budget, nonstop and cheapest requirements must hold | The planner is gullible by design. The allowlist stops an injected flight even if the text filter misses it | A rare false block if my goal parsing is wrong. It is reported as `booking_blocked`, not silent |
| Sanitizer drops whole instruction-like sentences from every string in tool data and keeps the rest | `notes` may carry useful text. Sentence-level removal keeps it | Pattern list can miss a novel phrasing. The allowlist is the backstop |
| Re-asks happen inside the same step and resend the same conversation. No corrective message is added | The planner is a mock that appears to key on the conversation. Faults are rolled per call, so a resend gets a fresh roll. Extra messages also eat the 50-message limit | A real LLM would benefit from feedback text. This one does not need it |
| Stale weather: refetch once, then report what happened in the answer | Yesterday's weather is wrong for the question. One refetch is cheap, more is a loop | Two stale reads in a row are reported as a warning, not fixed |
| `success` requires evidence: flights found (if flights were needed), a server-held booking (if booking was asked), weather present (if weather was asked) | The starter returned `success` for Paris to Paris because a search ran | Stricter, so more `failed` results on odd goals |

### Caps

| Cap | Value | Reason |
|---|---|---|
| Steps | 20 | A normal run is 3 to 5. Re-asks do not count as steps |
| Work wall time | 70s | Includes planner, tools, confirmations and retry waits |
| Overall wall time | 95s | Fixed start time, includes the one final reconciliation window, below the 120s harness |
| Tokens | 60,000 | Spec says order of 1e4 to 1e5. Checked before planner calls and immediately after each received planner response, before executing a tool or accepting completion |
| Per-call timeout | At most 10s | Shortened to the remaining applicable deadline; server hangs about 12s |
| Retries per call | 4 (planner, tools, book), 2 (reconcile) | 5 attempts rides out a 503 storm without burning the wall clock |
| Consecutive malformed planner outputs | 3, then `failed` | Spec: bursts of three |
| Consecutive repeated actions | 3, then `partial` | Loop fault |
| Blocked booking attempts | 2, then `partial` | Planner is not going to fix itself |

## Failure taxonomy

| Class | Examples | Agent does | Status |
|---|---|---|---|
| Transient transport | 429, 5xx, timeout, network error, 200 with garbage body | Retry with backoff or Retry-After, bounded | continues |
| Permanent client error | 400, 401, 403, 422 | No HTTP retry. Client validation errors are shown once; an identical repeat stops before another HTTP call. Auth errors stop immediately | `partial` |
| Planner unavailable | Retries exhausted, or 4xx on chat | Stop | `failed` |
| Malformed planner output | Bad JSON args, unknown tool, missing args, garbled or empty final answer, final answer before any search | Re-ask within the step, up to 3 in a row | `failed` after the 4th |
| Planner loop | Same completed action again | Suppress, re-ask, stop at 3 | `partial` |
| Untrusted content | Instruction text in `notes` | Redact sentence, never act on it, allowlist booking | continues |
| Unsafe write | Unknown flight_id, unnamed passenger, wrong flight for "cheapest" or "nonstop" | Block, tell planner, stop after 2 | `partial` |
| Unknown write outcome | Booking timed out and `/bookings` unreachable | Stop, no blind retry, record `booking_unconfirmed` | `partial` |
| Budget exhaustion | Steps, wall time, tokens | Stop cleanly with a reason in `errors[]` | `partial` |
| Impossible goal | Same origin and destination, no flights | Say so | `failed` |
| Unexpected exception | Anything else | Caught, still writes `result.json` and the trace | `failed` |

## AI tools I used, and how

I used two AI tools with different roles:

- **Claude (Anthropic): ideas and planning.** Claude contributed ideas about the
  approach, reliability risks, failure-handling strategies and design tradeoffs.
  I used those discussions to consider possible ways to improve the starter.
- **ChatGPT/Codex: working coding agent.** ChatGPT/Codex carried out the
  implementation and execution work: inspecting the starter, investigating
  defects, applying code changes, writing and extending regression tests,
  running local checks and live public evaluations, preparing documentation,
  and packaging the source ZIP. It also reviewed the uploaded version, fixed
  the additional failure cases and corrected the Windows evaluation launcher.
- **My role:** I provided the assessment requirements and direction, ran the
  project locally in Windows PowerShell, and verified the final public
  evaluation output. The final Windows run passed all six public scenarios.

This was substantial AI-assisted implementation. I will need to understand,
explain and modify the submitted code without AI during the follow-up.

**Suggestion rejected:** Claude proposed a client-side rate limiter of about
50 requests per minute. I chose not to add it: a limiter inside one agent process
would not coordinate separate evaluation processes, while the implementation
already honours `Retry-After` and stops when the required wait cannot fit its
deadline. That extra mechanism would add complexity without solving cross-process
coordination. A shared limiter remains a possible future improvement.

## Bug diary

Entries 1 to 8 were found by reading the starter and proven with a test. Entry 9 was found on the live API, from the portal's stats page.

| # | Failure | Root cause | Fix | Regression test |
|---|---|---|---|---|
| 1 | A 422 was retried several times | `isRetryableStatus` returned true for any status >= 400 | Only 429 and 5xx | `retry policy > never retries a 422...`, `isRetryableStatus: only 429 and 5xx` |
| 2 | Booking after a timeout-after-commit made a second booking | Key was `${hash}_${attempt}`, so the retry used a new key | One key per intent, reused by every retry, with a `/bookings` check by key after a timeout | `timeout AFTER commit...`, `503 storm on book...` |
| 3 | Wall clock and caps never fired | `startedAt` was reset every loop. Caps were 400 steps, 240s, 4M tokens, 5000 repeats | Fixed start time, real caps, token check before every planner call | `wall clock...`, `token cap...`, `stops a planner that repeats...` |
| 4 | Paris to Paris reported `success` | `finish()` counted any completed search as success | Success needs flights found, plus booking and weather when asked | `impossible goal...` |
| 5 | `result.bookings` could claim a booking that was not ours | Reconcile matched on `flight_id` only and wrote `key: "reconciled"` | Match by idempotency key. Rebuild from the server list | `drops a booking from result.json...` |
| 6 | Injected `XX999` could be booked | Sanitizer matched one phrase and nothing checked the flight_id | Broader sanitizer plus allowlist of searched flight_ids, passenger and constraint guard | `blocks a flight_id that was not in the search results`, `never forwards the injection text...` |
| 7 | Network error crashed the run with no `result.json` and no trace | Non-timeout errors were rethrown. Trace was only written at the end | Network errors are retried. All exceptions end in a valid `failed` result. Trace is appended line by line | `planner permanently down...` |
| 8 | Stale weather was passed on silently | No refetch | Refetch once, report in the answer | `weather > stale once`, `stale twice` |
| 9 | Live stats showed 4 bookings (2 unique): my agent re-booked flights another run had already booked | Idempotency only protects against my own key. A booking made earlier under a different key was invisible, so a new key was sent and recorded as a duplicate | Before any booking, read `/bookings`; if the same flight and passenger exist under any key, adopt that booking and send nothing. Passenger names are also normalised for spaces and case | `bookings made by something else > adopts an existing booking...` |

## What I'd do with +2 more hours

1. Run the public evals and my own goals on many more seeds and read every trace. I ran the public seeds only a couple of times, so rare fault combinations are untested live.
2. Tune the sanitizer against the real injection text, and decide whether to keep `notes` at all.
3. Add a cross-run rate limiter if hidden scenarios run back to back and trip 429.
4. Parse goals with the planner instead of regexes, with the regex as a check.

## Corrections after the independent review

Claude's contribution was idea development and discussion of the approach.
ChatGPT/Codex acted as the working coding agent for implementation, review and
execution. During the review it reproduced failures in offline tests, patched
this version of the code, added regression tests, and ran local and live checks.
I subsequently ran the corrected project in Windows PowerShell and confirmed
that all six public evaluations passed.

| Reproduced issue | Correction | Regression in `tests/review-regressions.test.ts` |
|---|---|---|
| Search-only goals could cause a write | Require positive booking intent; respect explicit negation | Information-only and negated-goal cases |
| Wrong-route search/booking could report success | Validate search arguments and response metadata, selected flight, full passenger, date and constraints against the goal | Wrong route/date, response metadata, full-name and price-budget cases |
| Retry-After 45s became 30s | Remove clamp; support seconds, zero and HTTP dates; stop if full wait cannot fit | Longer-than-30s, HTTP-date and cannot-fit cases |
| Multiple reconciliations bypassed the clock and could exceed 120s | 70s work / 95s total deadlines; reserve one bounded final verification; shorten attempts to remaining time | Repeated reconciliation failure and expired-confirmation cases |
| Reconciliation omitted seeds and response IDs | All bookings reads use the shared retry helper, one run seed and response metadata | Seed propagation, generated seed and request-ID cases |
| Search-only runs skipped reconciliation; failed verification could still report success | Always check at the end; return partial with explicit uncertainty if unavailable | Search-only/fatal-stop checks and unavailable-verification case |
| Final response could cross the token cap and still return success | Charge each received planner response and check immediately, before dispatch | Over-budget final-answer and booking cases |
| Response-body timeout was swallowed as bad JSON | Preserve timeout identity and received request metadata | Response-body timeout case |

Reconciliation now matches the full key/flight/passenger tuple. A lost write
response followed by unavailable recovery reads stops further writes; the final
reserved check can still recover the committed booking. This has a dedicated
regression. The initial existing-bookings check also fails closed when server
truth is unavailable. Existing-booking adoption under an older key is retained.

All request/confirmation/retry waits share a deadline; no `ignoreBudget` path
remains. An omitted CLI seed becomes one generated seed carried in every chat
body and tool query. Responses include `x-request-id` in the trace whenever
headers were received, including body-read timeouts. Final reconciliation runs
for search-only and failed runs as well as booking runs.

At the end of the first correction round, the public runner and scenario files were unchanged. Launch scripts use
`node --import tsx` to avoid the tsx CLI's optional IPC socket in the review
workspace, while preserving the same npm command and CLI flags. No dependency
was added. The fake HTTP fault matcher was updated to inspect URL pathname, so
adding the required seed query does not silently disable its bookings fault.

The total of 1 hour 40 minutes above includes the review, corrections and
Windows verification. `VALIDATION.md` records the checks performed and a measured
automated sub-phase; that sub-phase is part of the total, not additional time.

Unchanged permanent tool failures are now suppressed across planner iterations as well as inside HTTP retries. The existing 422 regression verifies exactly one outbound request.

## Windows PowerShell launch correction

A subsequent Windows PowerShell run reported all six scenarios as timed out.
Inspection found the starter runner called `spawnSync("npm", ...)`, which relies
on Unix executable lookup and does not correctly launch Windows `npm.cmd` in
this no-shell form. Its failure formatter also treated every null exit status
as a timeout. A reproduced ENOENT startup failure returned after 2 ms but would
have been labelled "timed out after 120000ms" by that formatter. The user's
actual machine error was not directly inspected; the runner bug and misleading
diagnostic were independently verified.

`evals/process.ts` now launches the same `npm run agent -- <flags>` contract
through `process.execPath` and npm's `npm_execpath` JavaScript entrypoint. It uses
an argument array and no shell, so Windows executable/project paths containing
spaces and travel-goal punctuation remain separate arguments. `npm run evals`
supplies `npm_execpath`; direct invocation without npm reports how to start it.

The runner now distinguishes ENOENT/other startup failures, ETIMEDOUT, signals
and ordinary exit codes, preserving bounded stderr/stdout diagnostics. It removes
an old result before each scenario so a stale file cannot hide a launch failure.
Only process-launch, stale-output cleanup and diagnostics changed in the public
runner. Scenario JSON, expectations, timeout, booking checks, replay checks and
pass/fail assertions are unchanged. This is a disclosed portability fix, not a
change to what passing means.

Four additional tests verify Windows-style executable paths with spaces,
argument preservation, real npm execution in a directory containing spaces,
and startup/timeout/nonzero-exit diagnostics. The coding agent ran its automated
checks and live evaluations in Linux. I then ran the public evaluation suite in
Windows PowerShell and confirmed 6/6 passed, including verified idempotent replays
for the booking scenarios.
