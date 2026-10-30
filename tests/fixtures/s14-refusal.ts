import { runS14 } from "../../src/s14/main";

// A browser-server stand-in proves default composition without opening a port or writable store.
Bun.serve = ((options: { fetch(request: Request): Response }) => {
  const response = options.fetch(new Request("http://localhost:3001/"));
  void response.text().then(body => console.log(JSON.stringify({ status: response.status, body })));
  return { stop() {} };
}) as typeof Bun.serve;
await runS14(["serve", "--s14"]);
