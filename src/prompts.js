// Parse an agent's `detection` snapshot (the bottom-buffer Herdr uses for
// screen detection) into buttons the user can click to answer.

const CURSOR = /^\s*[❯›>●]/;
const NUMBERED = /^\s*[❯›>●•\-*]?\s*(\d+)[.)]\s+(.+?)\s*$/;
const YESNO = /\[y\/n\]|\(y\/n\)|\[yes\/no\]|\(yes\/no\)|\(y or n\)|\[y\/N\]|\[Y\/n\]/i;

export function parsePrompt(snapshot) {
  const lines = snapshot.split("\n");
  const options = [];
  let cursor = -1;
  lines.forEach((line, i) => {
    const m = line.match(NUMBERED);
    if (m) {
      options.push({ index: options.length, line: i, num: +m[1], label: m[2] });
      if (CURSOR.test(line)) cursor = options.length - 1;
    }
  });
  if (options.length >= 2 && options.length <= 20) return { type: "options", options, cursor };
  const cursorMenu = parseCursorMenu(lines);
  if (cursorMenu) return cursorMenu;
  if (YESNO.test(snapshot)) return { type: "yesno" };
  return { type: "unknown" };
}

// Unnumbered menus (Claude Code's trust-folder dialog, select lists): one
// line carries the cursor glyph and its siblings are aligned at the same
// text column, e.g.
//     ❯ No, exit
//       Yes, I trust this folder
// Options are the contiguous non-blank lines around the cursor whose text
// starts at that column; numbering is positional (1-based).
const CURSOR_LINE = /^(\s*)[❯›●]\s+(\S.*?)\s*$/;
function parseCursorMenu(lines) {
  const at = lines.findIndex((l) => CURSOR_LINE.test(l));
  if (at === -1) return null;
  const col = lines[at].match(CURSOR_LINE)[1].length + 2;
  const textAt = (l) => (l.length > col && /\S/.test(l[col]) && !/\S/.test(l.slice(0, col).replace(/[❯›●]/, "")) ? l.slice(col).trim() : null);
  let start = at;
  while (start > 0 && textAt(lines[start - 1])) start--;
  let end = at;
  while (end + 1 < lines.length && textAt(lines[end + 1])) end++;
  const options = [];
  for (let i = start; i <= end; i++) options.push({ index: options.length, line: i, num: options.length + 1, label: textAt(lines[i]) });
  if (options.length < 2 || options.length > 20) return null;
  return { type: "options", options, cursor: at - start };
}

// Keys to send for a parsed option. With a visible cursor row, move the
// selection with arrows and confirm; without one, press the option's number.
export function keysForOption(parsed, i) {
  if (parsed.cursor >= 0) {
    const delta = i - parsed.cursor;
    const keys = [];
    for (let k = 0; k < Math.abs(delta); k++) keys.push(delta > 0 ? "down" : "up");
    keys.push("enter");
    return keys;
  }
  return [String(parsed.options[i].num)];
}
