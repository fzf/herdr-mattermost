// Directive lines in a root post: `kind:codex`, `cwd:/path`, `machine:gpu-box`.
export function parseStarter(content) {
  const directives = {};
  const rest = [];
  for (const line of (content ?? "").split("\n")) {
    const m = line.trim().match(/^(kind|cwd|machine)\s*:\s*(\S+)\s*$/i);
    if (m) directives[m[1].toLowerCase()] = m[2];
    else rest.push(line);
  }
  return { ...directives, prompt: rest.join("\n").trim() };
}

export function tabLabel(prompt) {
  const line = (prompt ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  return (line ?? "agent").slice(0, 60);
}

export function slugify(label, taken) {
  const base = `mm-${(label ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")}`
    .slice(0, 31)
    .replace(/-+$/, "");
  let candidate = base === "mm" ? "mm-agent" : base;
  for (let i = 2; taken.has(candidate); i++) candidate = `${candidate.slice(0, 28).replace(/-+$/, "")}-${i}`;
  return candidate;
}
