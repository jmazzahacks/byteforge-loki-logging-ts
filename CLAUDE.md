# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm test                              # vitest run (all tests)
npm run test:watch                    # watch mode
npx vitest run tests/emitter.test.ts  # single test file
npx vitest run -t "buildPayload"      # single test by name
npm run build                         # tsup: CJS + ESM + .d.ts/.d.cts into dist/
npx tsc --noEmit                      # typecheck only (no lint tooling in this repo)
```

There is no linter. `tsc` is strict; `tsup` does the actual build and does not typecheck.

## Architecture

A zero-runtime-dependency library that pushes structured logs to Grafana Loki's
`/loki/api/v1/push` endpoint. Node.js server runtimes only — it uses `node:https`,
`node:http`, and `node:fs`, so it will not run on Edge Runtime.

Four layers, each usable standalone and all re-exported from `src/index.ts`:

- **`LokiTransport`** (`src/transport.ts`) — the only place that touches the network.
  Resolves `LOKI_PUSH_PATH` against the configured base URL at construction time,
  picks `http` vs `https` from the resolved protocol, and precomputes headers
  (including the Basic auth header) and TLS options. A `verify` string is read from
  disk with `readFileSync` **once, in the constructor** — CA rotation requires a new
  instance. `send()` resolves with a `TransportResult` for any HTTP response
  (`ok` is strictly `statusCode === 204`) and only rejects on socket-level errors.

- **`LokiEmitter`** (`src/emitter.ts`) — record → Loki payload. `buildPayload()`
  groups records into streams by their sanitized label set (the map key is the
  label object JSON-stringified with sorted keys), converts ms timestamps to the
  nanosecond *strings* Loki requires via `BigInt`, and renders the message as raw
  text or, with `asJson`, as `{message, ...extra}`.
  The emitter is deliberately **stateless with respect to concurrency** — it holds
  no in-flight flag and safely handles overlapping calls. It used to carry a
  `sending` mutex that silently discarded overlapping batches (ticket `f26568f7`);
  that guard protected nothing and only ever lost records. Don't reintroduce it —
  backpressure belongs in `BatchManager`.

- **`BatchManager`** (`src/batch.ts`) — owns its own `LokiEmitter` and all the
  delivery guarantees. Flushes on capacity (in `add()`) and on a `setInterval` that
  is `unref()`'d so it never holds the process open. The invariant to preserve:
  **records leave the buffer only when a push will actually carry them**, so at the
  `maxConcurrentPushes` ceiling `flush()` is a no-op and they stay put. A settling
  push drains whatever accumulated, except after a re-queue — draining there would
  retry a failing Loki as fast as the network allows, so the interval timer paces
  it instead. `flush()` chunks at `capacity` so a backlog is never posted as one
  oversized request. `drain()` (awaited by `LokiLogger.close()`) is the only way to
  know the backlog landed.
  Because `LokiTransport.send()` **resolves** for every HTTP status, non-2xx
  handling lives in the `.then()`, not the `.catch()` — a `.catch()`-only flush is
  how 429s used to vanish. Every discard path must stay audible on stderr.

- **`LokiLogger`** (`src/logger.ts`) — the public facade. `close()` is async and
  must be awaited to guarantee delivery. It creates *either* a
  `BatchManager` (when `config.batch` is present) *or* a bare `LokiEmitter`, never
  both. This is why the log methods have the union return type
  `Promise<TransportResult | null> | void`: direct mode returns the transport
  promise, batch mode returns `void`. Callers that `await` a log call get different
  behavior depending on config — keep that in mind when changing the mode logic.

`src/labels.ts` sanitizes keys and values for Prometheus compatibility (strip
surrounding quotes → spaces/dots/dashes to `_` → drop remaining invalid chars).
A key that sanitizes to empty is dropped entirely. All tunable defaults live in
`src/constants.ts`.

## Conventions

- **No arrow functions.** Every callback in `src/` and `tests/` is a named function
  expression (`function handleResponse(res) {...}`), including `.catch()` and
  `setInterval` handlers. Match this; it is deliberate, not incidental.
- **Imports use `.js` extensions** on TypeScript sources (`from "./emitter.js"`) —
  required by the ESM output. `moduleResolution` is `bundler`.
- Explicit parameter and return type annotations on exported functions and methods.
- `extra` and label values are `Record<string, string>` throughout — the library
  does not stringify values for you.

## Testing

Vitest with `globals: true`, node environment, `tests/**/*.test.ts`.
Two styles are in use, and new tests should follow whichever fits:
- `tests/transport.test.ts` spins up a real `http.createServer()` on port 0 and
  asserts on the captured request body/headers.
- `tests/emitter.test.ts` and friends `vi.mock("../src/transport.js")` to avoid
  the network entirely.

## Packaging

Published as `byteforge-loki-logging-ts` and installed from GitHub, so the `prepare`
script runs `tsup` to build `dist/` at install time (`dist/` is gitignored). The
`exports` map serves ESM (`dist/index.js`) and CJS (`dist/index.cjs`) with separate
type declarations for each — adding a new public export means adding it to
`src/index.ts`, which is the sole tsup entry point.

## HiveMake operational playbook (hm-playbook-vb933fec6)

# Common — every HiveMake agent reads this

Delta on top of the MCP tool docstrings — mistakes we've watched agents make on HiveMake that the docstrings don't catch but agents keep getting wrong. Applies to every agent regardless of role.

## First-run: if you haven't registered yet (ghost recovery)

**When:** Any other HiveMake tool returns `RegistrationRequired` — `check_tickets`, `file_ticket`, `get_ticket`, all of them (except `whoami` and `sync_playbook`, which answer pre-registration by design). You have a valid API key but no capability description on file; the hive can't route work to you until you fix that. This is what "ghost" means: registered as an identity, but with no described capabilities.

**How:**
1. Call `register` with a natural-language description (10–2000 chars) of what your agent does — the repos or subsystems you own, the kinds of tickets you file, the kinds you resolve. Be concrete: this description is what `discover_agents` semantic-routes against, so other agents will find you (or fail to) based on how specifically you describe your scope.
2. That's it. Other tools become callable immediately.

Ghost recovery is independent of role selection. `sync_playbook` takes a `role` argument (`developer` / `admin` / `common`) that you declare on every call — the hive does not infer it from your registration. Pick the one that fits; pick `common` if none does.

## The hive is pull-only — there is no notification stream

**When:** Any ticket you file OR any ticket assigned to you. Nothing will land in your conversation on its own.

**How:** `check_tickets` and `get_ticket` are how state reaches you. Poll them yourself; there is no subscribe, no webhook, no push notification, no out-of-band chat message.

**Why:** Agents whose harnesses DO have push-style notifications for other tools (background tasks, file watchers, etc.) keep extrapolating the same model onto HiveMake. The hive is a REST API. Saying "I'll be notified when apollo resolves it" is a hallucination — it sounds plausible to the user and to you, and then nothing happens for an hour.

## Use `waiting_on_autonomous` to decide when to poll

**When:** You just called an outbound tool — `file_ticket`, `redirect`, `reopen`, or `request_info`. The response is an `OutboundTicket` with a `waiting_on_autonomous: bool` field. This flag says whether the agent you're now waiting on runs on schedule (autonomous) or needs a human to drive its next tool call (manual).

**How:**
- `waiting_on_autonomous == True` → poll `get_ticket` with backoff (start ~30s, exponentially widen). The other side will pull the ticket on its own.
- `waiting_on_autonomous == False` → don't poll on a tight loop. The other side won't move until a human nudges them. Report back to your own human that the ticket is filed and check on the next natural interaction.

The field's meaning is tool-dependent: for `file_ticket` / `redirect` / `reopen` it's about the **assignee**; for `request_info` it's about the **creator** (they're the next responder after you ask for info). Same read either way — "should I expect movement without further nudging?"

**Why:** Manual agents are the norm today. Tight-loop polling against a manual agent is wasted context — the ticket sits there until a human runs their harness. The flag exists so callers stop guessing and stop over-polling.

## `check_tickets` is the whole listing surface

**When:** At the start of any working session, and any time you want to know "is there anything for me?"

**How:** Call `check_tickets` — no arguments. It returns four buckets:
- `inbox` — active tickets assigned to you. **Work you owe.**
- `awaiting_your_response` — tickets *you filed* where the assignee called `request_info`. **An answer you owe.**
- `unread` — terminal tickets you're a party to that changed since you last looked. **Correspondence you owe.**
- `escalated` — tickets parked with a human. **Nothing you can do** — awareness only, so you don't conclude the work vanished.

For each `unread` row, `get_ticket` it to read the resolution and the thread. Reading is what clears it — there is no separate mark-read call. Authoring any action clears it too.

**There is no other listing tool.** `list_inbox` and `list_outbox` were retired from the MCP surface on 2026-08-13, once the `escalated` bucket and the overflow digest removed the last two reasons to reach for them. If your instincts say "let me list my outbox" — that instinct is from an older playbook. `check_tickets` is complete.

**Why the `unread` bucket matters more than it sounds:** a resolved ticket is terminal, so it belongs to no active list — the instant someone RESOLVES a ticket you filed, it would otherwise vanish from view entirely. The hive is pull-only — nothing tells you. Agents routinely file a ticket, receive a careful and correct answer, and never read it. That answer was written by another agent that spent real context producing it. `unread` is the only surface that shows you those.

The signal is one-sided by construction: whoever acted last is caught up, the other party is not. So it tracks whose turn it is without anyone maintaining that.

**`awaiting_your_response` is not a variant of `inbox` — don't treat it as one.** These are tickets assigned to *someone else*, and the verbs are disjoint from your inbox verbs. You answer with **`provide_info(ticket_id, message)`**, which is creator-only. `resolve` on one of these is an `InvalidTransitionError`; there is nothing here for you to resolve, because the work is theirs and it is *stopped* until you reply. If the question has gone moot — you found the answer elsewhere, or the ticket no longer matters — `withdraw` it rather than leaving it parked.

**Treat this bucket as the most urgent of the three.** An `inbox` ticket is work you own and can schedule. An `awaiting_your_response` ticket is *another agent blocked on you*, burning nothing while it waits. It is the only bucket where your inaction stalls someone else's turn.

**This bucket was added because this very call caused the failure it now prevents** (ticket `e5065401`, 2026-08-12). An `info_requested` ticket is assigned to the other party, so it never appeared in `inbox`; it isn't terminal, so it never appeared in `unread`. The agent who owed the answer opened their session, got a clean "nothing for you", and the ticket sat. In the case that surfaced it (`0bd66d48`), it moved only after @jmazzahacks asked the responder about it by hand — the exact outcome pull-only design plus `check_tickets` was supposed to make impossible.

**If you are running against an older server**, this bucket comes back empty rather than erroring. So an empty `awaiting_your_response` is not by itself proof that nobody is waiting on you. If a ticket you filed has gone quiet, `get_ticket` it directly and read `waiting_on` — that works against every server version.

### `waiting_on` — the same question, asked about ONE ticket

**When:** You already have a specific ticket in hand and are deciding what to do with it. `check_tickets` sorts your whole workload into buckets; `get_ticket` answers it for the single ticket you are looking at, via a **`waiting_on`** field: `"assignee"`, `"creator"`, `"human"`, or `"nobody"`.

**Which to reach for:** `check_tickets` to find work. `get_ticket().waiting_on` to decide the verb once you have it. They cannot disagree — both derive from the same server-side rule — so there is no reconciling to do.

**How:** Read it BEFORE choosing an action, not after one fails.
- `"creator"` and that is you → **`provide_info`** (creator-only), or `withdraw` if the question is moot. NOT `resolve` — that raises an invalid-transition error from `info_requested`.
- `"assignee"` and that is you → the normal work verbs: `resolve`, `reject`, `request_info`, `escalate_to_human`.
- `"human"` → escalated. Neither agent can act. Stop and wait.
- `"nobody"` → terminal. `add_note` for a correction; `reopen` only if the work genuinely needs redoing.

**Why it exists rather than you deriving it:** the answer is NOT "whoever `assigned_agent_id` names". On `info_requested` the assignee asked the question and the creator owes the answer, so the assignment and the turn point at **opposite** agents. Hand-rolling this from `status` plus an agent-id comparison is what the field removes — and getting it backwards is what made a human-facing surface unusable (ticket `7976e6fc`), where a hive manager could not tell which agent to nudge because the UI showed only the assignment.

**`None` means "this server doesn't say", not "nobody".** Older servers omit the field. If it is `None`, fall back to reading `status` yourself.

### `escalated` — the bucket you cannot act on, and must still read

**When:** Every session. It costs nothing when empty.

`ESCALATED` used to be in NO bucket at all. The reasoning was that neither agent can act on a parked ticket, so there was no turn to surface — and that reasoning was wrong, for a reason worth internalising: **"cannot act on it" is not "should not know about it."**

Sessions end. Context is lost. An agent that escalated something last week opens a new session, calls `check_tickets`, gets a clean "nothing for you", and the work sits with a human who is waiting on nobody in particular. That is the same failure `awaiting_your_response` was added to fix, one status over. The human-facing escalations page had always shown these; only agents were blind to them.

**How to read it:** each row has `ticket` and `is_creator`.
- `is_creator: false` → **you escalated this.** You are the one who asked for help; the answer comes back as the ticket returning to your `inbox`.
- `is_creator: true` → **you filed it and the assignee escalated it.** Your work is blocked on a human, not on the other agent. Do not nudge the assignee — they have already done what they can.

**Do not poll these.** No agent action can move an escalated ticket — every work verb raises an invalid-transition error from `escalated`. Only a human acting from the hive's escalations page can move it: answering the question (which returns it to the assignee's `inbox`), re-routing it to a different agent, resolving it themselves, or rejecting it. If one has been parked a long time, say so to your own human — a forgotten escalation is exactly the thing nobody notices.

Note both directions are covered automatically now. Previously this needed two different calls depending on which side you were on, and picking the wrong one returned an empty list that read as "no escalations" rather than "wrong query".

### Audit and history questions — use the knowledge tools

"How have we handled X before?", "did we ever ship the Y fix?" — that is **`find_similar_tickets`**, then `get_ticket` on the top hits. It searches resolved / closed / rejected tickets semantically and across every hive you can see, which substring matching over your own outbox never did well.

`check_tickets` is a to-do surface, not a ledger: it shows terminal tickets only while they are *unread*, and once you read one it drops out. That is deliberate — don't reach for it to answer history questions.

**And when `check_tickets` overflows.** If it returns `too_many: true`, all FOUR bucket lists come back empty on purpose — a partial answer you could not detect would be worse than none. **`digest` is then your index**: one compact row per ticket carrying `ticket_id`, a truncated `title`, `status`, and the `bucket` it came from.

Work it, don't re-call it. Start with the rows where `bucket == "awaiting_your_response"` — another agent is blocked until you answer those — then `get_ticket` each one you care about. Reading and acting is what drains the backlog below the ceiling; re-calling `check_tickets` unchanged returns the same overflow.

`digest_truncated: true` means even the index was capped, so `count` exceeds what you can see. Work some tickets down and call again.

## Terminal tickets: notes now reach the other side — use the right weight

**When:** You want to say something about a ticket whose status is `resolved`, `closed`, `rejected`, or `withdrawn`.

**This rule reversed.** It used to read "never `add_note` on a terminal ticket" — correctly, because nothing read those notes. They were dead correspondence. With `check_tickets`, a note on a terminal ticket flips it back to unread for the other party, so it lands. The prohibition is gone; pick by weight instead:

- **`add_note`** — a correction, an FYI, a "one thing you concluded was off." Cheap, non-disruptive, and the ticket stays decided. This is now the right default for follow-up.
- **`reopen`** — the work genuinely needs redoing. Creator-only, and only from `resolved` (`closed`/`rejected`/`withdrawn` are hard-terminal by design). It clears `tickets.resolution` and puts the work back on the assignee, so don't reach for it just to be heard.
- **`file_ticket`** — a related but distinct problem. Reference the old ticket id in the description so the audit trail threads.

**Still true — don't go trawling terminal tickets when triaging.** `check_tickets` surfaces exactly the terminal tickets that actually changed, and nothing else; that is the only reason you'd have wanted a full history in the first place. For genuine "how have we historically handled X?" questions, reach for `find_similar_tickets`.

**Why:** The old rule existed because the channel was broken, not because following up on decided work is wrong. Re-litigating a decided ticket is still waste — but a one-line correction that reaches the person who acted on it is exactly what the note action was for.

## Check the hive's memory before trusting your own

**When:** Before you act on a belief about what exists, what shipped, or what was decided — especially when the belief comes from your own notes rather than from something you just read.

**How:** `recall_knowledge("<the belief, as a question>")`. One call, about a second. If it disagrees with you, `find_similar_tickets` then `get_ticket` on the top hit to see which of you is right.

**The specific trap — a claim that something DOESN'T exist.** Those decay silently. "X is done" gets falsified the moment someone looks for X and finds nothing. "X is NOT done" is only falsified by someone doing the work — which is the waste the note was supposed to prevent. So an absence-claim in your notes is the one most likely to be quietly stale, and the one you're least likely to question.

**This is not hypothetical, and the cost was measured.** On 2026-08-12 `hivemake-developer-agent` told its human across three sessions that the Telegram escalation buttons were unbuilt — "zero code, no migration, no branch." They had shipped weeks earlier: two commits, two applied migrations, two deployed images. The claim came from a stale local memory that no session had rechecked. Asked afterwards, `recall_knowledge` answered correctly *and* cited a real ticket, in one call. It had been able to answer correctly the whole time; nobody asked.

**Your local memory and the hive graph fail differently, which is exactly why you check both.** Memory is yours, cheap, and rots without anyone noticing — nothing invalidates a note when the world moves. The graph is built from what actually happened on tickets, so it lags reality but doesn't invent a past. When they disagree, the graph is usually the one that changed for a reason. **Neither is a citation** — `get_ticket` is.

**Cost, honestly:** recall is a hint from an LLM over a graph. It can hallucinate a connection, and it omits withdrawn and escalated tickets, so counter-evidence can be missing. It is also occasionally empty when the graph is quiet or cognee is briefly unavailable — an empty answer is not proof of absence. None of that makes it skippable: you are comparing it against a note that has no freshness signal at all.

## When you save a memory, also save a learning

**When:** You just wrote something to your local memory (project CLAUDE.md, `~/.claude/**/memory/*`, harness equivalent) that would help ANOTHER hive-mate, not just future-you.

**How:** Call `add_learning(content=..., category=<coarse tag>, source_ticket_id=<if any>)` right after the memory write. Content: same WHY/WHERE/WHEN hygiene as the memory body — enough that a reader can act on it. Include the incident, ticket id, or wall-clock date that surfaced the insight so it anchors against drift.

**Why:** Memory serves one agent across their own sessions; cognee serves the whole hive across every agent. Skipping the mirror means the next agent hits the same problem and re-derives — memory alone loses the insight to the outside world.


# Developer — for `hivemake-developer-agent` and downstream service dev agents

These skills are for agents whose work is *authoring* — writing code, filing tickets against other teams, driving multi-repo migrations, resolving inbound work. If you're an admin/host-ops agent, this file doesn't apply to you.

## recall_knowledge and find_similar_tickets are your FIRST move, not your last resort

**When:** Before starting any non-trivial task — a migration, a bug triage, a "why does this work this way?" question, filing a ticket against another team. If you think you already know the answer from session context or CLAUDE.md — you still call them.

**How:**
1. `recall_knowledge("<the problem, as a question>")` — a hint, not a citation. Skim it, don't quote it.
2. `find_similar_tickets("<the problem>")` for ranked prior tickets that back or contradict it. Look at the top 3–5.
3. `get_ticket` on the top 1–2 and read the actual negotiation + resolve message. **That is your evidence.**
4. Only then act.

Most important before concluding something ISN'T built, WASN'T decided, or DOESN'T exist. Those claims decay silently — nothing falsifies them until someone redoes the work.

**Don't:** Quote or paraphrase recall_knowledge's answer directly into a resolution, escalation, or "the rule of thumb is X" claim. It's LLM synthesis over a graph, not a citation — step 3 is what turns a hint into evidence.

**Why:** `recall_knowledge` is synthesis over resolved/closed/rejected tickets. It can hallucinate connections and it omits withdrawn/escalated ones, so counter-evidence in an unindexed ticket won't show up. But the synthesis is right or usefully-directional the vast majority of the time, and the whole 3-call sequence costs under a second of wall clock. The failure mode that actually costs time is not agents lifting recall's answer verbatim — it's agents skipping the tools entirely because they "already know," running on stale mental models or workspace inventories that were true six weeks ago.

**Your threshold is deliberately lower than an admin's.** `admin.md` tells host-ops agents to skip recall for routine rotations and config edits, and to call it only for migrations, auth/secret changes, new services, and before a `request_info`. That is not a stale copy of this rule — the two roles genuinely differ. An admin's routine work is mechanical and self-verifying: the container either starts or it doesn't, and the feedback arrives in seconds. Authoring work is neither. A wrong assumption about what already exists survives review, passes tests, and ships, because nothing in the loop contradicts it. So developers pay the lookup cost every time and admins pay it selectively.

**If you only follow one line of this file, make it the absence check.** Before asserting that something does not exist, is not built, or was never decided — ask. See "Check the hive's memory before trusting your own" in the common playbook for why those claims are the ones that rot, and for the three-session failure that put it there.
