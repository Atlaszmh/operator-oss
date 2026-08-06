import { NextResponse } from "next/server";
import { getFeature, getProject, updateFeature, featureUnfinishedTasks } from "@/lib/store";
import { mergeFeature } from "@/lib/git";
import { syncFeaturesToBase, summarizeSync, publishProjectBranch } from "@/lib/featureSync";
import { runFeatureGate, featureGateFailure } from "@/lib/gates";
import { resolveFeatures } from "@/lib/features";

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
        // Prove the ASSEMBLED branch runs before it touches the project branch.
        // Until this existed the only check here was git's, which reports
        // overlapping edits and nothing else — so a feature whose members were
        // each individually green could merge cleanly and still be broken.
        // `?force=1` is the deliberate override for a user who has looked and
        // disagrees.
        if (!force) {
          const gate = await step("gate", `Checking ${feature.branch} runs${project.test_command ? ` (${project.test_command})` : ""}`, () =>
            runFeatureGate(project, feature)
          );
          if (!gate.ok) {
            send({
              type: "result",
              error: featureGateFailure(feature, project, gate),
              gateFailed: true,
              inconclusive: !!gate.inconclusive,
            });
            return;
          }
        }

        const unfinished = featureUnfinishedTasks(feature.id);
        const res = await step("merge", `Merging into ${project.branch}`, () =>
          mergeFeature({
            repoPath: project.repo_path,
            featureBranch: feature.branch,
            baseBranch: project.branch,
            message: `Merge feature ${feature.name} (${feature.branch}) into ${project.branch}`,
          })
        );

        if (!res.ok) {
          send({
            type: "result",
            error: res.conflicts?.length
              ? `${feature.branch} conflicts with ${project.branch} in ${res.conflicts.length} file(s). Sync the feature first, or resolve them in your own checkout.`
              : res.error,
            conflicts: res.conflicts ?? [],
          });
          return;
        }

        // Only stamp merged_at when commits actually landed — a re-ship of an
        // already-merged branch shouldn't reset the date it originally shipped.
        //
        // Shipping is also the moment the feature leaves the working set, so it
        // archives itself in the same write: the Archived section is where it
        // stays reachable (and restorable) instead of sitting at the top of the
        // task list forever. Guarded by alreadyMerged for the same reason
        // merged_at is — re-shipping must not un-do a deliberate Restore.
        if (!res.alreadyMerged) updateFeature(feature.id, { merged_at: Date.now(), archived: 1 });

        // The project branch just moved, so every other live feature is now
        // behind by exactly this feature. Catch them up HERE, at the landing,
        // while the conflict (if any) is one feature wide and the sessions that
        // caused it are still warm. Left until each feature's own ship, this is
        // the divergence that turns a one-line reconciliation into a multi-week
        // merge. Never fails the ship: the merge already succeeded, and another
        // feature's branch is not this one's problem to report as an error.
        const synced = res.alreadyMerged
          ? []
          : await step("sync", "Catching up the other feature branches", () =>
              syncFeaturesToBase(project, { except: feature.id })
            );
        const syncNote = summarizeSync(synced);

        // Publish what landed, when the instance is configured to (off by
        // default). After the local catch-ups: a push that hangs must not delay
        // reconciling the branches this merge just moved underneath. The step is
        // only announced when pushing is actually on — a tick against work that
        // never ran is worse than no line at all.
        const published =
          res.alreadyMerged || !resolveFeatures().pushOnShip
            ? { pushed: false, note: "" }
            : await step("push", `Pushing ${project.branch} to origin`, () => publishProjectBranch(project));

        const tail = unfinished.length
          ? ` ${unfinished.length} task${unfinished.length === 1 ? " is" : "s are"} still unfinished, so only work already merged into ${feature.branch} landed.`
          : "";
        send({
          type: "result",
          ok: true,
          alreadyMerged: !!res.alreadyMerged,
          synced,
          pushed: published.pushed,
          text: res.alreadyMerged
            ? `${feature.branch} was already merged into ${res.targetBranch}.`
            : `Shipped ${feature.name}: merged ${feature.branch} into ${res.targetBranch}.${tail}` +
              `${syncNote ? ` ${syncNote}` : ""}${published.note ? ` ${published.note}` : ""}`,
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
