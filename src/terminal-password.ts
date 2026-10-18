import { StringDecoder } from "node:string_decoder";

/** Minimal terminal operations used by the hidden local setup prompt. */
export interface PasswordTerminal {
  setRawMode(value: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "error", listener: () => void): unknown;
  off(event: "data", listener: (chunk: Buffer) => void): unknown;
  off(event: "end" | "error", listener: () => void): unknown;
}

/** Reads one hidden terminal password while preserving UTF-8 across input chunks and restoring terminal state. */
export async function readHiddenPassword(
  input: PasswordTerminal = process.stdin,
  output: { write(value: string): unknown } = process.stdout,
): Promise<string> {
  output.write("Owner password (12–256 characters; input hidden): ");
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const decoder = new StringDecoder("utf8");
      const finish = () => { input.off("data", onData); input.off("end", onEnd); input.off("error", onError); };
      const onEnd = () => { finish(); reject(new Error("Setup input ended")); };
      const onError = () => { finish(); reject(new Error("Setup input failed")); };
      const onData = (chunk: Buffer) => {
        for (const char of decoder.write(chunk)) {
          if (char === "\u0003" || char === "\u0004") { finish(); reject(new Error("Setup cancelled")); return; }
          if (char === "\r" || char === "\n") { finish(); resolve(value); return; }
          if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
          else value += char;
          if (value.length > 256) { finish(); reject(new Error("Password input is too long")); return; }
        }
      };
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("error", onError);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
    output.write("\n");
  }
}
