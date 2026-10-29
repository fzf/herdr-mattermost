import { keysForOption } from "./prompts.js";

export const NUMBER_EMOJI = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "keycap_ten"];

// Build the prompt post for a blocked agent and the emoji → keys table the
// bot adds as reactions. The user taps a reaction (or replies in the thread).
export function promptPlan(parsed, agentName) {
  const reactions = [];
  const lines = [`🛑 \`${agentName}\` needs input — react below or reply in this thread:`];
  if (parsed.type === "options") {
    parsed.options.slice(0, NUMBER_EMOJI.length).forEach((opt, i) => {
      const label = `${opt.num}. ${opt.label}`;
      lines.push(`:${NUMBER_EMOJI[i]}: ${label}`);
      reactions.push({ emoji: NUMBER_EMOJI[i], keys: keysForOption(parsed, opt.index), label });
    });
  } else if (parsed.type === "yesno") {
    lines.push(":white_check_mark: Yes · :x: No");
    reactions.push({ emoji: "white_check_mark", keys: ["y"], label: "Yes" });
    reactions.push({ emoji: "x", keys: ["n"], label: "No" });
  } else {
    lines.push(":white_check_mark: Approve (Enter) · :x: Cancel (Esc)");
    reactions.push({ emoji: "white_check_mark", keys: ["enter"], label: "Approve (Enter)" });
    reactions.push({ emoji: "x", keys: ["esc"], label: "Cancel (Esc)" });
  }
  return { text: lines.join("\n"), reactions };
}

export function keysForReaction(plan, emoji) {
  const r = (plan?.reactions ?? []).find((x) => x.emoji === emoji);
  return r ? { keys: r.keys, label: r.label } : null;
}
