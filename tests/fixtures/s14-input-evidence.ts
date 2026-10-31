import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BoxStream } from "../../src/exec/box-runtime";
import { BotPodmanRuntime } from "../../src/s14/computer-podman";
import type { CommandRunner } from "../../src/exec/podman-runtime";
import { InputEvidenceTransport } from "../../ops/box/input-evidence-transport";

export const cdpFrame = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\0`);
/** Protocol fixture only: its replies never certify Chromium, Podman, a kernel or physical input. */
export function inputEvidencePipe(autoReply = false) {
  const writes: Uint8Array[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const exit = Promise.withResolvers<number>();
  const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const stream: BoxStream = {
    write(bytes) {
      if (closed) throw new Error("fixture_closed");
      writes.push(bytes);
      if (autoReply) {
        const command = JSON.parse(new TextDecoder().decode(bytes.subarray(0, -1)));
        const result = command.method === "Target.getTargets" ? { targetInfos: [{ targetId: "fixture-page", type: "page" }] }
          : command.method === "Target.attachToTarget" ? { sessionId: "fixture-session" } : {};
        controller.enqueue(cdpFrame({ id: command.id, result }));
      }
    },
    stdout, exited: exit.promise,
    close() { if (!closed) { closed = true; try { controller.close(); } catch { /* Reader cancellation already closed it. */ } exit.resolve(-1); } },
  };
  return { stream, writes, emit(bytes: Uint8Array) { controller.enqueue(bytes); }, get closed() { return closed; } };
}

/** Scripted host probes around the real BotPodmanRuntime input path; no host command is executed. */
export function inputEvidenceRuntime(root: string, transport: InputEvidenceTransport) {
  const image = `localhost/fixture@sha256:${"a".repeat(64)}`;
  const infos = new Map<string, any>();
  const pipes: ReturnType<typeof inputEvidencePipe>[] = [];
  const runnerOps: string[] = [];
  let stopFailure = false;
  const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  const ok = (value: unknown = "") => ({ exitCode: 0, stdout: bytes(value), stderr: new Uint8Array() });
  for (const role of ["workspace", "profile"]) mkdirSync(join(root, "slots/slot-0001", role), { recursive: true, mode: 0o700 });
  const actual: CommandRunner = async (argv, request) => {
    if (argv[0] === "--version") return ok("fixture-podman");
    if (argv[0] === "info") return ok({ host: { os: "linux", security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"], idMappings: { uidmap: [{ size: 65536 }], gidmap: [{ size: 65536 }] } } });
    if (argv[0] === "network" && argv[1] === "exists") return { ...ok(), exitCode: 1 };
    if (argv[0] === "rm") {
      if (stopFailure && /-(workspace|browser)$/.test(argv.at(-1)!)) return { ...ok(), exitCode: 1 };
      infos.delete(argv.at(-1)!); return ok();
    }
    if (argv[0] === "run") {
      const get = (flag: string) => argv[argv.indexOf(flag) + 1]!;
      const mount = get("--mount").split(","), source = mount.find(x => x.startsWith("src="))!.slice(4), destination = mount.find(x => x.startsWith("dst="))!.slice(4);
      const labels = Object.fromEntries(argv.flatMap((part, i) => part === "--label" ? [argv[i + 1]!.split("=")] : []));
      infos.set(get("--name"), { State: { Running: true }, ImageName: image,
        Config: { User: "1000:1000", Hostname: get("--name"), Labels: labels },
        Mounts: [{ Type: "bind", Source: source, Destination: destination }],
        HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: "none", PidMode: "private", IpcMode: "private", UTSMode: "private", CgroupnsMode: "private", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"],
          Tmpfs: { "/tmp": "nosuid,nodev,noexec,size=67108864", "/run": "nosuid,nodev,noexec,size=134217728" } } });
      return ok();
    }
    if (argv[0] === "inspect") return ok([infos.get(argv[1]!)]);
    if (argv.includes("/sys/fs/cgroup/cpu.max")) return ok("50000 100000\n536870912\n128\n0\n");
    if (argv.at(-1) === "/opt/jit/runner") {
      const op = JSON.parse(new TextDecoder().decode(request.stdin)).op;
      runnerOps.push(op);
      return ok({ v: 1, ok: true, result: { stdout: Buffer.from("fixture-returned-output").toString("base64"), stderr: "", exitCode: 0, timedOut: false } });
    }
    throw new Error(`unexpected fixture operation: ${argv[0]}`);
  };
  class ScriptedKernelRuntime extends BotPodmanRuntime {
    override diskSlots() { return ["slot-0001"]; }
    protected override async hostProbe(argv: string[], allowed: () => void): Promise<string> {
      allowed();
      if (argv[0] === "stat") return "4096 262144";
      if (argv[0] === "findmnt") return JSON.stringify({ filesystems: ["workspace", "profile"].map((role, i) => ({ target: join(root, "slots/slot-0001", role), source: `/dev/fixture${i}`, fstype: "ext4", options: "nodev,nosuid", "maj:min": `7:${i}`, fsroot: "/" })) });
      throw new Error("unexpected fixture host probe");
    }
  }
  const runtime = new ScriptedKernelRuntime({ dataRoot: root, protectedPaths: [join(root, "..", "protected")], workspaceImage: image, browserImage: image,
    run: transport.commands(actual), streams: transport.streams(() => { const pipe = inputEvidencePipe(true); pipes.push(pipe); return pipe.stream; }) });
  return { runtime, infos, pipes, runnerOps, failStop(value: boolean) { stopFailure = value; } };
}
