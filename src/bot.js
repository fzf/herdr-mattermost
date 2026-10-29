import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parsePrompt } from "./prompts.js";
import { midTurnDescription } from "./capabilities.js";
import { handleUserText, flushQueue } from "./thread-input.js";
import { parseStarter, tabLabel, slugify } from "./starter.js";
import { promptPlan, keysForReaction, NUMBER_EMOJI } from "./reactions.js";
import { newUserPosts } from "./catchup.js";
import { chunks, fenced } from "./chunk.js";

const CHANNEL_TTL_MS = 60_000;
const START_RETRIES = 10;
const START_RETRY_MS = 1000;

// herdr does not expand `~` in --cwd; a tab started with one lands in $HOME.
export function expandHome(path) {
  if (!path) return path;
  return path === "~" ? homedir() : path.replace(/^~\//, `${homedir()}/`);
}

export function createBot({ config, mm, herdr, state, saveState, output, relay, team, allowed, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const persist = () => saveState(state);
  const botUserId = () => mm.userId;
  const authorized = (userId) => allowed.size === 0 || allowed.has(userId);
  const channelCache = new Map(); // id -> { at, info }
  const userCache = new Map();    // id -> username
  const pendingSetups = new Map(); // post id -> { channelId, machine, options }
  let connection = null;
  let timer = null;

  // ---- helpers -----------------------------------------------------------

  async function channelInfo(id) {
    const hit = channelCache.get(id);
    if (hit && Date.now() - hit.at < CHANNEL_TTL_MS) return hit.info;
    const info = await mm.channel(id);
    channelCache.set(id, { at: Date.now(), info });
    return info;
  }

  // Null when the channel is not watched; {} or the parsed config otherwise.
  async function watchConfig(channelId) {
    const info = await channelInfo(channelId).catch(() => null);
    const header = info ? `${info.header ?? ""}\n${info.purpose ?? ""}` : "";
    const key = info ? `${team.name}/${info.name}` : null;
    return config.channelConfig(channelId, header, key) ?? (state.channels[channelId]?.bound ? {} : null);
  }

  async function userName(id, data) {
    if (data?.sender_name) return data.sender_name.replace(/^@/, "");
    if (userCache.has(id)) return userCache.get(id);
    const u = await mm.user(id).catch(() => null);
    const name = u?.username ?? id;
    userCache.set(id, name);
    return name;
  }

  const say = (channelId, rootId, message) =>
    mm.createPost({ channelId, rootId, message }).catch((e) => log.error(`post failed: ${e.message}`));

  async function postOutput(mapping, text) {
    const body = text.trim() || "(no output)";
    for (const part of chunks(body)) await say(mapping.channel_id, mapping.root_id, fenced(part));
  }

  async function downloadAttachments(post) {
    const paths = [];
    for (const fileId of post.file_ids ?? []) {
      try {
        const info = await mm.fileInfo(fileId);
        const dir = join(config.stateDir, "files");
        mkdirSync(dir, { recursive: true });
        const safe = String(info.name ?? fileId).replace(/[^A-Za-z0-9._-]+/g, "_");
        paths.push(await mm.downloadFile(fileId, join(dir, `${post.id}-${safe}`)));
      } catch (err) {
        log.error(`attachment ${fileId} failed: ${err.message}`);
      }
    }
    return paths;
  }

  async function resolveWorkspace(idOrLabel, machine) {
    const workspaces = await herdr.listWorkspaces(machine).catch(() => []);
    return workspaces.find((w) => w.workspace_id === idOrLabel || w.label === idOrLabel) ?? null;
  }

  // `tab create` returns before the new shell has printed its prompt; `agent
  // start` rejects with agent_pane_busy until it has. Retry briefly. An agent
  // that comes up blocked on a startup dialog (agent_not_ready) is still a
  // running agent: report it so the poller can surface the dialog.
  async function startAgentWhenReady(args) {
    for (let attempt = 1; ; attempt++) {
      try {
        await herdr.startAgent(args);
        return { blocked: false };
      } catch (err) {
        if (err.code === "agent_not_ready") return { blocked: true };
        if (err.code !== "agent_pane_busy" || attempt >= START_RETRIES) throw err;
        await sleep(START_RETRY_MS);
      }
    }
  }

  function mappingForPrompt(postId) {
    return Object.values(state.threads).find((t) => t.prompt_post_id === postId) ?? null;
  }

  async function clearPrompt(mapping, note) {
    const id = mapping.prompt_post_id;
    if (!id) return;
    for (const r of mapping.prompt_reactions ?? []) await mm.removeReaction(id, r.emoji).catch(() => {});
    if (note) {
      const text = mapping.prompt_text ?? "";
      await mm.editPost(id, `${text}\n— ${note}`).catch(() => {});
    }
    delete mapping.prompt_post_id;
    delete mapping.prompt_reactions;
    delete mapping.prompt_text;
  }

  // ---- root posts → agents ----------------------------------------------

  async function startAgentForPost(post, data) {
    if (!authorized(post.user_id)) return;
    const channelCfg = await watchConfig(post.channel_id);
    if (channelCfg === null) return;

    const channelId = post.channel_id;
    const rootId = post.id;
    try {
      const directives = parseStarter(post.message);
      const files = await downloadAttachments(post);
      const prompt = [directives.prompt, ...files].filter(Boolean).join("\n");
      const kind = directives.kind ?? channelCfg.kind ?? config.agentKind;
      const cwd = expandHome(directives.cwd ?? channelCfg.cwd ?? config.cwd);
      const chState = (state.channels[channelId] ??= {});
      const machine = directives.machine ?? channelCfg.machine ?? chState.machine ?? null;

      await say(channelId, rootId, `Starting a **${kind}** agent for this thread…`);

      let workspace;
      if (channelCfg.workspace) {
        workspace = await resolveWorkspace(channelCfg.workspace, machine);
        if (!workspace) throw new Error(`workspace "${channelCfg.workspace}" not found${machine ? ` on ${machine}` : ""} — fix the channel header or run \`!setup\``);
      } else {
        // Reuse the channel's workspace (bound or auto-created) while the machine matches.
        const useBound = Boolean(chState.workspace_id) && (chState.machine ?? null) === machine;
        const info = await channelInfo(channelId).catch(() => null);
        workspace = await herdr.ensureWorkspace({
          workspaceId: useBound ? chState.workspace_id : null,
          cwd: expandHome(channelCfg.cwd ?? config.cwd),
          label: channelCfg.label ?? info?.display_name ?? info?.name ?? `mattermost-${channelId}`,
          machine,
        });
        if (!chState.bound) { chState.machine = machine; chState.workspace_id = workspace.workspace_id; }
      }

      const label = tabLabel(prompt);
      const tab = await herdr.createTab({ workspaceId: workspace.workspace_id, cwd, label, machine });
      const paneId = tab.root_pane?.pane_id ?? tab.pane?.pane_id;
      if (!paneId) throw new Error("tab created but no root pane id in response");

      const existing = new Set((await herdr.listAgents(machine).catch(() => [])).map((a) => a.name ?? a.agent));
      for (const t of Object.values(state.threads)) if ((t.machine ?? null) === machine) existing.add(t.agent_name);
      const name = slugify(label, existing);

      const started = await startAgentWhenReady({ name, kind, paneId, machine });

      state.threads[rootId] = {
        root_id: rootId, channel_id: channelId,
        workspace_id: workspace.workspace_id, tab_id: tab.tab?.tab_id, pane_id: paneId,
        agent_name: name, kind, machine, last_status: "starting", last_seen_at: post.create_at ?? Date.now(),
      };
      persist();

      await say(channelId, rootId,
        `Agent \`${name}\` (${kind}) is up — tab \`${tab.tab?.tab_id}\` in workspace \`${workspace.workspace_id}\`${machine ? ` on \`${machine}\`` : ""}.\n` +
        "Reply here to prompt it; output relays here as it runs.\n" +
        `Mid-turn prompts: ${midTurnDescription(kind)} · \`!!text\` sends raw input immediately.\n` +
        "Commands: `!status` `!read [n]` `!queue` `!approve` `!close` `!help`");

      // Seed the relay with the agent's idle screen before the first prompt so
      // a fast answer is new output, not part of the baseline.
      if (!started.blocked) {
        const screen = await herdr.readAgent(name, { source: "recent-unwrapped", lines: 400, machine }).catch(() => null);
        if (screen !== null) { relay.update(rootId, screen); state.threads[rootId].relay_seeded = true; persist(); }
      }

      if (prompt && !prompt.startsWith("!")) {
        if (started.blocked) {
          state.threads[rootId].queue = [{ id: null, text: prompt }];
          persist();
          await say(channelId, rootId, "The agent is blocked on a startup dialog — answer it below and your post is sent once it is ready.");
        } else {
          await herdr.promptAgent(name, prompt, machine);
        }
      }
    } catch (err) {
      log.error("start agent failed:", err);
      await say(channelId, rootId, `Failed to start agent: ${err.message}`);
    }
  }

  // ---- channel commands ---------------------------------------------------

  async function onChannelCommand(post, text) {
    const channelId = post.channel_id;
    const rootId = post.id;
    const [cmd, arg] = text.slice(1).split(/\s+/, 2);
    const chState = state.channels[channelId];
    const watched = async () => (await watchConfig(channelId)) !== null;

    switch (cmd.toLowerCase()) {
      case "setup": {
        if (!authorized(post.user_id)) { await say(channelId, rootId, "You are not on the allowed-users list for this bridge."); return; }
        const machine = arg || (await watchConfig(channelId))?.machine || chState?.machine || null;
        const workspaces = (await herdr.listWorkspaces(machine).catch(() => [])).slice(0, NUMBER_EMOJI.length - 1);
        const options = workspaces.map((w) => ({ workspace_id: w.workspace_id, label: w.label ?? w.workspace_id, cwd: w.cwd ?? "" }));
        options.push({ new: true, label: "New workspace (auto-created on the first post)" });
        const lines = [`Bind this channel to a Herdr workspace${machine ? ` on \`${machine}\`` : ""} — react with a number:`];
        options.forEach((o, i) => lines.push(`:${NUMBER_EMOJI[i]}: ${o.label}${o.cwd ? ` — \`${o.cwd}\`` : ""}`));
        const p = await mm.createPost({ channelId, rootId, message: lines.join("\n") });
        for (let i = 0; i < options.length; i++) await mm.addReaction(p.id, NUMBER_EMOJI[i]).catch(() => {});
        pendingSetups.set(p.id, { channelId, machine, options, text: lines.join("\n") });
        break;
      }
      case "unbind": {
        if (!authorized(post.user_id)) return;
        delete state.channels[channelId];
        persist();
        await say(channelId, rootId, (await watched())
          ? "Workspace binding cleared — the header/channels.json still watch this channel, so new posts auto-create a workspace."
          : "Channel unbound — new posts will no longer spawn agents.");
        break;
      }
      case "status": {
        const lines = [`Channel watched: **${(await watched()) ? "yes" : "no"}**`];
        if (chState?.workspace_id) lines.push(`Workspace: \`${chState.workspace_id}\`${chState.bound ? " (bound via !setup)" : " (auto-created)"}`);
        if (chState?.machine) lines.push(`Machine: \`${chState.machine}\``);
        lines.push(`Mapped threads: ${Object.values(state.threads).filter((t) => t.channel_id === channelId).length}`);
        await say(channelId, rootId, lines.join("\n"));
        break;
      }
      case "help":
        await say(channelId, rootId,
          "`!setup [machine]` bind this channel to a Herdr workspace · `!unbind` clear the binding · `!status` channel state\n" +
          "Or put `herdr:` in the channel header, e.g. `herdr: workspace=my-api kind=claude`. Every other root post starts an agent.");
        break;
      default:
        await say(channelId, rootId, "Unknown command. `!setup [machine]` `!unbind` `!status` `!help`");
    }
  }

  // ---- thread commands ----------------------------------------------------

  async function onThreadCommand(post, mapping, text) {
    const [cmd, arg] = text.slice(1).split(/\s+/, 2);
    const { channel_id: channelId, root_id: rootId } = mapping;
    switch (cmd.toLowerCase()) {
      case "status": {
        const agent = await herdr.getAgent(mapping.agent_name, mapping.machine);
        const status = agent.status ?? agent.agent_status ?? "unknown";
        await say(channelId, rootId,
          `\`${mapping.agent_name}\` (${mapping.kind}) — **${status}**\n` +
          `workspace \`${mapping.workspace_id}\` tab \`${mapping.tab_id}\` pane \`${mapping.pane_id}\`` +
          (mapping.machine ? ` machine \`${mapping.machine}\`` : ""));
        break;
      }
      case "read": {
        const n = Math.min(Math.max(parseInt(arg, 10) || config.outputLines, 1), 80);
        await postOutput(mapping, await herdr.readAgent(mapping.agent_name, { lines: n, machine: mapping.machine }));
        break;
      }
      case "approve":
        await herdr.sendKeys(mapping.agent_name, ["enter"], mapping.machine);
        await mm.addReaction(post.id, "+1").catch(() => {});
        break;
      case "queue": {
        const q = mapping.queue ?? [];
        await say(channelId, rootId, q.length
          ? `Held messages (${q.length}):\n` + q.map((e, i) => `${i + 1}. ${e.text.split("\n")[0].slice(0, 80)}`).join("\n")
          : "No held messages.");
        break;
      }
      case "close":
        await say(channelId, rootId, "Closing the agent tab…");
        if (mapping.tab_id) await herdr.closeTab(mapping.tab_id, mapping.machine).catch(() => {});
        await clearPrompt(mapping, null);
        relay.drop(rootId);
        output.drop(rootId);
        delete state.threads[rootId];
        persist();
        break;
      case "setup":
        await say(channelId, rootId, "`!setup` is a channel command — post it as a new root post in the channel. This thread already has an agent (`!status` to check it).");
        break;
      case "help":
        await say(channelId, rootId,
          "`!status` agent status · `!read [n]` last n output lines · `!queue` held prompts · " +
          "`!approve` send Enter to a blocked agent · `!close` close the agent tab\n" +
          "`!!text` types raw input into the agent right now. While the agent is blocked, a plain reply is typed in as the answer.\n" +
          "Root-post directives (own lines): `kind:<agent>` `cwd:<path>` `machine:<label>`. Channel config goes in the header: `herdr: kind=codex cwd=~/code/x`.");
        break;
      default:
        break; // not a bridge command
    }
  }

  // ---- events ---------------------------------------------------------------

  async function handlePosted(post, data) {
    try {
      if (!post || post.user_id === botUserId()) return;
      if (post.type) return; // system messages
      const text = (post.message ?? "").trim();

      if (!post.root_id) {
        if (text.startsWith("!")) await onChannelCommand(post, text);
        else await startAgentForPost(post, data);
        return;
      }

      const mapping = state.threads[post.root_id];
      if (!mapping) return;
      if (post.create_at > (mapping.last_seen_at ?? 0)) { mapping.last_seen_at = post.create_at; persist(); }
      if (!authorized(post.user_id)) { await say(mapping.channel_id, mapping.root_id, "You are not on the allowed-users list for this bridge."); return; }
      if (text.startsWith("!") && !text.startsWith("!!")) return onThreadCommand(post, mapping, text);

      const files = await downloadAttachments(post);
      const prompt = `${await userName(post.user_id, data)}: ${text}` + (files.length ? `\n${files.join("\n")}` : "");
      await handleUserText({ post, mapping, text, prompt, mm, herdr, persist });
    } catch (err) {
      log.error("posted handler failed:", err);
      if (post?.channel_id) await say(post.channel_id, post.root_id || post.id, `Error: ${err.message}`);
    }
  }

  async function handleReaction(reaction) {
    try {
      const { user_id: userId, post_id: postId, emoji_name: emoji } = reaction;
      if (userId === botUserId()) return;
      if (!authorized(userId)) return;

      const setup = pendingSetups.get(postId);
      if (setup) {
        const idx = NUMBER_EMOJI.indexOf(emoji);
        const choice = setup.options[idx];
        if (!choice) return;
        state.channels[setup.channelId] = choice.new
          ? { bound: true, machine: setup.machine ?? null }
          : { bound: true, machine: setup.machine ?? null, workspace_id: choice.workspace_id };
        persist();
        pendingSetups.delete(postId);
        for (let i = 0; i < setup.options.length; i++) await mm.removeReaction(postId, NUMBER_EMOJI[i]).catch(() => {});
        await mm.editPost(postId, choice.new
          ? `Channel bound — a new workspace will be created on the first post${setup.machine ? ` on \`${setup.machine}\`` : ""}.`
          : `Channel bound to workspace \`${choice.workspace_id}\`${setup.machine ? ` on \`${setup.machine}\`` : ""}. New root posts spawn agents as tabs there.`).catch(() => {});
        return;
      }

      const mapping = mappingForPrompt(postId);
      if (!mapping) return;
      const plan = { reactions: mapping.prompt_reactions ?? [] };
      const choice = keysForReaction(plan, emoji);
      if (!choice) return;
      const agent = await herdr.getAgent(mapping.agent_name, mapping.machine).catch(() => null);
      const status = agent?.status ?? agent?.agent_status;
      if (status && status !== "blocked") {
        await clearPrompt(mapping, `already answered (agent is ${status})`);
        persist();
        return;
      }
      await herdr.sendKeys(mapping.agent_name, choice.keys, mapping.machine);
      await clearPrompt(mapping, `chose \`${choice.label}\` (${await userName(userId)})`);
      persist();
    } catch (err) {
      log.error("reaction handler failed:", err);
    }
  }

  // ---- polling ------------------------------------------------------------

  async function poll() {
    const byMachine = new Map();
    for (const [rootId, mapping] of Object.entries(state.threads)) {
      const machine = mapping.machine ?? null;
      if (!byMachine.has(machine)) byMachine.set(machine, []);
      byMachine.get(machine).push([rootId, mapping]);
    }
    let dirty = false;
    for (const [machine, entries] of byMachine) {
      const agents = await herdr.listAgents(machine).catch(() => null);
      if (agents === null) continue;
      const byName = new Map();
      for (const a of agents) { const n = a.name ?? a.agent; if (n) byName.set(n, a.status ?? a.agent_status ?? "unknown"); }
      for (const [rootId, mapping] of entries) {
        const status = byName.get(mapping.agent_name);
        dirty = (await relayOutput(rootId, mapping, status)) || dirty;
        dirty = (await relayTransition(rootId, mapping, status)) || dirty;
      }
    }
    if (dirty) persist();
  }

  async function relayOutput(rootId, mapping, status) {
    if (status === undefined) return false;
    const fresh = !relay.has(rootId);
    const text = await herdr.readAgent(mapping.agent_name, { source: "recent-unwrapped", lines: 400, machine: mapping.machine }).catch(() => null);
    if (text === null) return false;
    const emit = relay.update(rootId, text);
    let dirty = false;
    if (fresh) {
      if (mapping.relay_seeded) await say(mapping.channel_id, rootId, "⟳ relay resumed — output since the bot restart is not replayed");
      else { mapping.relay_seeded = true; dirty = true; }
    }
    if (emit.length) await output.append(rootId, { channelId: mapping.channel_id, rootId }, emit.join("\n")).catch((e) => log.error(`relay post failed: ${e.message}`));
    return dirty;
  }

  async function relayTransition(rootId, mapping, status) {
    const prev = mapping.last_status;
    const where = { channelId: mapping.channel_id, rootId };

    if (status === undefined) {
      if (prev === "gone") return false;
      mapping.last_status = "gone";
      const dropped = (mapping.queue ?? []).length;
      mapping.queue = [];
      const rest = relay.flush(rootId);
      relay.drop(rootId);
      if (rest.length) await output.append(rootId, where, rest.join("\n")).catch(() => {});
      output.drop(rootId);
      await clearPrompt(mapping, "agent exited");
      await say(mapping.channel_id, rootId, `Agent \`${mapping.agent_name}\` is no longer running.` + (dropped ? ` ${dropped} held message(s) dropped.` : ""));
      return true;
    }
    if (status === prev) return false;

    mapping.last_status = status;
    // Startup dialogs (trust-folder prompts and the like) must be surfaced, so a
    // blocked transition announces even from "starting"; "finished" does not.
    const announce = config.statusPosts && prev !== "gone" && (status === "blocked" || prev !== "starting");
    if (prev === "blocked" && mapping.prompt_post_id) await clearPrompt(mapping, "answered");

    if (status === "blocked") {
      output.reset(rootId);
      if (announce) {
        const snapshot = await herdr.readAgent(mapping.agent_name, { source: "detection", lines: 25, machine: mapping.machine }).catch(() => "");
        if (snapshot.trim()) await postOutput(mapping, snapshot);
        const plan = promptPlan(parsePrompt(snapshot), mapping.agent_name);
        const p = await mm.createPost({ channelId: mapping.channel_id, rootId, message: plan.text }).catch(() => null);
        if (p) {
          for (const r of plan.reactions) await mm.addReaction(p.id, r.emoji).catch(() => {});
          mapping.prompt_post_id = p.id;
          mapping.prompt_reactions = plan.reactions;
          mapping.prompt_text = plan.text;
        }
      }
    } else if (status === "done") {
      const rest = relay.flush(rootId);
      if (rest.length) await output.append(rootId, where, rest.join("\n")).catch(() => {});
      output.reset(rootId);
      if (announce) await say(mapping.channel_id, rootId, `✅ \`${mapping.agent_name}\` finished.`);
      await flushQueue(mapping, mm, herdr, persist);
    } else if (status === "idle") {
      await flushQueue(mapping, mm, herdr, persist);
    }
    return true;
  }

  // ---- reconnect catch-up -------------------------------------------------

  async function catchUp() {
    let missed = 0;
    for (const mapping of Object.values(state.threads)) {
      const payload = await mm.threadPosts(mapping.root_id, mapping.last_seen_at ?? 0).catch(() => null);
      if (!payload) continue;
      for (const post of newUserPosts(payload, { since: mapping.last_seen_at ?? 0, botUserId: botUserId() })) {
        missed++;
        await handlePosted(post, null);
      }
    }
    if (missed) log.log(`herdr-mattermost: processed ${missed} message(s) missed while disconnected`);
  }

  function start() {
    connection = mm.connect({ onPosted: handlePosted, onReaction: handleReaction, onConnected: () => catchUp().catch((e) => log.error("catch-up failed:", e)) });
    timer = setInterval(() => poll().catch((e) => log.error("poll failed:", e)), config.pollMs);
  }
  function stop() {
    if (timer) clearInterval(timer);
    connection?.close();
  }

  return { start, stop, handlePosted, handleReaction, poll, catchUp };
}
