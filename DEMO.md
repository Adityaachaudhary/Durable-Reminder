# Demo video script (about 6 to 7 minutes)

Record the terminal. Each section matches the demo checklist in the problem brief.
Run `npm install` beforehand and use a wide terminal.

## 0. Intro (20 s)
"This is Problem 3: reminders and scheduled follow-ups that stay correct across restarts and retries. The database is
the only source of truth, time is injected, and delivery is idempotent by a stable key. Everything you will see uses a
controlled clock and a fake local destination: no waiting, no network."

## 1. Create a scheduled item and advance controlled time to deliver it (75 s)
```bash
npm run demo
```
Pause on section 1. Point out: the user asked for 02:30 in New York on 8 March, a time that does not exist; the item
shows `requested 02:30`, `runs at 07:30Z = 03:30 local [gap_shifted_forward]`. One second early nothing happens; at the
instant it is delivered and the attempt history shows one `delivered` attempt.

Optional, to show the REST API:
```bash
npm run rest-demo
```
Point out `201`, the idempotent replay `200`, the `409` conflict, the admin clock moving time, and the delivered state.

## 2. Restart recovery for overdue work (60 s)
Section 2 of the demo: two reminders become due while the service is stopped; a brand new store and worker start;
both are delivered oldest first and the history shows how late (90 and 60 minutes).

## 3. A temporary-failure, edit or cancellation path (75 s)
Sections 3a, 3b, 3c: two temporary failures then success with 30 s and 2 min waits visible in the attempt history;
an edit whose original time never fires (`move-me:v2` only); a cancelled item with zero sends.

## 4. Duplicate execution without a duplicate notification (60 s)
Section 4: worker A is stuck mid-send, its lease expires, worker B delivers, A wakes up and sends the same key again.
The destination was asked twice, users saw one notification, and there is one delivery record.

## 5. Verification benchmark, architecture and one trade-off (90 s)
```bash
npm run verify
```
Show typecheck, the 86 passing tests and the benchmark table (`RESULT: PASS`): 23 items, four zones, restart,
duplicate execution, 16 delivered / 3 cancelled / 4 failed, 16 logical notifications for 16 delivered items.
Then open `src/worker.ts` (`execute`: claim, fence, send, guarded commit) and `src/store/sqliteStore.ts`
(`completeDelivered` and the schema triggers).

Trade-off to name: exactly-once is delivered as at-least-once sending plus an idempotent destination plus an atomic
commit. A cancel or edit that lands after the destination already accepted the message cannot recall it; that narrow
window is recorded honestly as `sent_but_cancelled` / `sent_but_superseded` rather than hidden.
