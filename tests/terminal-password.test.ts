import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { readHiddenPassword } from "../src/terminal-password";

function terminal() {
  const raw: boolean[] = [];
  const input = Object.assign(new PassThrough(), { setRawMode: (value: boolean) => { raw.push(value); return input; } });
  const output = new PassThrough();
  let visible = "";
  output.on("data", data => { visible += data.toString(); });
  return { input, output, raw, visible: () => visible };
}

test("hidden password input preserves Thai/emoji split across every UTF-8 byte without echo", async () => {
  const value = "กfixture-password🙂";
  const f = terminal();
  const result = readHiddenPassword(f.input, f.output);
  for (const byte of Buffer.from(value + "\n")) f.input.write(Buffer.from([byte]));
  expect(await result).toBe(value);
  expect(f.raw).toEqual([true, false]);
  expect(f.visible()).not.toContain(value);
  expect(f.input.listenerCount("data")).toBe(0);
});

test("terminal editing and cancellation restore raw mode without exposing the password", async () => {
  const f = terminal();
  const result = readHiddenPassword(f.input, f.output);
  f.input.write(Buffer.from("🙂\u007fcorrect-password\r"));
  expect(await result).toBe("correct-password");
  expect(f.raw).toEqual([true, false]);
  const cancelled = terminal();
  const rejection = readHiddenPassword(cancelled.input, cancelled.output);
  cancelled.input.write(Buffer.from("secret\u0003"));
  await expect(rejection).rejects.toThrow("Setup cancelled");
  expect(cancelled.raw).toEqual([true, false]);
  expect(cancelled.visible()).not.toContain("secret");
  const disconnected = terminal();
  const ended = readHiddenPassword(disconnected.input, disconnected.output);
  disconnected.input.end();
  await expect(ended).rejects.toThrow("Setup input ended");
  expect(disconnected.raw).toEqual([true, false]);
});
