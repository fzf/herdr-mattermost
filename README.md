# herdr-mattermost

A [Herdr](https://herdr.dev) plugin that turns Mattermost into a UI layer for
coding agents.

- **Each watched Mattermost channel is a Herdr workspace.**
- **Each root post in that channel starts an agent** in a new tab, with the
  post as its first prompt.
- **The thread under the post is the session**: replies are prompts, the
  agent's terminal output is relayed into the thread as it runs, and status
  posts (`blocked`, `done`) ask you for input when the agent needs it.

Mattermost posts hold ~16k characters, so most agent replies land as one
message instead of being chopped into 2,000-character pieces. Output is
appended to the current post in place, so a session reads as a few long
blocks rather than hundreds of fragments.

Ported from [ralphilius/herdr-discord](https://github.com/ralphilius/herdr-discord);
the relay, prompt parsing and Herdr CLI wrapper come from there.

## Requirements

- Herdr `>= 0.9.0`
- Node.js `>= 22` (uses the built-in `fetch` and `WebSocket`; no dependencies)
- A Mattermost server you administer (bot accounts and personal access
  tokens enabled)

## Mattermost setup

On the Mattermost host, create the bot and its token. `mmctl --local` cannot
create bots, so the script mints a temporary access token for an admin user,
creates the bot over the REST API, revokes that token, and then generates the
bot's own token:

```sh
# plain install (server on http://localhost:8065)
./scripts/setup-bot.sh <team-name> <admin-username>
# docker install, or a server reached by URL
MM_URL=https://chat.example.org MMCTL="docker exec mattermost mmctl --local" \
  ./scripts/setup-bot.sh <team-name> <admin-username>
```

It prints `MM_TOKEN=…`. Then, in Mattermost, invite the bot to each channel
you want watched (`/invite @herdr`) and put a `herdr:` marker in the channel
header:

```
herdr: cwd=~/code/my-api kind=claude
herdr: {"kind": "codex", "cwd": "/srv/infra", "machine": "gpu-box"}
herdr:                     # marker alone = watch with global defaults
```

Keys: `cwd`, `kind`, `label` (workspace name), `machine` (a saved
`herdr machine` profile), `workspace` (existing workspace id or label — binds
instead of creating). `!setup` posted in the channel works too (see below).

## Install

```sh
herdr plugin install fzf/herdr-mattermost
```

Or link a local checkout while developing:

```sh
git clone https://github.com/fzf/herdr-mattermost
cd herdr-mattermost
herdr plugin link .
```

## Configure

```sh
CONFIG_DIR="$(herdr plugin config-dir herdr.mattermost)"
cp .env.example "$CONFIG_DIR/.env"
chmod 600 "$CONFIG_DIR/.env"
```

Edit `$CONFIG_DIR/.env` — at minimum `MM_URL`, `MM_TOKEN` and `MM_TEAM`. Set
`MM_ALLOWED_USERS` to your username. See [.env.example](.env.example) for
every option. An optional `channels.json` in the same directory overrides
channel config by channel id or `team/channel-name`
(see [channels.example.json](channels.example.json)).

## Run

```sh
herdr plugin action invoke herdr.mattermost.open-bot   # opens the bot tab
herdr plugin action invoke herdr.mattermost.status     # prints bridge state
```

Set `MM_AUTOSTART=1` in `.env` to reopen the bot tab automatically whenever
the Herdr server starts. The pane runs a supervisor that restarts the bot
with backoff if it crashes, so a bad token self-heals once `.env` is fixed.

Optional keybinding:

```toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "herdr.mattermost.open-bot"
description = "open Mattermost bot"
```

## Using the bridge

1. **Post in a watched channel.** Every root post by an allowed user that
   doesn't start with `!` starts an agent. The post is the first prompt;
   directive lines on their own (`kind:codex`, `cwd:/path`, `machine:gpu`)
   override the channel defaults. Attachments are downloaded next to the
   bot's state and their local paths are appended to the prompt, so the
   agent can open them.
2. **Reply in the thread** to prompt the agent. Replies are prefixed with
   your username. A ✅ reaction means sent; 📥 means sent while the agent was
   working (kinds that queue input natively: `claude`, `codex`); ⏳ means held
   until the agent settles (every other kind), swapped to ✅ when delivered.
3. **Output relays into the thread** as the agent runs: the bot diffs the
   terminal scrollback every poll and appends the settled lines to the
   current output post, starting a new post only when it fills up.
4. **When the agent blocks** on a question, the bot posts the terminal
   snapshot and a prompt post with reactions:
   - numbered menus → 1️⃣ 2️⃣ … one per option (arrows + Enter are sent)
   - y/n prompts → ✅ / ❌
   - anything else → ✅ Approve (Enter) / ❌ Cancel (Esc)

   Tap a reaction to answer, **or just reply in the thread**: while the
   agent is blocked a plain reply is typed into the pane as the answer.
5. `!!text` types raw input into the pane right now, regardless of agent
   state — for harness commands (`!!/btw status?`) or to force-send.

### Channel commands (root posts)

| Command            | Effect                                                   |
| ------------------ | -------------------------------------------------------- |
| `!setup [machine]` | List Herdr workspaces; react with a number to bind one   |
| `!unbind`          | Clear the workspace binding                              |
| `!status`          | Show the channel's binding and mapped-thread count       |
| `!help`            | Show channel commands                                    |

### Thread commands (replies)

| Command      | Effect                                                   |
| ------------ | -------------------------------------------------------- |
| `!status`    | Agent status + workspace/tab/pane ids                    |
| `!read [n]`  | Post the last n lines of agent output                    |
| `!queue`     | List prompts held until the agent settles                |
| `!approve`   | Send Enter to a blocked agent                            |
| `!close`     | Close the agent's Herdr tab and unmap the thread         |
| `!help`      | Show commands                                            |

## How it works

- `src/main.js` wires the real dependencies and starts the bot;
  `src/run.js` supervises it inside the plugin pane.
- `src/bot.js` is the orchestration: root posts → `workspace create` +
  `tab create` + `agent start`; replies → `agent prompt` (or the held
  queue / `!!` passthrough); a poller reads `agent list` for status and
  `agent read` for output; reactions answer blocked agents.
- `src/mattermost.js` is a small REST + websocket client (authenticates
  with `authentication_challenge`, reconnects with backoff). After every
  reconnect the bot fetches each mapped thread since the last post it saw,
  so prompts sent while it was down are not lost.
- `src/relay.js` diffs scrollback snapshots and emits lines once they
  stabilize; `src/output.js` appends them to the current post in place;
  `src/chunk.js` keeps every post under the Mattermost limit and keeps code
  fences intact.
- `src/prompts.js` parses blocked-prompt snapshots into options;
  `src/reactions.js` turns them into the emoji → keys table.
- `src/herdr.js` wraps the Herdr CLI (`HERDR_BIN_PATH`, JSON in/out);
  `src/state.js` persists thread/channel mappings under
  `HERDR_PLUGIN_STATE_DIR`; `src/config.js` reads `.env` and `channels.json`
  from `HERDR_PLUGIN_CONFIG_DIR`.

No inbound HTTP, no database, no SDK. Herdr owns the process, Mattermost
owns the UI.

**Security:** anyone who can post in a watched channel can steer your
agents. Use a private channel and set `MM_ALLOWED_USERS`.

## Development

```sh
npm test            # node --test, no network
```

Bump versions with `npm version patch|minor|major`; the `version` script
syncs `herdr-plugin.toml`. Installs pull from GitHub `main`, so push tags.

## License

MIT for this repository. The upstream `herdr-discord` code it was ported
from carries no license file and is used here with attribution.
