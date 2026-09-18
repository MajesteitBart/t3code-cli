import { createServer } from "node:net";
import { once } from "node:events";
import { expect, test } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { readResponseText, withHttpResponse } from "./http.js";
import { T3Api } from "./api.js";

test.each(["headers", "body"])("timeout closes the socket while waiting for %s", async (phase) => {
  const server = createHttpServer((_req, res) => {
    if (phase === "body") {
      res.writeHead(200, { "Content-Length": "100" });
      res.write("{");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const closed = once(server, "connection").then(([socket]) => once(socket, "close"));
  try {
    await expect(withHttpResponse(new URL(`http://127.0.0.1:${address.port}`), {
      signal: AbortSignal.timeout(100),
    }, undefined, readResponseText)).rejects.toMatchObject({ code: "ABORT_ERR" });
    await closed;
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("POST keeps bearer authentication, JSON payload, and response decoding", async () => {
  let received: unknown;
  const server = createHttpServer(async (req, res) => {
    received = {
      method: req.method,
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      body: JSON.parse(await readResponseText(req)),
    };
    res.end(JSON.stringify({ accepted: "é😀" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  try {
    const api = new T3Api({ origin: `http://127.0.0.1:${address.port}`,
      environmentId: "test", serverVersion: "test", stateDir: null,
      runtimeStatePath: null, settingsPath: null,
    }, "fixture-token");
    expect(await api.dispatch({ text: "é😀" })).toEqual({ accepted: "é😀" });
    expect(received).toEqual({ method: "POST", authorization: "Bearer fixture-token",
      contentType: "application/json", body: { text: "é😀" } });
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("truncated response bodies become T3_REQUEST_FAILED", async () => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{}"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const api = new T3Api({
    origin: `http://127.0.0.1:${address.port}`,
    environmentId: "test", serverVersion: "test", stateDir: null,
    runtimeStatePath: null, settingsPath: null,
  }, "fixture-token");
  try {
    await expect(api.request("GET", "/snapshot")).rejects.toMatchObject({ code: "T3_REQUEST_FAILED" });
  } finally {
    server.close();
    await once(server, "close");
  }
});
