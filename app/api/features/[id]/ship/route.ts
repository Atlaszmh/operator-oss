import { NextResponse } from "next/server";
import { getFeature, getProject, featureUnfinishedTasks } from "@/lib/store";
import { shipFeature, summarizeSync } from "@/lib/featureSync";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

// Land the whole feature on the project branch as one unit. The unfinished-task
// check is advisory and reported in the response rather than enforced — the
// user may well know those tasks are abandoned, and a hard block would leave no
// way to ship without cancelling work they'd rather keep listed.
//
// STREAMS its progress as newline-delimited JSON rather than answering once at
// the end. Shipping is four slow steps — the feature gate runs the project's
// whole test command, then a merge, then every other live branch catches up,
// then a push — which on a real project is minutes with nothing on screen but a
// disabled button. Each step announces itself as it starts and again when it
// lands, so the wait is legible and a hang is attributable to a step.
//
// Consequence of streaming: the HTTP status is committed before the work runs,
// so the failures that used to be a 409 (a red gate, a conflicting merge) are
// now the `error` field of the FINAL line instead. Everything that can be known
// before the first byte — no feature, no repo, no branch — is still an ordinary
// non-2xx JSON response, so the client checks the status first and only then
// starts reading lines. See jstream() in app/orchestrator/api.ts.
type Line =
  | { type: "step"; key: string; label: string }
  | { type: "step_done"; key: string; ms: number }
  | { type: "result"; [k: string]: unknown };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(feature.project_id);
  if (!project?.repo_path) return NextResponse.json({ error: "this project has no working directory" }, { status: 400 });
  if (!feature.branch) return NextResponse.json({ error: "this feature has no integration branch" }, { status: 400 });

  const force = new URL(req.url).searchParams.get("force") === "1";
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: Line) => controller.enqueue(enc.encode(`${JSON.stringify(line)}\n`));
      /** Announce a step, run it, announce how long it took. */
      const step = async <T>(key: string, label: string, fn: () => Promise<T>): Promise<T> => {
        send({ type: "step", key, label });
        const t0 = Date.now();
        const out = await fn();
        send({ type: "step_done", key, ms: Date.now() - t0 });
        return out;
      };

      try {
        // Every step of the landing lives in shipFeature() — autopilot runs the
        // identical sequence when it finishes a plan unattended, and two copies
        // would drift. This route owns only what is HTTP: the progress stream,
        // and the sentences a human reads at the end.
        const unfinished = featureUnfinishedTasks(feature.id);
        const res = await shipFeature(project, feature, { force, step });

        if (!res.ok) {
          send({
            type: "result",
            error: res.conflicts?.length
              ? `${feature.branch} conflicts with ${project.branch} in ${res.conflicts.length} file(s). Sync the feature first, or resolve them in your own checkout.`
              : res.error,
            conflicts: res.conflicts ?? [],
            ...(res.gateFailed ? { gateFailed: true, inconclusive: !!res.gateInconclusive } : {}),
          });
          return;
        }

        const { synced, chained, published } = { synced: res.synced, chained: res.chained, published: { pushed: res.pushed, note: res.pushNote } };
        const syncNote = summarizeSync(synced);
        // One announced line per kicked-off dependent, so the chain is visible
        // in the ship log rather than only in the final sentence.
        for (const k of chained) {
          send({ type: "step", key: `chain-${k.featureId}`, label: k.ok ? `Kicked off ${k.name}` : `Couldn't kick off ${k.name}: ${k.error}` });
          send({ type: "step_done", key: `chain-${k.featureId}`, ms: 0 });
        }

        const tail = unfinished.length
          ? ` ${unfinished.length} task${unfinished.length === 1 ? " is" : "s are"} still unfinished, so only work already merged into ${feature.branch} landed.`
          : "";
        const chainNote = chained.filter((k) => k.ok).length
          ? ` Kicked off ${chained.filter((k) => k.ok).map((k) => k.name).join(", ")}.`
          : "";
        send({
          type: "result",
          ok: true,
          alreadyMerged: !!res.alreadyMerged,
          synced,
          chained,
          pushed: published.pushed,
          text: res.alreadyMerged
            ? `${feature.branch} was already merged into ${res.targetBranch}.`
            : `Shipped ${feature.name}: merged ${feature.branch} into ${res.targetBranch}.${tail}` +
              `${syncNote ? ` ${syncNote}` : ""}${published.note ? ` ${published.note}` : ""}${chainNote}`,
        });
      } catch (e) {
        // A throw past this point has already committed a 200, so the only way
        // to report it is as the final line. Without this the stream would just
        // end and the client would see a ship that neither failed nor finished.
        send({ type: "result", error: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      // `no-transform` is the load-bearing half: a proxy that buffers to
      // compress would hold every line until the ship finished, which is
      // precisely the silence this route exists to end.
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
