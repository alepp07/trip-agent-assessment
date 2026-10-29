# Validation: corrections to the uploaded final ZIP

## Checks performed

- `npm test`: **56 tests passed** across four test files (32 existing tests, 20 agent regressions and 4 process-launch tests).
- `npm run typecheck`: **passed**.
- `npm run evals`: **6/6 public scenarios passed**, runner exit code 0.
- All six scenario JSON files and the public evaluation assertions are unchanged. The runner has only the disclosed Windows process-launch, stale-result cleanup and error-reporting changes described below.
- Both booking scenarios passed as server-verified idempotent replays. Existing older-key booking adoption was retained to avoid creating another record for the same intent.
- Public traces have one-based steps; their token sums equal `result.cost`; all traced received HTTP responses have request IDs.

| Public scenario | Result status | Steps | Observed tokens | Confirmed bookings |
|---|---|---|---|---|
| 01-simple-search | success | 2 | 484 | 0 |
| 02-search-weather | success | 3 | 798 | 0 |
| 03-booking-happy-path | success | 3 | 907 | 1 |
| 04-booking-503-storm | success | 3 | 828 | 1 |
| 05-malformed-burst | success | 3 | 804 | 0 |
| 06-impossible-goal | failed | 2 | 305 | 0 |

`failed` is the correct result for the impossible Paris-to-Paris scenario;
it creates no booking and passes the public scenario's expectation.

## Reproduced failures now covered

The review reproduced a search-only booking, a wrong-route booking reporting
success, a 45-second Retry-After shortened to 30 seconds, a failure sequence
lasting 121.4 virtual seconds, unseeded bookings reads, absent request IDs,
skipped search-only reconciliation, and an over-budget successful final answer.

New tests now establish:

- Information-only and explicitly negated goals create no bookings.
- Wrong search route/date/metadata, incomplete passenger names and price-budget
  violations cannot cause a booking.
- Retry-After of 45 seconds is honoured fully; a delay exceeding the deadline
  stops instead of retrying early; HTTP-date delays are supported.
- Work, confirmation and final reconciliation share bounded deadlines. The
  previously overlong failure sequence completes below the 95-second cap.
- All requests carry the same seed, including every bookings read. Every
  received response is logged with its request ID.
- Search-only and fatal-stop runs still reconcile. Unavailable final server
  verification returns partial and labels any acknowledged booking unverified.
- Over-budget final answers cannot return success; over-budget tool requests
  cannot trigger a booking.
- A committed booking followed by failed recovery reads does not cause another
  write; final reconciliation can still recover the committed record.
- Yesterday-dated stale weather is accepted, refreshed once and explained.
- Response-body timeouts preserve their classification and received request ID.
- Existing-booking adoption and stable retry keys still pass the original tests.

The existing HTTP 422 regression was strengthened: an unchanged rejected call
is sent once, even if the planner repeats it. The fake bookings fault matcher
now checks pathname, so mandatory seed query parameters do not disable it.

## Final live smoke run

Deleted the root result/trace artifacts, then ran the final implementation through
`npm run agent --` with the public Porto-to-Oslo booking goal, seed `pub3`,
`--auto-confirm --output result.json --trace trace.jsonl` against the live default
fault profile. Result: **success**, 3 steps, 1057
observed tokens, one server-confirmed existing booking. Final bookings response
ID: `55c0557f-6607-4a46-a170-d015965d8e87`.

Generated result/trace files, dependency directories, disposable review scripts,
personal credentials and binaries are excluded from the ZIP. No hidden seeds
or hidden scenarios were probed. Passing public cases does not establish that
all hidden cases pass; the required live walkthrough remains part of grading.

## Time and disclosure

**Candidate-reported total completion time: 1 hour 40 minutes (100 minutes).**
This includes planning, AI-assisted implementation, reviews, corrections,
regression tests, live evaluation runs, Windows PowerShell verification and
final documentation/packaging.

An earlier measured patch/verification sub-phase took approximately 9 minutes;
that is a component of the reported total, not additional time. It is not an
independent measurement of all candidate work. `DESIGN.md` records Claude's
contribution to ideas and planning, ChatGPT/Codex's role as the working coding
agent, and the candidate's local Windows verification.

## Windows launcher follow-up

The user reported six "timed out after 120000ms" results from Windows PowerShell.
The runner used `spawnSync("npm", ...)` and labelled every null child exit status
as a timeout. Reproducing an ENOENT startup failure returned in 2 ms while the old
formatter would have claimed a 120-second timeout. The exact error code on the
user's own Windows machine was not observed here.

The revised launcher runs `process.execPath` with the `npm_execpath` JS entrypoint,
followed by the original `run agent --` argument list. No shell is used. Four
regressions cover Windows-style paths containing spaces, a real npm launch from
a directory with spaces, exact goal-argument preservation, and distinct startup,
timeout and exit-error diagnostics. Existing public scenario assertions, server
booking verification, expected statuses and 120-second scenario timeout remain
unchanged.

The coding agent executed its local tests and live rerun in Linux. After the
launcher correction, the candidate supplied Windows PowerShell output showing
**6/6 public evaluations passed**, including server-verified idempotent replays
for both booking scenarios. The Windows result is candidate-reported evidence;
the coding agent did not operate that Windows environment.

The complete live suite was rerun through the corrected launcher: **6/6 passed**, runner exit code 0. The final local suite is **56/56 passed**, and TypeScript checking passed. The runner diff was mechanically checked to contain only launch, stale-result cleanup and diagnostic changes; scenario data and evaluation assertions were unchanged.
