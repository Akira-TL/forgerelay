import { appendFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

let buffer = Buffer.alloc(0);
let rootPath = process.cwd();
const logPath = process.env.FORGERELAY_FAKE_LSP_LOG;
const mode = process.env.FORGERELAY_FAKE_LSP_MODE ?? "location";
const targetPath = process.env.FORGERELAY_FAKE_LSP_TARGET;

function log(event) {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function handle(message) {
  log({ method: message.method, id: message.id ?? null, params: message.params ?? null });

  if (message.method === "initialize") {
    if (typeof message.params?.rootUri === "string") {
      rootPath = fileURLToPath(message.params.rootUri);
    }
    if (mode === "never-initialize") return;
    respond(message.id, {
      capabilities: {
        definitionProvider: mode !== "unsupported-definition",
        positionEncoding: "utf-16",
        textDocumentSync: 1,
      },
      serverInfo: { name: "forgerelay-fake-lsp", version: "1.0.0" },
    });
    return;
  }

  if (message.method === "textDocument/definition") {
    const target = targetPath ?? join(rootPath, "src", "target.ts");
    if (mode === "location-link") {
      respond(message.id, [{
        originSelectionRange: {
          start: { line: 0, character: 14 },
          end: { line: 0, character: 20 },
        },
        targetUri: pathToFileURL(target).href,
        targetRange: {
          start: { line: 0, character: 7 },
          end: { line: 0, character: 13 },
        },
        targetSelectionRange: {
          start: { line: 0, character: 7 },
          end: { line: 0, character: 13 },
        },
      }]);
      return;
    }
    respond(message.id, {
      uri: pathToFileURL(target).href,
      range: {
        start: { line: 0, character: 7 },
        end: { line: 0, character: 13 },
      },
    });
    return;
  }

  if (message.method === "shutdown") {
    respond(message.id, null);
    return;
  }

  if (message.method === "exit") {
    process.exit(0);
  }
}

function pump() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const headers = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /^Content-Length:\s*(\d+)$/im.exec(headers);
    if (!match) throw new Error("Missing Content-Length header");
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});
