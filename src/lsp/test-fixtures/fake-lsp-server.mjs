import { appendFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

let buffer = Buffer.alloc(0);
let rootPath = process.cwd();
const logPath = process.env.FORGERELAY_FAKE_LSP_LOG;
const mode = process.env.FORGERELAY_FAKE_LSP_MODE ?? "location";
const targetPath = process.env.FORGERELAY_FAKE_LSP_TARGET;
const syncKind = Number(process.env.FORGERELAY_FAKE_LSP_SYNC_KIND ?? "1");
const definitionDelayMs = Number(process.env.FORGERELAY_FAKE_LSP_DEFINITION_DELAY_MS ?? "0");
const hoverMode = process.env.FORGERELAY_FAKE_LSP_HOVER_MODE ?? "markdown";

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
  log({
    method: message.method ?? null,
    id: message.id ?? null,
    params: message.params ?? null,
    result: message.result ?? null,
    error: message.error ?? null,
  });

  if (message.method === "initialize") {
    if (typeof message.params?.rootUri === "string") {
      rootPath = fileURLToPath(message.params.rootUri);
    }
    if (mode === "never-initialize") return;
    respond(message.id, {
      capabilities: {
        definitionProvider: mode !== "unsupported-definition",
        hoverProvider: hoverMode !== "unsupported",
        positionEncoding: "utf-16",
        textDocumentSync: syncKind,
      },
      serverInfo: { name: "forgerelay-fake-lsp", version: "1.0.0" },
    });
    return;
  }

  if (message.method === "initialized" && mode === "request-apply-edit") {
    send({
      jsonrpc: "2.0",
      id: 700,
      method: "workspace/applyEdit",
      params: {
        label: "forbidden fake edit",
        edit: {
          changes: {
            [pathToFileURL(join(rootPath, "src", "main.ts")).href]: [{
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
              newText: "MUTATED_BY_SERVER\n",
            }],
          },
        },
      },
    });
    return;
  }

  if (message.method === "textDocument/hover") {
    const range = {
      start: { line: 0, character: 14 },
      end: { line: 0, character: 20 },
    };
    if (hoverMode === "plaintext") {
      respond(message.id, { contents: { kind: "plaintext", value: "target: () => void" }, range });
      return;
    }
    if (hoverMode === "legacy-string") {
      respond(message.id, { contents: "legacy hover", range });
      return;
    }
    if (hoverMode === "legacy-marked") {
      respond(message.id, { contents: { language: "typescript", value: "const target: () => void" }, range });
      return;
    }
    if (hoverMode === "legacy-array") {
      respond(message.id, {
        contents: ["Target signature:", { language: "typescript", value: "const target: () => void" }],
        range,
      });
      return;
    }
    respond(message.id, { contents: { kind: "markdown", value: "**target**: `() => void`" }, range });
    return;
  }

  if (message.method === "textDocument/definition") {
    const target = targetPath ?? join(rootPath, "src", "target.ts");
    const sendDefinition = () => {
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
    };
    if (definitionDelayMs > 0) setTimeout(sendDefinition, definitionDelayMs);
    else sendDefinition();
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
