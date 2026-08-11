import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { MessageConnection } from "vscode-jsonrpc";
import {
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  TextDocumentSyncKind,
  type TextDocumentSyncOptions,
} from "vscode-languageserver-protocol";
import type { ResolvedLanguageServerDefinition } from "../language-server-config.js";
import { wholeDocumentRange } from "../position-encoding.js";

export interface OpenDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  openNotified: boolean;
}

export class DocumentSynchronizer {
  private readonly documents = new Map<string, OpenDocument>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly definition: ResolvedLanguageServerDefinition) {}

  get(uri: string): OpenDocument | undefined {
    return this.documents.get(uri);
  }

  async sync(
    sourcePath: string,
    connection: MessageConnection,
    synchronizationValue: TextDocumentSyncOptions | TextDocumentSyncKind | undefined,
    positionEncoding: string,
  ): Promise<OpenDocument> {
    const operation = this.queue.then(
      () => this.syncNow(sourcePath, connection, synchronizationValue, positionEncoding),
      () => this.syncNow(sourcePath, connection, synchronizationValue, positionEncoding),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async closeAll(connection: MessageConnection): Promise<void> {
    await this.queue;
    for (const document of this.documents.values()) {
      if (!document.openNotified) continue;
      try {
        await connection.sendNotification(DidCloseTextDocumentNotification.type, {
          textDocument: { uri: document.uri },
        });
      } catch {
        // The server may already be gone.
      }
    }
  }

  clear(): void {
    this.documents.clear();
    this.queue = Promise.resolve();
  }

  private async syncNow(
    sourcePath: string,
    connection: MessageConnection,
    synchronizationValue: TextDocumentSyncOptions | TextDocumentSyncKind | undefined,
    positionEncoding: string,
  ): Promise<OpenDocument> {
    const uri = pathToFileURL(sourcePath).href;
    const text = await readFile(sourcePath, "utf8");
    const existing = this.documents.get(uri);
    const languageId = languageIdForPath(this.definition, sourcePath);
    const synchronization = textDocumentSynchronization(synchronizationValue);
    if (!existing) {
      const document: OpenDocument = { uri, languageId, version: 1, text, openNotified: false };
      this.documents.set(uri, document);
      if (synchronization.openClose) {
        await connection.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: {
            uri: document.uri,
            languageId: document.languageId,
            version: document.version,
            text: document.text,
          },
        });
        document.openNotified = true;
      }
      return document;
    }
    if (existing.text !== text) {
      const previousText = existing.text;
      existing.version += 1;
      existing.text = text;
      if (synchronization.change === TextDocumentSyncKind.Full) {
        await connection.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version: existing.version },
          contentChanges: [{ text }],
        });
      } else if (synchronization.change === TextDocumentSyncKind.Incremental) {
        await connection.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version: existing.version },
          contentChanges: [{
            range: wholeDocumentRange(previousText, positionEncoding),
            text,
          }],
        });
      }
    }
    return existing;
  }
}

function languageIdForPath(definition: ResolvedLanguageServerDefinition, path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return definition.languageIdByExtension[extension] ?? definition.languages[0]!;
}

function textDocumentSynchronization(
  value: TextDocumentSyncOptions | TextDocumentSyncKind | undefined,
): { openClose: boolean; change: TextDocumentSyncKind } {
  if (typeof value === "number") {
    return {
      openClose: value !== TextDocumentSyncKind.None,
      change: value,
    };
  }
  return {
    openClose: value?.openClose === true,
    change: value?.change ?? TextDocumentSyncKind.None,
  };
}
