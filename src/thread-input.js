import { midTurnStrategy } from "./capabilities.js";

const reply = (mm, post, mapping, message) =>
  mm.createPost({ channelId: post.channel_id, rootId: mapping.root_id, message }).catch(() => {});
const react = (mm, post, emoji) => mm.addReaction(post.id, emoji).catch(() => {});

export async function handleUserText({ post, mapping, text, prompt, mm, herdr, persist }) {
  const status = mapping.last_status;
  if (status === "gone") {
    await reply(mm, post, mapping, `Agent \`${mapping.agent_name}\` is no longer running.`);
    return;
  }

  if (text.startsWith("!!")) {
    const raw = text.slice(2);
    if (!raw) {
      await reply(mm, post, mapping, "`!!` types raw input into the agent's pane — e.g. `!!/btw status?`");
      return;
    }
    try {
      await herdr.sendText(mapping.pane_id, raw, mapping.machine);
      await herdr.sendKeys(mapping.agent_name, ["enter"], mapping.machine);
      await react(mm, post, "zap");
    } catch (err) {
      await reply(mm, post, mapping, `Raw send failed: ${err.message}`);
    }
    return;
  }

  if (status === "blocked") {
    // The agent is waiting on a dialog: a plain reply is the answer.
    try {
      await herdr.sendText(mapping.pane_id, text, mapping.machine);
      await herdr.sendKeys(mapping.agent_name, ["enter"], mapping.machine);
      await react(mm, post, "keyboard");
    } catch (err) {
      await reply(mm, post, mapping, `Couldn't type the answer: ${err.message}`);
    }
    return;
  }

  const settled = status === "idle" || status === "done";
  const canSendNow = settled || (status === "working" && midTurnStrategy(mapping.kind) === "queue");
  if (!canSendNow) {
    (mapping.queue ??= []).push({ id: post.id, text: prompt });
    if (!mapping.queue_explained) {
      mapping.queue_explained = true;
      await reply(mm, post, mapping,
        `\`${mapping.kind}\` can't take input mid-turn — holding until it settles. \`!!text\` sends raw input immediately.`);
    }
    persist();
    await react(mm, post, "hourglass_flowing_sand");
    return;
  }
  try {
    await herdr.promptAgent(mapping.agent_name, prompt, mapping.machine);
    await react(mm, post, status === "working" ? "inbox_tray" : "white_check_mark");
  } catch (err) {
    if (err.code === "agent_blocked") {
      (mapping.queue ??= []).push({ id: post.id, text: prompt });
      persist();
      await react(mm, post, "hourglass_flowing_sand");
    } else {
      throw err;
    }
  }
}

// Send held prompts FIFO once the agent settles; swap ⏳ for ✅ on each.
export async function flushQueue(mapping, mm, herdr, persist) {
  const queue = mapping.queue ?? [];
  while (queue.length) {
    const entry = queue[0];
    try {
      await herdr.promptAgent(mapping.agent_name, entry.text, mapping.machine);
    } catch (err) {
      await mm.createPost({ channelId: mapping.channel_id, rootId: mapping.root_id,
        message: `Couldn't send a held message: ${err.message} — ${queue.length} still queued.` }).catch(() => {});
      return;
    }
    queue.shift();
    persist();
    if (entry.id) {
      await mm.removeReaction(entry.id, "hourglass_flowing_sand").catch(() => {});
      await mm.addReaction(entry.id, "white_check_mark").catch(() => {});
    }
  }
}
