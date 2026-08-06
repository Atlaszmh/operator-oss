// Tiny fetch helpers used throughout the orchestrator client.

// Routes report failures as JSON `{ error }` — unwrap that so surfaced messages
// read "worktree is dirty", not a raw JSON blob (transcript system errors, modal
// error notes and ErrNote all show this string verbatim).
/** Thrown by jget/jsend on a non-2xx — the message is the server's own `error`
 *  string, and `status` lets a caller react to a SPECIFIC refusal (e.g. the
 *  archive strand guard's 409) instead of treating every failure alike. */
export class ApiError extends Error {
  constructor(msg: string, public readonly status: number) {
    super(msg);
  }
}

async function fail(r: Response): Promise<never> {
  const raw = await r.text();
  let msg = raw || `${r.status} ${r.statusText}`;
  try {
    const j = JSON.parse(raw);
    if (typeof j?.error === "string" && j.error) msg = j.error;
  } catch { /* not JSON — keep the raw body */ }
  throw new ApiError(msg, r.status);
}

export async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) await fail(r);
  return r.json();
}
export async function jsend<T>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) await fail(r);
  return r.json();
}

/**
 * POST to a route that reports progress as newline-delimited JSON, calling
 * `onLine` for each object as it arrives and resolving to the LAST one.
 *
 * For the long multi-step routes where a single awaited response means minutes
 * of silence (POST /api/features/:id/ship). Failures the route can detect before
 * it starts working still arrive as an ordinary non-2xx and throw like jsend's;
 * anything that goes wrong once the status is committed comes back as a field of
 * the final line, which is the caller's to interpret.
 */
export async function jstream<T>(url: string, onLine: (line: unknown) => void): Promise<T> {
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) await fail(r);
  if (!r.body) throw new ApiError("the server sent no response body", r.status);

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let last: unknown = null;
  const take = (chunk: string) => {
    const line = chunk.trim();
    if (!line) return;
    const obj = JSON.parse(line);
    onLine(obj);
    last = obj;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // Everything up to the last newline is complete; the remainder is a partial
    // line waiting on the next chunk.
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const p of parts) take(p);
  }
  take(buf + dec.decode());
  return last as T;
}
