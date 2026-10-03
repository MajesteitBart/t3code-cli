import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "./errors.js";
import { createHandoverThread, inspectThread, readThread, sendThreadMessage, waitForThread } from "./service.js";
import { startFakeT3, type FakeT3 } from "./testing/fakeT3.js";
import { interruptThread } from "./threadControls.js";

const fakes: FakeT3[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function fakeT3(...args: Parameters<typeof startFakeT3>) {
  const fake = await startFakeT3(...args);
  fakes.push(fake);
  return fake;
}

describe("orchestrator V2 flow", () => {
  it("hands over, sends, reads, queues, interrupts, and waits", async () => {
    const fake = await fakeT3({ runBehavior: "hold" });
    fake.addProject();

    const handover = await createHandoverThread(fake.config, { prompt: "Start here", cwd: fake.root, threadEnvMode: "local" });
    expect(handover.thread.launch.workspaceStrategy).toEqual({ type: "root" });
    const threadId = handover.thread.id;
    const firstRun = fake.projection(threadId).runs[0]!;
    fake.completeRun(threadId, firstRun.id, "Done with the start");

    const sent = await sendThreadMessage(fake.config, { threadId, prompt: "Second task", ifBusy: "refuse" });
    expect(sent.message.delivery).toBe("start_immediately");
    expect(sent.verification.runStatus).toBe("running");

    await expect(sendThreadMessage(fake.config, { threadId, prompt: "Third" })).rejects.toMatchObject({ code: "THREAD_BUSY" });
    const queued = await sendThreadMessage(fake.config, { threadId, prompt: "Third", ifBusy: "queue" });
    expect(queued.message.delivery).toBe("queue_after_active");

    const inspected = await inspectThread(fake.config, threadId);
    expect(inspected.thread.queue).toHaveLength(1);
    expect(inspected.thread.activeRun?.status).toBe("running");

    const interrupted = await interruptThread(fake.config, threadId);
    expect(interrupted.runStatus).toBe("interrupted");
    // The queued run starts once the interrupt frees the thread; finish it so the wait can end.
    const next = fake.projection(threadId).runs.find((run) => run.status === "running")!;
    fake.completeRun(threadId, next.id, "Third answer");

    const waited = await waitForThread(fake.config, threadId, { timeoutMs: 10_000 });
    expect(waited.wait.outcome).toBe("completed");
    expect(waited.reply.messages.map((message) => message.text)).toContain("Third answer");

    const read = await readThread(fake.config, threadId, { detail: "answers" });
    expect(read.thread.turns.map((turn) => turn.state)).toEqual(["completed", "interrupted", "completed"]);
  });

  it("refuses an orchestrator V1 server before issuing a session", async () => {
    const fake = await fakeT3({ protocol: 1 });
    await expect(inspectThread(fake.config, "thread-1")).rejects.toSatisfy(
      (error: unknown) => error instanceof CliError && error.code === "T3_PROTOCOL_UNSUPPORTED",
    );
    expect(fake.httpRequests.some((request) => request.url.startsWith("/api/"))).toBe(false);
  });
});
