import { afterEach, describe, expect, it } from "vitest";

import { deterministicSendIds, sendThreadMessage } from "./service.js";
import { startFakeT3, type FakeT3, type FakeT3Options } from "./testing/fakeT3.js";

const servers: FakeT3[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });
async function server(options: FakeT3Options = {}) {
  const fake = await startFakeT3(options);
  servers.push(fake);
  fake.addProject({ id: "project-1" });
  fake.addThread({ id: "target" });
  return fake;
}
const send = { threadId: "target", prompt: "Wake: code review changed\n", idempotencyKey: "evt_1234", ifBusy: "queue" as const };
const messages = (fake: FakeT3) => fake.commands.filter((command) => command.type === "message.dispatch");

describe("idempotent thread delivery", () => {
  it("binds stable UUID-shaped identifiers to the thread, key, and exact text", () => {
    const ids = deterministicSendIds("target", "event", "Wake\n");
    expect(ids).toEqual(deterministicSendIds("target", "event", "Wake\n"));
    expect(ids.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(ids.commandId).not.toBe(ids.messageId);
    for (const args of [["other", "event", "Wake\n"], ["target", "new", "Wake\n"], ["target", "event", "Wake"]] as const) {
      expect(deterministicSendIds(args[0], args[1], args[2])).not.toEqual(ids);
    }
  });

  it("delivers an exact message once and recovers it from the projection on retry", async () => {
    const fake = await server();
    const first = await sendThreadMessage(fake.config, send);
    const retry = await sendThreadMessage(fake.config, send);
    expect(messages(fake)).toHaveLength(1);
    expect(messages(fake)[0]?.text).toBe(send.prompt);
    expect(retry.message.messageId).toBe(first.message.messageId);
    expect(retry.idempotency?.deduplicated).toBe("projection");
    expect(retry.dispatch).toBeNull();
    expect(retry.verification.accepted).toBe(true);
  });

  it("recovers an accepted dispatch whose reply was lost without delivering it again", async () => {
    const fake = await server({ loseNextDispatchResponse: true });
    await expect(sendThreadMessage(fake.config, send)).rejects.toBeDefined();
    const retry = await sendThreadMessage(fake.config, send);
    expect(messages(fake)).toHaveLength(1);
    expect(retry.idempotency?.deduplicated).toBe("projection");
  });

  it("deduplicates a queued message while the preceding turn remains active", async () => {
    const fake = await server({ runBehavior: "hold", boundedTurnItems: 0 });
    fake.startRun("target", "Working");
    const first = await sendThreadMessage(fake.config, send);
    const retry = await sendThreadMessage(fake.config, send);
    expect(first.message.delivery).toBe("queue_after_active");
    expect(retry.verification.runStatus).toBe("queued");
    expect(messages(fake)).toHaveLength(1);
  });

  it("uses receipts to handle concurrent duplicate dispatches", async () => {
    const fake = await server({ runBehavior: "hold" });
    const results = await Promise.all([sendThreadMessage(fake.config, send), sendThreadMessage(fake.config, send)]);
    expect(messages(fake)).toHaveLength(1);
    expect(results[0]!.message.messageId).toBe(results[1]!.message.messageId);
    expect(fake.projection("target").runs).toHaveLength(1);
  });

  it("delivers changed text as a distinct message rather than replaying the wrong receipt", async () => {
    const fake = await server();
    const first = await sendThreadMessage(fake.config, send);
    const changed = await sendThreadMessage(fake.config, { ...send, prompt: "Different event text" });
    expect(messages(fake)).toHaveLength(2);
    expect(first.command.commandId).not.toBe(changed.command.commandId);
  });

  it("preserves permanently rejected keys", async () => {
    const fake = await server({ onCommand: () => "Policy rejects this send" });
    await expect(sendThreadMessage(fake.config, send)).rejects.toMatchObject({ code: "THREAD_COMMAND_REJECTED" });
    fake.options.onCommand = () => undefined;
    await expect(sendThreadMessage(fake.config, send)).rejects.toMatchObject({ code: "THREAD_COMMAND_REJECTED", message: expect.stringContaining("PreviouslyRejected") });
    expect(messages(fake)).toHaveLength(0);
  });

  it("verifies the already delivered message even after the thread becomes settled", async () => {
    const fake = await server();
    await sendThreadMessage(fake.config, send);
    fake.projection("target").thread.settledAt = new Date().toISOString();
    fake.projection("target").thread.settledOverride = "settled";
    expect((await sendThreadMessage(fake.config, send)).idempotency?.deduplicated).toBe("projection");
    expect(messages(fake)).toHaveLength(1);
  });

  it.each(["steer", "inject", "restart"] as const)("rejects %s and settings changes before connecting", async (ifBusy) => {
    const fake = await server();
    await expect(sendThreadMessage(fake.config, { ...send, ifBusy })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_UNSUPPORTED_OPTIONS", exitCode: 2 });
    await expect(sendThreadMessage(fake.config, { ...send, settings: { interactionMode: "plan" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_UNSUPPORTED_OPTIONS", exitCode: 2 });
    expect(fake.httpRequests).toHaveLength(0);
    expect(fake.commands).toHaveLength(0);
  });

  it.each(["", "with spaces", "a".repeat(201)])("rejects an invalid key before connecting", async (idempotencyKey) => {
    const fake = await server();
    await expect(sendThreadMessage(fake.config, { ...send, idempotencyKey })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_INVALID", exitCode: 2 });
    expect(fake.httpRequests).toHaveLength(0);
  });
});
