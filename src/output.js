import { POST_LIMIT, chunks, fenced, canAppend, sanitize } from "./chunk.js";

// Relay output lands in as few posts as possible: append to the thread's
// current output post by editing it, start a new one when it is full.
export class OutputWriter {
  constructor({ mm, limit = POST_LIMIT }) {
    this.mm = mm;
    this.limit = limit;
    this.current = new Map(); // threadKey -> { postId, body }
  }

  async append(threadKey, { channelId, rootId }, text) {
    const clean = sanitize(text.replace(/\r/g, ""));
    if (!clean.trim()) return;
    const cur = this.current.get(threadKey);
    if (cur && canAppend(cur.body, clean, this.limit)) {
      try {
        await this.mm.editPost(cur.postId, fenced(`${cur.body}\n${clean}`));
        cur.body = `${cur.body}\n${clean}`;
        return;
      } catch (err) {
        // The post is gone or the edit was refused: never retry it, start fresh.
        this.current.delete(threadKey);
      }
    }
    const parts = chunks(clean, this.limit);
    let last = null;
    for (const part of parts) {
      last = { postId: (await this.mm.createPost({ channelId, rootId, message: fenced(part) })).id, body: part };
    }
    this.current.set(threadKey, last);
  }

  reset(threadKey) { this.current.delete(threadKey); }
  drop(threadKey) { this.current.delete(threadKey); }
}
