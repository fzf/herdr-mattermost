# herdr-mattermost — design

Date: 2026-10-29
Status: draft for review

## Goal

A herdr plugin (`herdr.mattermost`) that uses Mattermost as a UI layer for
herdr coding agents, replacing the `herdr.discord` plugin fzf runs today.
Channels map to workspaces, root posts spawn agents in tabs, threads carry
prompts in and output out. The reason for the move is message length:
Discord chunks everything at 1,900 characters; Mattermost accepts at least
16,383 per post, so most agent replies land as one message.

Target server: `https://chat.tacodogs.org` (Mattermost 12.x, team `home`).
Bot host: the Mac running the herdr server (plugin pane, like Discord today).

## What stays the same as herdr-discord

Behavior ported one-to-one, with the same semantics and commands:

- Channel → workspace binding via a `herdr:` marker (`cwd`, `kind`, `label`,
  `machine`, `workspace` keys, key=value or JSON) or `!setup` with a
  `channels.json` override. `!unbind`, `!status`, `!help` channel commands.
- Agent lifecycle per thread: `workspace create` (or bind) → `tab create` →
  `agent start`; thread commands `!status`, `!read [n]`, `!queue`,
  `!approve`, `!close`, `!help`.
- Prompt routing: settled agents get `agent prompt`; mid-turn behavior per
  kind (`claude`/`codex` queue natively, others are held until idle/done);
  `!!text` raw passthrough; held-queue flush with reaction swap ⏳→✅.
- Output relay: poll `agent read --source recent-unwrapped --lines 400`,
  diff with the stabilizing-tail algorithm, collapse duplicate/blank runs,
  resume note after bot restart.
- Status transitions: `blocked` posts a detection snapshot plus a prompt;
  `done` flushes the relay and the held queue; `gone` reports and drops.
- Supervisor (`run.js`, backoff restart), startup hook (autostart the bot
  tab), `open-bot` and `status` actions, `.env` in `HERDR_PLUGIN_CONFIG_DIR`,
  state in `HERDR_PLUGIN_STATE_DIR`, all herdr calls through `herdr.js`
  using `HERDR_BIN_PATH`.

Modules `relay.js`, `prompts.js`, `topics.js`, `capabilities.js`, `herdr.js`
and their tests are carried over essentially unchanged; `thread-input.js`
is adapted to the Mattermost message shape.

## What changes

### 1. Transport: Mattermost websocket + REST, no SDK

- Connect `wss://<MM_URL>/api/v4/websocket`, send
  `{seq:1, action:"authentication_challenge", data:{token}}`, expect
  `hello` then `{status:"OK"}`. Verified on the live server.
- Events consumed: `posted` (`data.post` is a JSON string; `root_id` empty
  = root post), `reaction_added` (`data.reaction` JSON string with
  `user_id`, `post_id`, `emoji_name`). Everything else ignored.
- REST used: `POST /posts` (with `root_id` for replies), `PUT /posts/{id}/patch`
  (edit in place), `GET /channels/{id}` (header/purpose), `GET /posts/{id}/thread?since=`
  (catch-up), `POST /reactions`, `DELETE /users/{uid}/posts/{pid}/reactions/{name}`,
  `GET /users/me`, `GET /teams/name/{team}`, `GET /users/username/{name}`,
  `GET /files/{id}` (attachments).
- Node ≥ 22 for the global `WebSocket` and `fetch`; no runtime dependencies.
- Reconnect with backoff (1s → 60s). After every (re)connect, for each mapped
  thread fetch posts since `last_seen_at` and process any user posts that
  arrived while disconnected, so prompts are never silently lost. `posted`
  events update `last_seen_at`.
- Posts by the bot's own user id, and posts with a non-empty `type` (system
  messages), are ignored.

### 2. Thread model: a root post is a thread

Discord has an explicit "create thread" action; Mattermost does not. Rule:
in a watched channel, **every root post by an allowed user that is not a `!`
command starts an agent**. The post text (minus directive lines) is the first
prompt; the first line (≤60 chars) is the tab label; the agent name is
`mm-<slug>` de-duplicated against live agents. All replies in that thread
are prompts for that agent. Mappings are keyed by root post id.

Starter directives on their own lines (`kind:`, `cwd:`, `machine:`) work as
before. Attachments on a user post are downloaded with the bot token to
`$HERDR_PLUGIN_STATE_DIR/files/<post>-<name>` and the local paths are
appended to the prompt, so agents can actually open them (Discord passed
URLs, which only worked for public CDN links).

A channel is watched when `channels.json` has an entry, when its **header**
or purpose contains `herdr:`, or when it is bound via `!setup`. The bot must
be a member of the channel to see its posts (`/invite @herdr`).

### 3. Answering blocked agents: reactions + plain reply

No inbound HTTP is required, so this works from a phone off the LAN.

When an agent turns `blocked`, the bot posts the detection snapshot in a code
block, then a prompt post:

- Numbered menu (2–10 options parsed from the snapshot): the post lists
  `1. …` lines; the bot adds reactions `one` … `nine`, `keycap_ten`. A
  reaction from an allowed user sends the keys `keysForOption` computes
  (arrows + Enter when a cursor row is visible, else the number).
- y/n prompt: reactions `white_check_mark` (`y`) and `x` (`n`).
- Anything else: `white_check_mark` (Enter) and `x` (Esc).
- A **plain reply in the thread while the agent is blocked is the answer**:
  typed into the pane with `pane send-text` then Enter (this replaces
  Discord's "Type answer…" modal). `!!text` still forces raw input anytime.

After an answer the prompt post is edited to `— chose 1. Yes (fzf)` and the
bot removes its own reactions. If the agent is no longer blocked when a
reaction arrives, the post is edited to say so and no keys are sent.
Reactions are only honored on prompt posts the bot remembers (`prompt_post_id`
in the mapping), only from allowed users, and only while the mapping exists.

`!setup` presents the workspace choice the same way: a numbered list with
number reactions; "new workspace" is the last option.

### 4. Output relay: append in place

Per thread the bot keeps `output_post_id` and the accumulated text of that
post. New relay lines are appended by editing the post (`PUT /posts/{id}/patch`)
until the next append would exceed `POST_LIMIT` (16,000 chars including the
code fence); then a fresh post is started. A new output post is also started
after a status transition and after a bot restart. Status, blocked, done and
error messages are always separate new posts so they notify.

Lines containing a code fence (```) get a zero-width space inserted so the
block cannot be broken out of. Terminal escape sequences are not expected
(`agent read` returns plain text).

### 5. Configuration (`.env` in the plugin config dir)

```
MM_URL=https://chat.tacodogs.org      # required
MM_TOKEN=                             # required: bot account token
MM_TEAM=home                          # team name; required
MM_ALLOWED_USERS=fzf                  # comma-separated usernames or ids; empty = anyone in a watched channel
HERDR_AGENT_KIND=claude
HERDR_WORKSPACE_CWD=
MM_AUTOSTART=1
MM_STATUS_POSTS=1
MM_OUTPUT_LINES=30
MM_POLL_MS=3000
```

Usernames in `MM_ALLOWED_USERS` are resolved to ids at startup.
`channels.json` keys are Mattermost channel ids (or `team/channel-name`,
resolved at startup).

### 6. Repo and packaging

- `~/Projects/herdr-mattermost`, pushed to `github.com/fzf/herdr-mattermost`
  (public, topics `herdr-plugin`, `herdr`, `mattermost`) so it is installable
  with `herdr plugin install fzf/herdr-mattermost` and listed in the
  marketplace.
- `herdr-plugin.toml`: id `herdr.mattermost`, pane `bot` (placement `tab`,
  `node src/run.js`), startup `node src/startup.js`, actions `open-bot` and
  `status`, `[[build]]` omitted (no dependencies to install).
- ESM Node, no build step, `node --test test/` with node:test.
- Versioning via `npm version` + `scripts/sync-version.js` as upstream.
- README credits `ralphilius/herdr-discord` as the origin. **Note:** that
  repo has no license file, so the carried-over modules are technically
  all-rights-reserved. Before publishing publicly, either get the author's
  OK or accept the risk; fzf's call. Our repo will carry an MIT license for
  the new code.

### 7. Server-side setup (one-time, scripted in `scripts/setup-bot.sh`)

On fzf-ubuntu via `mmctl --local`: create bot `herdr` (display name
"herdr"), generate its token, add it to team `home`. The user invites the
bot to each channel they want watched and puts `herdr: …` in the channel
header. The bot token goes into the plugin `.env`.

## Non-goals

- Mattermost Blocks buttons, slash commands, or any inbound HTTP.
- Multi-team support (one team per bot instance).
- Running the bot anywhere but the herdr server host.
- Replaying output missed while the bot was down (same as upstream).

## Testing

- Unit (node:test, no network): relay, prompts, topics, capabilities
  (carried over); thread-input adapted; new tests for `chunk.js`
  (fence-safe splitting and append-in-place sizing), `starter.js`
  (directives + label + slug), `reactions.js` (emoji ↔ option mapping,
  authorization, stale-prompt handling), `catchup.js` (which posts in a
  thread fetch are new user posts) and a `MattermostClient` test against a
  fake `fetch`/`WebSocket`.
- Integration, manual, against chat.tacodogs.org: `!setup` a channel, root
  post spawns a claude agent, reply prompts it, output appends in place,
  block on a permission prompt and answer via reaction, `!close`.

## Data

`state.json` (in `HERDR_PLUGIN_STATE_DIR`):

```
channels: { <channel_id>: { bound, machine, workspace_id } }
threads:  { <root_post_id>: { channel_id, workspace_id, tab_id, pane_id,
             agent_name, kind, machine, last_status, queue[], queue_explained,
             relay_seeded, last_seen_at, output_post_id, output_len,
             prompt_post_id, prompt_kind, prompt_options[] } }
```

## Error handling

- Bad/missing token or URL: fail fast with a clear message; `run.js` retries
  with backoff so fixing `.env` self-heals.
- herdr CLI errors surface as a thread reply (`Failed to start agent: …`),
  as upstream.
- REST failures on post/edit are logged and retried once; relay lines that
  fail to post stay pending for the next tick (the relay already defers).
- Websocket drop: reconnect + catch-up; a `⟳ reconnected` note is posted
  only if catch-up found missed prompts.
