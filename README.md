# indianpets-mods

A moderator tool for r/IndianPets that turns fundraiser verification into a single action, then
keeps an eye on the fundraisers afterwards.

Fundraiser posts (vet bills, rescue treatment) are held by AutoModerator while the mod team checks
the documents the poster sends privately. Before this app, releasing a verified post meant removing
it, editing the removal reason, and approving it again — and a moderator had to comment "verified"
from their personal account, which earned them unsolicited DMs.

With this app a moderator picks **Verify fundraiser** from the post's menu, optionally adds a note
or fills in a checklist, and the app does the rest: it approves the post, posts a verification
notice **as the app account** (`u/indianpets-mods`), pins and distinguishes that notice so it
carries the green MOD tag, records what happened, and optionally leaves a mod note on the poster.

No moderator's personal account ever appears on the post.

---

## What it does

**Verification (v1)**
- One menu action approves the post, posts the stickied mod-team notice, and records the result.
- An optional, subreddit-editable checklist. Nothing in it blocks submission.
- Running it twice never produces a second comment.

**Duplicate fundraiser links (v2)**
- Every new post is scanned for links. Ketto, Milaap, GoFundMe, ImpactGuru, Donatekart, Give and
  FuelADream URLs are reduced to a `platform:campaign` identity, so the same campaign matches even
  when it is shared with tracking parameters, a different path shape or a different case.
- If a link has been seen on an earlier post, the new post is **reported to the modqueue** with the
  earlier post's id and author. It is never removed.
- A repost by the same author is reported with quieter wording, and can be switched off.
- Short links (bit.ly and friends) are indexed and flagged as unexpanded — see *Short links* below.

**Stale fundraisers (v2)**
- A nightly job finds verified fundraisers older than *N* days (default 30) and asks the OP for an
  update or a "completed" confirmation.
- If the OP replies, the chase stops immediately — the app watches for their comment rather than
  polling.
- If nobody replies within the grace period (default 7 days), the post is reported to the modqueue.
  Locking is available and **off by default**.

## What the app does and does not claim

The public comment states that the mod team reviewed the documents and **explicitly disclaims any
guarantee**, telling readers to donate at their own discretion. That wording is deliberate and is
covered by a unit test. If you edit it, keep the disclaimer.

The app **never** stores the verification documents. It stores only: the post ID, the poster's
username, the verifying moderator's username, a timestamp, the moderator's internal note, and the
checklist tick-boxes.

The app **never** removes anything, ever. The strongest automated action it can take is a modqueue
report. The only approve call in the codebase happens inside the moderator-initiated verify action.

---

## Requirements

- **Node.js 24 or newer** (`node --version`). The Devvit CLI requires it.
- A Reddit account connected at <https://developers.reddit.com>.
- A test subreddit you moderate.

## Setup

```
npm install
npx devvit login
npx devvit init
```

`devvit init` registers the app name with Reddit. **Playtest will not work until you have run it
once** — it fails with "Your app doesn't exist yet".

The app name is set in `devvit.json` (`"name": "indianpets-mods"`). That name is **global** across
Devvit and also becomes the app account's username and the app's URL slug. It must be 3–20
characters, lowercase letters/numbers/hyphens, starting with a letter. If the name is taken, change
it in `devvit.json` before the first upload.

> **Windows note:** if you are using a portable Node install, put it on `PATH` first.
> In **cmd.exe**: `set "PATH=C:\path\to\node;%PATH%"`
> In **PowerShell**: `$env:Path = 'C:\path\to\node;' + $env:Path`
> The two are not interchangeable, and `cmd` does not accept `;` to chain commands.

## Playtest on a test subreddit

```
npm run dev
```

`devvit playtest` builds the server bundle, installs the current code on your test subreddit and
streams logs. You can pin a default subreddit by adding this to `devvit.json`:

```json
"dev": { "subreddit": "your_test_sub" }
```

### What to check during playtest

1. Make a text post on the test sub, then remove it (to imitate the AutoModerator hold).
2. Open the post's `...` menu → **Verify fundraiser**. The form should appear.
3. Submit with the checklist toggle **off**. Expect: post approved, a stickied comment from the app
   account with the green MOD tag, and a success toast.
4. Run **Verify fundraiser** again on the same post. Expect: "Already verified by u/…" and **no
   second comment**. This is the idempotency guarantee.
5. Run **Fundraiser verification status**. Expect the same details echoed back.
6. Repeat on a fresh post with the checklist toggle **on** — you should get a second form, and the
   note you typed on step one should be pre-filled.
7. From the subreddit's `...` menu, open **Fundraiser tools settings**, change something, save, and
   confirm the change took effect on the next action.
8. Post two different posts containing the same Ketto/Milaap URL. The second should land in the
   modqueue within about ten seconds, reported, *not* removed.
9. Check `devvit logs` for the structured JSON lines.

Testing the reminder flow without waiting 30 days: set **Days after verification** to `1` in the
settings form, verify a post, and either wait for the nightly job or trigger it from the Devvit
scheduler. Set it back afterwards.

**One behaviour to confirm on real infrastructure:** the app issues `approve` and `submitComment`
concurrently, which assumes Reddit accepts a comment on a still-removed post from a moderator app
account. If playtest shows the comment failing on removed posts, change the two calls in
`src/server/services/verification.ts` from `Promise.allSettled([...])` to sequential `await`s. The
failure is handled safely either way — you would see a "the post was approved but the verification
comment failed" toast rather than a broken state.

## Deploying to r/IndianPets

```
npm run check
npx devvit publish
```

`devvit publish` submits the app for Reddit's app review. **Published apps are unlisted by
default**, which is what you want: reviewed and installable by you, but not listed in the public app
directory. Reddit aims to review within 1–2 business days; a brand new app can take longer.

Once approved:

```
npx devvit install r/IndianPets
```

Installing creates the app account and grants it moderator permissions on the subreddit
automatically — there is no moderator invite to accept.

To ship an update later, run `npm run check && npx devvit publish` again (every version is
re-reviewed, though updates get a streamlined review), then update the installed version from the
app's page under **Installed in communities**.

---

## Settings

Everything is switchable and editable from **two** places, and you rarely need the second:

1. **Inside Reddit** — the subreddit `...` menu → **Fundraiser tools settings**. This opens a form
   pre-filled with whatever the app is currently doing. Saving writes a runtime override stored in
   Redis that takes effect on the *very next action* — no redeploy, no trip to a settings page. Tick
   **Reset everything** to drop the overrides.
2. **The app's settings page** on developers.reddit.com, which holds the underlying defaults.

Layer 1 wins over layer 2, which wins over the built-in defaults.

| Setting | Default | Effect |
| --- | --- | --- |
| App enabled | on | Master switch. Off means the app takes no action at all. |
| Add a mod note on the OP | on | Records who verified and when. Skipped if the poster's account is deleted. |
| Name the verifying moderator in the public comment | **off** | Leave this off. Turning it on puts a moderator's username on the post, which is exactly what causes the unsolicited DMs this app exists to prevent. |
| Checklist items | built-in list | One item per line. Markdown bullets are tolerated. Max 20 items, 120 characters each. |
| Custom verification notice | blank | Replaces the built-in comment. Supports `{subreddit}`, `{date}`, `{mod}`. Keep the "not a guarantee" and "donate at your own discretion" language. |
| Detect repeated fundraiser links | on | Reports repeats to the modqueue. |
| Report same-author reposts | on | Off means they are logged only. |
| Scan comments for links | **off** | Much more traffic for a comparatively rare signal. |
| Ask the OP for an update | on | The nightly staleness sweep. |
| Days before asking for an update | 30 | Clamped to 1–365. |
| Grace days before reporting | 7 | Clamped to 1–90. |
| Lock a stale fundraiser when reporting | **off** | Opt-in; locking is destructive. |
| Custom reminder wording | blank | Supports `{subreddit}`, `{op}`, `{days}`, `{grace}`. |
| Minimum account age / karma | 0 (disabled) | Only ever *annotates* a modqueue report that was going to happen anyway. Never causes one. |

Changing the checklist later is safe: each verification record stores the **labels** that were
shown at the time, not just the answers.

---

## Redis key schema

Devvit's Redis is siloed per subreddit installation and **cannot list or scan keys**, so anything
that must be found again is reachable from a sorted-set index we maintain. There is no `hmGet` and
no pipelining, so records are plain string keys — readable in one batched `mGet` — rather than
fields of a hash, which would force one call per record.

| Key | Type | TTL | Contents |
| --- | --- | --- | --- |
| `fv:v:{postId}` | string | none | JSON verification record. Written `pending` before any Reddit call, promoted to `complete` after. |
| `fv:idx:verified` | zset | none | `member = postId`, `score = verifiedAtMs`. Full history. |
| `fv:idx:open` | zset | none | Only posts still awaiting a reminder or escalation. Entries are removed once resolved, so the nightly sweep reads a small bounded set. |
| `fv:lock:{postId}` | string | 120s | Unique owner token. Stops a double-click verifying twice. |
| `fv:tok:{token}` | string | 15 min | Server-minted proof that a given moderator opened the form for a given post, plus the checklist they were shown. |
| `fv:mod:{username}` | string | 300s / 60s | Cached moderator check. Positives cached longer than negatives. |
| `fv:held:{postId}` | string | 30d | When AutoModerator filtered the post. |
| `fv:cfg` | string | none | Runtime settings overrides written by the in-Reddit settings form. |
| `fv:link:{linkKey}` | string | ~1y | The first post seen carrying a normalised link. Claimed with `nx`, so the first writer wins a race. |
| `fv:plinks:{postId}` | string | ~1y | The link keys a post owns, so deleting it releases them. |
| `fv:dup:{postId}` | string | 30d | Stops a redelivered trigger reporting the same post twice. |

## Architecture

```
src/server/
  index.ts            route wiring only
  container.ts        composition root - the only module touching Devvit clients directly
  config.ts           every tunable, annotated with the platform limit it respects
  text.ts             every user-facing string
  formDefinitions.ts  the three forms (verify, checklist, settings)
  settings.ts         three-layer settings resolution, coercion and clamping
  types.ts            domain types
  handlers/           menu, forms, triggers, scheduler - thin adapters, no business logic
  services/           verification, duplicates, reminders, moderator gate, Reddit port + adapter
  data/               all Redis access: keys, records, links, tokens, config overrides
  lib/                logger, retry, sanitisation, URL normalisation, hashing, dates
  __tests__/          unit tests with in-memory fakes
```

Handlers and services depend on **ports** (`RedisPort`, `RedditPort`, `SchedulerPort`,
`SettingsPort`, `ConfigRepo`), never on `@devvit/web/server` directly. That is what lets the tests
run outside the Devvit runtime.

### Why the checklist is a second form

Devvit forms cannot show or hide fields conditionally — progressive disclosure only happens between
submissions. Ticking "Fill in the verification checklist" on form one opens form two. The
alternative, a second menu item, was rejected because it clutters every post's menu for a path used
less often.

### Ordering inside the verify action

1. Read the post (needed for the author and the current approval state).
2. Write a `pending` record **before** touching Reddit, so a crash after the comment is posted still
   leaves evidence and a retry cannot double-post.
3. Approve and comment **concurrently** — they are independent.
4. Distinguish + sticky only once the comment exists (`distinguish(true)` does both in one call).
5. Promote the record to `complete`.
6. Mod note last, as the only genuinely optional step.

Anything that fails after the comment exists produces a **partial** result and a toast naming
exactly what needs doing by hand. A failed comment rolls the record back so the action can be re-run.

### Keeping triggers fast

Trigger handlers do Redis work only. Anything needing Reddit round trips — filing a duplicate
report, sending reminders — is handed to the scheduler. The comment trigger's first act is a single
Redis `GET`, and almost every comment in the subreddit stops there.

The nightly sweep processes a bounded page (10 posts) and, if more remain, queues its own
continuation a minute later, up to 20 pages a day. That keeps every run far inside the 30-second
request limit and far below the 60-`runJob`-per-minute cap.

### Short links

Expanding a bit.ly link means following a redirect, and `fetch` on Devvit requires **each hostname
to be allow-listed and reviewed by Reddit**, plus a published Terms & Conditions and Privacy Policy
for the app. This app makes no external requests at all. Short links are still indexed (each one is
unique, so an exact repost is caught) and the modqueue report says
`[short link, destination unchecked]` so a moderator knows to look.

## Platform limits this design respects

| Limit | Value |
| --- | --- |
| Server request | 30s max, 4 MB payload, 10 MB response |
| Redis | 5 GB per installation, 5 MB per request, 40,000 commands/sec, no pipelining, no key scan |
| Redis transactions | 5s execution timeout (concurrency is documented inconsistently as 20 and 30) |
| Scheduler | 10 live recurring actions per installation; `runJob()` 60 creates/min, 60 deliveries/min |
| Moderator menu → form | must be completed within 10 minutes |
| Mod note | 250 characters |
| Report reason | kept under 100 characters |
| Setting value | 2 KB |
| Triggers | asynchronous, **at-least-once**; payload fields are optional snapshots |

## Tests

```
npm test
npm run test:types
npm run check
```

127 tests across pure logic (sanitisation, dates, retry classification, settings resolution and
clamping, checklist parsing, comment wording, URL normalisation, hashing) and the three services
against in-memory fakes: idempotency, concurrent runs, expired and mismatched tokens, missing posts,
deleted authors, v1→v2 record migration, every partial-failure path, duplicate races, link release
on deletion, batching and chain limits, and the OP-reply shortcut.

The thin HTTP handlers in `handlers/` are not unit tested, because they import `context` from
`@devvit/web/server`, which only exists inside the Devvit runtime. All of their logic lives in the
service layer, which is tested; the handlers are exercised during playtest.

## Not built

- Auto-replying to the OP when AutoModerator holds a fundraiser, listing the documents needed.
- An account age/karma summary shown on held fundraisers. (The thresholds exist as settings and
  currently only annotate modqueue reports.)
