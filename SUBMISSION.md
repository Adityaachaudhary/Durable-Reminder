# SUBMISSION: Problem 3, Durable Reminders and Follow-Ups

> Items marked **TODO(Adii)** need your own input before you submit. They are things only you can truthfully
> write (your demo link, your fork, your real experience). Delete this note when done.

## 1. Selected problem

**Problem 3: Durable Reminders and Follow-Ups**: a service for reminders and scheduled conversational follow-ups that
stays correct across restarts, retries, edits and cancellations.

- Repository / fork: **TODO(Adii)**
- Demo video: **TODO(Adii)** (script in [`DEMO.md`](DEMO.md))

## 2. Setup and run

Requirements: Node.js 22.13+ (built-in `node:sqlite`, so no native module to compile). Developed and tested on
Node 22.22 / Linux; not yet run on Windows or macOS.

```bash
npm install
npm run verify        # typecheck + 86 tests + verification benchmark (about 6 s)
npm run demo          # scripted walkthrough with controlled time
npm run rest-demo     # the REST API driven end to end
npm run serve         # the REST API for real: real clock, background worker
```

The interface is a **REST API (Hono) plus a CLI** over the same service. Commands and PowerShell/curl examples are in
[`README.md`](README.md). No real notification provider, network access or paid service is used; nothing secret is committed.

## 3. Required behaviour, mapped to the code and tests

| # | Requirement | Where | Evidence |
| --- | --- | --- | --- |
| 1 | Create and inspect scheduled work | `ReminderService.create/get/list`; `POST/GET /reminders`; CLI `create/list/show` | `service.test.ts`, `api.test.ts` |
| 2 | Edit time or content before delivery | `ReminderService.edit` (needs `expectedVersion`); `PATCH /reminders/:id` | `service.test.ts` "editing", `worker.test.ts` AC5 |
| 3 | Cancel before delivery | `ReminderService.cancel` (idempotent); `POST /reminders/:id/cancel` | `service.test.ts`, `worker.test.ts` AC6 |
| 4 | IANA zone retained; policy for ambiguous / nonexistent local times | `time.ts`; zone and requested wall time stored on the item | `time.test.ts` (21 tests) |
| 5 | Discover and execute due work after a restart | `SchedulerStore.claimDue` (database is the only schedule); `Worker.tick` | `restart.test.ts` |
| 6 | Record every delivery attempt and outcome | `attempts` table, one row per claim, resolved with an explicit outcome | attempt assertions in `worker.test.ts`, benchmark |
| 7 | Retry temporary failures with a bounded policy | `retryPolicy.ts`, `Worker.handleFailure` | `worker.test.ts` AC3 |
| 8 | Visible terminal state when retries are exhausted | item becomes `failed` / `retries_exhausted` | `worker.test.ts` AC3 exhaustion, benchmark `x-1`, `x-2` |
| 9 | No duplicate logical delivery when an occurrence runs more than once | delivery key + `deliveries` primary key + schema triggers + idempotent destination | `worker.test.ts` AC4, benchmark `d-1`, `l-1` |
| 10 | Deterministic edit / cancel vs execution | section 5.7 below; all state changes are guarded transactions | `worker.test.ts` AC6 and "edit racing with execution" |

The minimum item contract is met: stable id, content, scheduled instant + IANA zone, state, `version`, ordered attempt
history, and a stable delivery key (`<id>:v<version>`).

## 4. Acceptance scenarios

| Scenario | Evidence |
| --- | --- |
| AC1 scheduled delivery | `worker.test.ts` "AC1" (NY 09:00, boundary at 13:59:59.999Z vs 14:00:00Z) |
| AC2 restart recovery | `restart.test.ts`: overdue work after restart, pending retry survives, dead worker's claim taken over after lease expiry, crash after destination accepted |
| AC3 temporary failure | `worker.test.ts` "AC3": recorded failures, 30 s then 2 min waits, eventual success; exhaustion after 4 attempts; permanent failure; lost acknowledgement |
| AC4 duplicate execution | two workers execute one occurrence (lease expired mid-send), same claim executed twice, store refuses a second delivery record; destination shows one notification |
| AC5 edit before execution | superseded schedule never fires; only the effective version is delivered; retry budget resets for a new version |
| AC6 cancellation | cancelled before due, during a retry wait, after claim but before send, and during the send |
| AC7 time-zone boundary | `time.test.ts`: Kolkata, New York, London; NY spring-forward gap, NY fall-back overlap, London gap, 23-hour day |

Required tests from the brief: due-work discovery with an injected clock; restart recovery; temporary failure then
retry; retry exhaustion; duplicate execution / acknowledgement; edit and cancel before execution; two IANA zones and
DST boundary cases. All present (86 tests; none sleeps, none touches a network).

## 5. Documented decisions

### 5.1 How local time and time zones become an execution instant
`at` is either a **local wall-clock time** with no offset (`2026-03-08T09:00`, read in the item's `timeZone`) or an
**absolute instant** with `Z` / an offset (no interpretation needed). Zones must be IANA identifiers (`Asia/Kolkata`);
fixed offsets like `+05:30` are rejected. Conversion uses Temporal (`@js-temporal/polyfill`), so the policy is explicit:

| Case | Example | Policy | Result |
| --- | --- | --- | --- |
| Normal | Kolkata 09:00 | as written | 03:30Z |
| Nonexistent (spring forward) | NY 02:30 on 2026-03-08 | move **forward** by the gap, like calendar apps | 03:30 EDT = 07:30Z (`gap_shifted_forward`) |
| Ambiguous (fall back) | NY 01:30 on 2026-11-01 | use the **first** occurrence, so the reminder is never later than expected | 01:30 EDT = 05:30Z (`ambiguous_first`) |

Invalid dates (`2026-02-30`) are rejected, not silently corrected. The zone, the wall time as requested and how it was
resolved are stored on the item and on every version, so the interpretation is explainable later. Changing only the
zone on an edit keeps the wall-clock time and re-reads it in the new zone. Times in the past are rejected on create
and edit.

### 5.2 How due work is discovered and claimed
There are no in-memory timers as a source of truth. The worker asks the database: items that are `scheduled` with
`COALESCE(next_attempt_at, scheduled_at) <= now`, plus items that are `running` whose lease expired, oldest first.
`claimDue` runs in one `BEGIN IMMEDIATE` transaction that, per item, sets `running`, stores a random claim token and a
lease expiry (default 30 s), and inserts an `in_flight` attempt row. Before sending, the worker runs a **fence**
check (is this claim still the current one?). The polling loop (`Worker.start`) only decides when to look; a fresh
worker after a restart finds exactly the same work.

**Overdue policy (AC2):** everything overdue is delivered after a restart, oldest first, and each attempt records how
late it was (`latenessMs`). Nothing is silently dropped.

### 5.3 Which failures are retryable and why
- **Temporary (retry):** timeouts, 5xx, rate limits, connection errors, and lost acknowledgements. Retrying is safe because the
  destination is idempotent on the delivery key and retries are bounded.
- **Permanent (no retry):** the destination rejects the request itself (bad recipient, content refused). Retrying cannot help.
- **Unknown errors** are treated as temporary (bounded), which is the safe default given idempotent delivery.

### 5.4 Retry limit and delay policy
4 attempts per occurrence (1 try + 3 retries), waits of **30 s, 2 min, 10 min** after the 1st, 2nd, 3rd failure, no jitter
(so runs are reproducible; production would add jitter). Attempts abandoned by a dead worker count toward the limit, so
a poison item cannot loop forever. After the last failure the item becomes `failed` with `retries_exhausted`.
Configurable through `RetryPolicy`.

### 5.5 What creates a unique scheduled occurrence
An occurrence is **(item id, version)**, its delivery key is `<id>:v<version>`. Retries and duplicate workers share the
key; an edit bumps the version and therefore creates a new occurrence with a fresh attempt budget. Creation itself is
idempotent by id (the same request replayed returns the same item; a different one is `409`).

### 5.4a State machine
`scheduled -> running -> delivered | scheduled (retry) | failed`, `scheduled | running -> cancelled`, and `running -> scheduled`
when an edit releases a claim. `delivered`, `cancelled`, `failed` are final. Attempt outcomes:
`delivered`, `duplicate_acknowledged`, `temporary_failure`, `permanent_failure`, `abandoned`, `aborted_cancelled`,
`aborted_superseded`, `sent_but_cancelled`, `sent_but_superseded`, `sent_lease_lost`.

### 5.6 How idempotency is enforced at the delivery boundary
Exactly-once *logical* delivery = at-least-once sending + an idempotent receiver + an atomic commit.
1. The notification carries the delivery key; the destination must treat a repeated key as `duplicate` (the fake does).
2. `completeDelivered` runs in one transaction: it re-checks that this claim is still valid, inserts the `deliveries` row
   (primary key = delivery key), moves the item to `delivered`, and resolves the attempt.
3. Schema triggers back this up: an item can only become `delivered` if a delivery row exists for its current version;
   a delivery row can only be created for an item that is `running` at that same version; terminal items are immutable.
So two workers, a retry after a lost acknowledgement, or a repeated call can never create two delivery records, and the
destination shows the notification once.

### 5.7 Edit and cancellation race policy (deterministic)
All mutations are guarded, transactional updates; the database serializes them and the loser is told why.
- **Cancel wins** over any delivery that has not committed. Once cancelled, the schema refuses a delivery row for the item.
- **Edit wins** over any in-flight claim. It bumps the version and returns the item to `scheduled` at the new time; the old
  occurrence can no longer commit.
- Order of events for an in-flight item:

| When the edit / cancel lands | Outcome |
| --- | --- |
| before the worker claims | the worker sees the new state; nothing old is sent |
| after the claim, before the send (fence) | nothing is sent; attempt `aborted_superseded` / `aborted_cancelled` |
| after the destination accepted, before the commit | the message already went out and cannot be recalled; the attempt is recorded as `sent_but_superseded` / `sent_but_cancelled`, **no delivery is recorded**, the item keeps its new state |
| after the commit | the item is already `delivered`; cancel/edit return `409 already_terminal` |

This narrow window (between the destination accepting and our commit) cannot be closed without a two-phase protocol
with the destination. It is kept visible in the history instead of hidden, and tested.

### 5.8 What guarantees change with multiple workers
Safe on one SQLite file with several workers or processes (tested with two connections and two workers): claims are
atomic, so an item is held by one worker at a time while its lease is valid; results are still exactly-once logical
because of the delivery key. What changes:
- If a send outlasts its lease (no heartbeat is implemented), a second worker may run the same occurrence. The destination
  dedupes; the store commits once; the slow worker's attempt is recorded as `duplicate_acknowledged`.
- No ordering guarantee across workers, only "oldest due first" per claim batch.
- Leases and due times use the caller's clock, so several hosts need synchronized clocks (or database time).
- SQLite has one writer; a production system would use Postgres with `SELECT ... FOR UPDATE SKIP LOCKED` and the same guarded updates.

### 5.9 What survives a restart
Everything: items, versions, retry schedules, claims and leases, attempt history, delivery records. The worker keeps no
state of its own. A claim held by a dead process is taken over after its lease expires and the earlier attempt is
marked `abandoned`.

## 6. Verification benchmark

```bash
npm run benchmark
```

Creates **23 items across 4 IANA zones** (Asia/Kolkata, America/New_York, Europe/London, UTC): 8 plain delivered (including a
DST gap), 3 edited (time, content, zone + content twice), 3 cancelled (before due, during a pending retry, while overdue
after restart), 3 temporarily failing then succeeding (the last on the final allowed attempt), 2 always temporarily
failing, 2 permanently failing, 1 lost acknowledgement and 1 duplicate execution. The service is **stopped and restarted**
on the same database file while work is overdue, a second worker forces a duplicate execution, and an injected clock is
advanced until everything settles. Checks read persisted state and what the destination received:

- final state, version and exact attempt-outcome sequence per item;
- exactly **1** logical notification for every delivered occurrence, **0** for cancelled and failed items and for superseded versions;
- no delivery before the scheduled instant; no unresolved attempts; destination count equals delivery records equals delivered items;
- the whole scenario runs twice with identical digests.

Observed output (Node 22.22, Linux):

```
Durable reminders: workflow-correctness benchmark
items: 23   zones: America/New_York, Asia/Kolkata, Europe/London, UTC   passes: 2
service stopped and restarted; 6 item(s) were already overdue at restart

group                    items  final state(s)   violations
delivered                8      delivered        0
edited                   3      delivered        0
cancelled                3      cancelled        0
temporary-then-success   3      delivered        0
retries-exhausted        2      failed           0
permanent-failure        2      failed           0
lost-ack                 1      delivered        0
duplicate-execution      1      delivered        0

terminal-state counts: delivered=16  cancelled=3  failed=4
delivered items: 16   logical notifications at the destination: 16   delivery records: 16
duplicate execution (d-1): destination asked 2 times -> 1 logical notification, 1 delivery record
repeatable (2 passes, digests aa4e6e0835032fe4 / aa4e6e0835032fe4): yes

RESULT: PASS
```

I also checked that the tests and benchmark can fail: I temporarily (1) removed the pre-send fence, (2) removed the claim
check on the delivery commit, and (3) removed the retry bound. Each was caught by specific tests (3, 6 and 6 failures,
including the benchmark) and I then reverted the changes.

## 7. Architecture

Storage, discovery and delivery are separate: `SchedulerStore` (state, guarded transitions), `Worker` (discovery, claiming,
retry decisions), `Notifier` (delivery boundary), with `ReminderService` (validation, time zones, versions) and thin REST/CLI
layers on top. Time is an injected `Clock`; tests use `ManualClock`. The store interface is synchronous by design.

## 8. Follow-up: reschedule at the moment a worker has claimed the previous version

**The edit wins.** The claim only entitles a worker to deliver the version it claimed; the edit bumps the version, so that
claim is void. Cases: (a) if the edit lands before the worker's fence check, the old version is never sent; (b) if it lands
after the destination accepted the old message but before the commit, that message was already out, so the attempt is recorded
as `sent_but_superseded`, no delivery record is created for the old version, and the new version is delivered once at its own
time under its own key; (c) if it lands after the commit, the item is already delivered and the edit gets `409`. Alternatives
considered: "claim wins" (would deliver stale content/time and delay the user's newest intent) and "reject edits while running"
(worse user experience and needs a retry protocol). Tests: `worker.test.ts`, "edit racing with execution".

## 9. Trade-offs and what I intentionally did not build

- **Synchronous store.** Makes claim-check-commit atomic and races easy to reason about; blocks the event loop on writes. An async store would keep the same guarded-update logic.
- **Built-in `node:sqlite`** instead of an npm SQLite package: zero install risk, requires Node 22.13+.
- **Polling, not timers.** A poll loop plus `nextWakeTime()`; simple and durable, with latency up to the poll interval (500 ms in `serve`).
- **No lease heartbeat, no jitter, no dead-letter queue** (the `failed` state is the visible end). No `maxLateness` (very late reminders are still delivered); a product could expire them.
- **Fake destination only.** `Notifier` is the extension point for a real one; idempotency by delivery key is its contract.
- Out of scope per the brief: natural-language dates, recurring schedules, real providers, auth, distributed queues, multi-region scheduling, a dashboard, secret management.

## 10. AI usage disclosure

This submission was produced with **Claude (Anthropic)** in a chat session: the architecture, source code, tests, benchmark
and documentation were generated by the assistant from the problem brief, the review scorecard and a plan I agreed to
(TypeScript, SQLite, Vitest, a REST API plus CLI). The assistant ran the typecheck, tests, benchmark, demos and a live server
in a sandbox; the outputs quoted above come from those runs. No real provider or API key is used.

**TODO(Adii): state truthfully what you personally did**: what you read and verified, what you changed, what you would
change, and that you can explain `Worker.execute`, `SqliteStore.claimDue` and `completeDelivered` unaided (the follow-up
discussion tests this).

## 11. Credibility note

**TODO(Adii): write this yourself; it cannot be generated.** Cover, in specifics rather than adjectives:

- a system you shipped (what it did, who used it) and your exact role and decisions;
- at least one concrete scale or operational constraint (users, jobs, latency budget, failure rate, team size);
- one difficult trade-off or incident and how you reasoned about it, ideally involving scheduling, retries,
  idempotency or partial failure.

Confidential details do not need exact metrics; coherent, specific reasoning is what is assessed.

## 12. Completeness self-check

| Item | Status |
| --- | --- |
| Fork accessible | TODO(Adii): push and check access |
| Problem clearly identified | yes |
| Setup and run instructions | yes (README, section 2) |
| `SUBMISSION.md` complete | after your TODOs |
| Demo video accessible and covers required scenarios | TODO(Adii): record with `DEMO.md`, check link permissions |
| Source code included | yes |
| Focused automated tests runnable | yes: `npm test` (86 tests) |
| Core acceptance scenario demonstrable | yes: `npm run demo`, `npm run rest-demo` |
| Failure/recovery scenario demonstrable | yes: restart, retry, edit, cancel, duplicate execution in `npm run demo` |
| Benchmark with command and results | yes: `npm run benchmark` |
| AI usage disclosed | yes, plus your TODO |
| Credibility note | TODO(Adii) |
| No secrets committed | yes |
