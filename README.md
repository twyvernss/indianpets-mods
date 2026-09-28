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
- An optional, subreddit-editable checklist, shown **in the same form**. Nothing in it blocks
  submission, so a moderator can just press Verify.
- The form opens with the author's history: account age, karma, when AutoModerator held the post,
  and how many fundraisers this person has had verified here before.
- Running it twice never produces a second comment.

**Intake (v3)**
- When AutoModerator holds a fundraiser, the app can reply to the OP listing exactly what to send
  and telling them to send it by modmail, not publicly. **Off by default** — if AutoModerator
  already posts something similar, remove that first.
- The verify form shows the moderator a one-line context header: the author's account age, karma,
  and when the post was held.

**Duplicate fundraiser links (v2)**
- Every new post is scanned for links. Ketto, Milaap, GoFundMe, ImpactGuru, Donatekart, Give and
  FuelADream URLs are reduced to a `platform:campaign` identity, so the same campaign matches even
  when it is shared with tracking parameters, a different path shape or a different case.
- If a link has been seen on an earlier post, the new post is **reported to the modqueue** with the
  earlier post's id and author. It is never removed.
- **Reposts your rules allow are not flagged.** Set the waiting period to match your subreddit
  (default 24h). A same-author repost that waited that long is legitimate: it is silently allowed
  and takes over ownership of the link, so the clock restarts from it. Only a repost that arrives
  *sooner* than the rule allows is reported, and the report quotes both numbers.
- A repost from a **different account** is always reported, however long ago the first post was.
- If the earlier post was already verified, the report says so — usually that means the documents
  are already on file and the new post needs a glance, not a full re-check.
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

> **Windows note:** if Node is not already on your `PATH` (a portable install, for
> example), run the matching helper from the repo root first. It locates Node and adds
> it for the current shell only.
>
> PowerShell — the leading dot matters, it makes the script run *in* your shell:
>
> ```
> . .\tools\use-node.ps1
> ```
>
> cmd.exe — the `call` matters, for the same reason:
>
> ```
> call tools\use-node.cmd
> ```
>
> By hand instead: PowerShell is `$env:Path = 'C:\path\to\node;' + $env:Path`, cmd.exe
> is `set "PATH=C:\path\to\node;%PATH%"`. These are **not** interchangeable — in
> PowerShell, `set` is an alias for `Set-Variable`, so the cmd form silently creates a
> junk variable and leaves `PATH` untouched. Likewise `cd /d` is cmd-only, and `;`
> chains commands in PowerShell but not in cmd.

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
3. Tick whatever applies in the checklist (or nothing) and press Verify. Expect: post approved, a
   stickied comment from the app account with the green MOD tag, and a success toast.
4. Run **Verify fundraiser** again on the same post. Expect: "Already verified by u/…" and **no
   second comment**. This is the idempotency guarantee.
5. Run **Fundraiser verification status**. Expect the same details echoed back.
6. Check the form header shows the author's account age, karma and previous-fundraiser count.
7. From the subreddit's `...` menu, open **Fundraiser tools settings**, change something, save, and
   confirm the change took effect on the next action.
8. Post two different posts containing the same Ketto/Milaap URL **from two different accounts**.
   The second should land in the modqueue within about ten seconds, reported, *not* removed.
9. Post the same link twice from the **same** account. Within the waiting period it is reported
   with "Reposted after Nh, minimum is 24h"; set the waiting period to 0 in settings and it is not
   reported at all.
10. Check `devvit logs` for the structured JSON lines.

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
| Which flair marks a fundraiser | none (every post) | A dropdown of the subreddit's real post flairs. When set, the bot only replies to and reports posts with that flair. Falls back to a text box on a subreddit with no flairs. |
| Saved notices | two starter blocks | Two or three pre-written verification notices a moderator picks from at verify time. One per block, separated by a line containing only `---`; the first line of each block is its name. |
| Checklist items | built-in list | One item per line. Markdown bullets are tolerated. Max 20 items, 120 characters each. |
| Compact checklist | on | One multi-select tick-list instead of a row of toggles. Keeps the form short, which matters on mobile. |
| Custom verification notice | blank | Replaces the built-in comment. Supports `{subreddit}`, `{date}`, `{mod}`. Keep the "not a guarantee" and "donate at your own discretion" language. |
| Reply when AutoModerator holds a fundraiser | **off** | Posts the "here is what we need" comment to the OP. Turn on only after removing any equivalent AutoModerator comment. |
| Custom intake wording | blank | Supports `{subreddit}`, `{op}`. |
| Show author age/karma on the verify form | on | Moderator-only context line. Costs one extra lookup when opening the form. |
| Detect repeated fundraiser links | on | Reports repeats to the modqueue. |
| Report same-author reposts | on | Off means they are logged only, never reported. |
| Hours before the same person may repost | 24 | Match your subreddit rules. A repost that waits this long is never reported. `0` = no waiting period (never reported). Set very high (`8760`) if you do not allow reposts at all. |
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

## App icon

`assets/icon.png`, wired up via `marketingAssets.icon` in `devvit.json`.

Devvit requires it to be **1024x1024 and at most 500 KB**, which is a tighter pair of constraints
than it looks: a 32-bit PNG of a smoothly upscaled logo lands around 1 MB. The current icon is a 4x
nearest-neighbour scale of the 256x256 source, which keeps the exact colours and the partial
transparency on the antialiased edges and comes in at ~119 KB. Palette-reduced (8-bit) versions are
far smaller but cannot carry partial alpha, so they wreck the edges.

If you replace it, start from a native 1024x1024 export rather than upscaling, and check the file
size before uploading.

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
| `fv:areply:{postId}` | string | 30d | Marks that the intake reply has been claimed, so a redelivered trigger cannot post it twice. |
| `fv:auth:{username}` | zset | none | Every fundraiser verified for this person. **Survives post deletion** — see below. |
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
  services/           verification, duplicates, reminders, intake, moderator gate, Reddit port + adapter
  data/               all Redis access: keys, records, links, tokens, config overrides
  lib/                logger, retry, sanitisation, URL normalisation, hashing, dates
  __tests__/          unit tests with in-memory fakes
```

Handlers and services depend on **ports** (`RedisPort`, `RedditPort`, `SchedulerPort`,
`SettingsPort`, `ConfigRepo`), never on `@devvit/web/server` directly. That is what lets the tests
run outside the Devvit runtime.

### Why the verify flow is one form

Devvit forms cannot show or hide fields conditionally, so a "show checklist" toggle can only open a
*second* form. Every checklist item is optional anyway, so the checklist simply lives in the same
box: tick what applies, press Verify once.

Devvit has no true checkbox field. `boolean` renders as a toggle switch, so the default is a single
multi-select, which is the closest thing to a tick-list and keeps the form short. Set **Compact
checklist** off if you prefer a row of toggles.

**Button placement is not ours to control.** Reddit draws Verify/Cancel at the end of the form's own
scroll, and an app cannot pin them. The only lever is form length, which is exactly why the compact
checklist is the default.

### Editing what the bot posts

The built-in notice lives in `text.ts` as `DEFAULT_NOTICE_TEMPLATE`, written with `{subreddit}`
placeholders rather than interpolated values. The settings form **prefills the notice box with that
exact text**, so a moderator can see what is actually being posted and edit it in place. Saving it
unchanged renders identically to leaving it blank; clearing the box returns to the built-in wording.

The moderator attribution line is appended to *any* wording when the setting is on, so editing the
notice does not silently disable that setting. If the text already uses `{mod}`, the line is not
added twice.

### Picking a notice at verify time

The mod team can save two or three wordings (full documents, registered rescue, partial paperwork)
in settings. When any exist, the verify form grows a dropdown; picking one uses that wording for the
public comment, and the record stores which was used. The **body always comes from the server** —
the form only submits an id — so this can never be used to type arbitrary text into a public comment.

### Fundraiser flair

Set **Which flair marks a fundraiser** and the bot only replies to, and only reports, posts carrying
that flair. Everything else is ignored, which is the single biggest noise reduction available on a
busy subreddit. The settings form lists your actual post flairs; on a subreddit with none (a fresh
test sub) it falls back to a text box so you are not stuck with an empty menu.

Links are still indexed for every post — that is cheap Redis work — but a report is only ever filed
against a flaired post.

### Author history and deletion

`fv:auth:{username}` holds a post id and a timestamp per verification, and is **not** erased when a
post is deleted. It records what the moderator team did — the same thing a mod note records, and
Reddit keeps those too. It holds no post content: the body, notes, checklist answers and author name
on the verification record itself are all scrubbed on deletion as before. This is what lets a
moderator see that someone has raised here before and since removed the evidence.

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

186 tests across pure logic (sanitisation, dates, retry classification, settings resolution and
clamping, checklist parsing, comment wording, URL normalisation, hashing) and the four services
against in-memory fakes: idempotency, concurrent runs, expired and mismatched tokens, missing posts,
deleted authors, v1→v2 record migration, every partial-failure path, duplicate races, link release
on deletion, batching and chain limits, and the OP-reply shortcut.

The thin HTTP handlers in `handlers/` are not unit tested, because they import `context` from
`@devvit/web/server`, which only exists inside the Devvit runtime. All of their logic lives in the
service layer, which is tested; the handlers are exercised during playtest.

## Not built

- Repeat-fundraiser tracking (how many times one person has raised here, and when).
- A public wiki index of verified fundraisers.
- Outcome tracking: whether a fundraiser actually completed.

## Test counts

186 unit tests across six files. Everything below the HTTP handlers is covered; the handlers
themselves are exercised during playtest.
