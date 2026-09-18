import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

const { withHttpResponse, readResponseText } = await import(pathToFileURL(process.argv[2]));
const framing = process.argv[3];
const body = Buffer.alloc(64 * 1024, 97);
const truncated = framing.startsWith("truncated");
let wireBody = body;
let headers = "";
if (framing.includes("chunked")) {
  headers = "Transfer-Encoding: chunked\r\n";
  wireBody = Buffer.concat([Buffer.from(`${body.length.toString(16)}\r\n`), body,
    Buffer.from(truncated ? "\r\n" : "\r\n0\r\n\r\n")]);
} else if (framing !== "eof") {
  headers = `Content-Length: ${body.length + (truncated ? 1 : 0)}\r\n`;
}
const server = createServer(socket => {
  socket.once("data", () => {
    socket.write(`HTTP/1.1 200 OK\r\n${headers}Connection: close\r\n\r\n`);
    socket.end(wireBody);
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let backpressured = false;
try {
  const result = await withHttpResponse(new URL(`http://127.0.0.1:${server.address().port}`),
    { signal: AbortSignal.timeout(3000) }, undefined, async response => {
      // Observe buffering without consuming: a 'data' listener would defeat this test.
      response.on("readable", () => {
        backpressured ||= response.readableLength >= response.readableHighWaterMark;
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      return await readResponseText(response);
    });
  assert.equal(truncated, false, "truncated body must reject");
  assert.equal(result, body.toString());
} catch (error) {
  if (!truncated) throw error;
  assert.match(error.code, /ECONNRESET|ERR_STREAM_PREMATURE_CLOSE/);
} finally {
  server.close();
  await once(server, "close");
}
assert.equal(backpressured, true, "fixture must apply response backpressure");
console.log(JSON.stringify({ framing, backpressured, truncated }));
