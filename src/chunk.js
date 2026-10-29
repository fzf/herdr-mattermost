export const POST_LIMIT = 16000;
const ZWSP = "​";

// Output lines may contain ``` which would close our code block.
export function sanitize(text) {
  return text.replace(/```/g, "`" + ZWSP + "`" + ZWSP + "`");
}

export function fenced(body) {
  return "```text\n" + body + "\n```";
}

const overhead = fenced("").length;

export function canAppend(body, addition, limit = POST_LIMIT) {
  return overhead + body.length + 1 + addition.length <= limit;
}

// Split unfenced text so each piece fences to <= limit. Prefer line
// boundaries; hard-split lines that are themselves too long.
export function chunks(text, limit = POST_LIMIT) {
  const max = limit - overhead;
  if (!text) return ["(empty)"];
  const out = [];
  let cur = "";
  const push = () => { if (cur) { out.push(cur); cur = ""; } };
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    while (line.length > max) {
      push();
      out.push(line.slice(0, max));
      line = line.slice(max);
    }
    if (!cur) cur = line;
    else if (cur.length + 1 + line.length <= max) cur += "\n" + line;
    else { push(); cur = line; }
  }
  push();
  return out.length ? out : ["(empty)"];
}
