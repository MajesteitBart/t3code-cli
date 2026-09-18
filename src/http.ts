import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";

// Use Node's HTTP parser rather than bundled fetch/Undici: some supported Node
// versions crash outside the fetch promise when a paused response socket ends.
export async function withHttpResponse<T>(
  url: URL,
  options: RequestOptions,
  body: string | undefined,
  consume: (response: IncomingMessage) => Promise<T>,
): Promise<T> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("T3 requests require HTTP or HTTPS.");
  }
  return await new Promise<T>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { ...options, agent: false },
      (response) => {
        // Listen before calling the consumer, including while it is paused.
        response.on("error", reject);
        void (async () => {
          try {
            resolve(await consume(response));
          } catch (error) {
            reject(error);
          } finally {
            response.destroy();
            request.destroy();
          }
        })();
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

export async function readResponseText(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
