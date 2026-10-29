import test from "node:test";
import assert from "node:assert/strict";
import { OutputWriter } from "../src/output.js";
import { fenced } from "../src/chunk.js";

function fakeMM() {
  const posts = [];
  let n = 0;
  return {
    posts,
    async createPost({ channelId, rootId, message }) { const p = { id: `p${++n}`, channelId, rootId, message }; posts.push(p); return p; },
    async editPost(id, message) { const p = posts.find((x) => x.id === id); p.message = message; p.edits = (p.edits ?? 0) + 1; return p; },
  };
}

const where = { channelId: "ch", rootId: "root" };

test("first append creates a fenced post; later appends edit it in place", async () => {
  const mm = fakeMM();
  const w = new OutputWriter({ mm, limit: 200 });
  await w.append("root", where, "line 1");
  await w.append("root", where, "line 2\nline 3");
  assert.equal(mm.posts.length, 1);
  assert.equal(mm.posts[0].message, fenced("line 1\nline 2\nline 3"));
  assert.equal(mm.posts[0].rootId, "root");
});

test("a new post starts when the next append would exceed the limit", async () => {
  const mm = fakeMM();
  const w = new OutputWriter({ mm, limit: 60 });
  await w.append("root", where, "a".repeat(30));
  await w.append("root", where, "b".repeat(30));
  assert.equal(mm.posts.length, 2);
  for (const p of mm.posts) assert.ok(p.message.length <= 60);
});

test("reset forces a new post; sanitize keeps fences intact; overlong text is chunked across posts", async () => {
  const mm = fakeMM();
  const w = new OutputWriter({ mm, limit: 100 });
  await w.append("root", where, "```bash");
  assert.ok(!mm.posts[0].message.slice(8, -4).includes("```"));
  w.reset("root");
  await w.append("root", where, "x".repeat(250));
  assert.ok(mm.posts.length >= 4);
  for (const p of mm.posts) assert.ok(p.message.length <= 100);
});
