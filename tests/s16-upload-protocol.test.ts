import { expect, test } from "bun:test";
import { JitClient } from "../src/s16/client";

function upload() {
  return { contract: "s16-file-upload/v1", id: "file_fixture", requestId: "upload", conversationId: "conversation", name: "image.png", expectedBytes: 10, expectedHash: "a".repeat(64), bytes: 10, state: "ready", code: null, createdAt: 1000, expiresAt: 2000, retained: true,
    receipt: { contract: "s16-file-receipt/v2", id: "file_fixture", conversationId: "conversation", name: "image.png", mime: "image/png", bytes: 10, sha256: "a".repeat(64), expiresAt: null, validation: "s16-isolated-file/v1", parserGeneration: "fixture-v3", representation: { mime: "image/png", bytes: 5, sha256: "b".repeat(64), pages: null, width: 1, height: 1, originalWidth: 1, originalHeight: 1 } } };
}
const client = (data: unknown) => new JitClient({ origin: "https://jit.invalid", fetch: async () => Response.json(data) });

test.each(["image", "pdf"])("complete typed binary receipts remain accepted: %s", async kind => {
  const data: any = upload(); if (kind === "pdf") { data.receipt.mime = "application/pdf"; Object.assign(data.receipt.representation, { mime: "text/plain", pages: 1, width: null, height: null, originalWidth: null, originalHeight: null }); }
  expect((await client(data).uploadStatus(data.id)).receipt).toEqual(data.receipt);
});

test.each(["missing", "null", "bytes", "hash", "mime", "pages", "width", "originalHeight", "generation", "validation"])("malformed binary representation is refused before rendering: %s", async field => {
  const data: any = upload();
  if (field === "missing") delete data.receipt.representation;
  else if (field === "null") data.receipt.representation = null;
  else if (field === "generation") data.receipt.parserGeneration = 3;
  else if (field === "validation") data.receipt.validation = "unknown";
  else data.receipt.representation[field === "hash" ? "sha256" : field] = field === "originalHeight" ? null : "invalid";
  await expect(client(data).uploadStatus(data.id)).rejects.toMatchObject({ code: "client_protocol_invalid", outcome: "response" });
});
