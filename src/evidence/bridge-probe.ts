import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  checkAuthReadiness,
  createHost,
  type HostAuthFetch,
  type HostCredentialReference,
  type HostCredentialStore,
  type HostRunOptions,
  type HostRuntime,
  type HostSession,
} from "schway/host";
import type { ProbeEvent, ProbePorts } from "./probe";
import { isCleanupUncertain, PROBE_PROMPT } from "./probe";

/** Pinned service-context probe over the supported Schway host contract. */
export const BRIDGE_PROBE_CONTRACT = "schway.host.release/v1" as const;
/** Fixed non-sensitive probe prompt; names no project, credential, path or person. */
export const BRIDGE_PROBE_PROMPT = PROBE_PROMPT;
/** Single-turn, single-attempt probe dispatch: the outer live loop bounds total attempts. */
export const BRIDGE_PROBE_MAX_TURNS = 1;
export const BRIDGE_PROBE_MAX_ATTEMPTS = 1;

/** Exact selected route/model for one probe identity; store/fetch are fixture seams (absent in production). */
export interface BridgeProbeOptions {
  route: "grok" | "codex";
  model: string;
  /** Installation root owning `.local/host-probe-host/` service directories. */
  root: string;
  /** Fixture credential store; absent selects Schway's default native store (production). */
  store?: HostCredentialStore;
  /** Fixture protocol transport; absent uses real native transport. Never used silently. */
  fetch?: HostAuthFetch;
}

function serviceUid(): number | null {
  try {
    const getuid = (process as unknown as { getuid?: () => number }).getuid;
    return typeof getuid === "function" ? getuid() : null;
  } catch { return null; }
}

function ensureServiceDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  const uid = serviceUid();
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 || (uid !== null && stats.uid !== uid)) {
    throw new Error("unsafe_probe_host_directory");
  }
}

/** Service-owned probe host directories beside the probe records; never a developer checkout or home. */
export function probeHostDirs(root: string): { base: string; workspaceRoot: string; homeDirectory: string; sessionDirectory: string } {
  // Canonicalize through the installation root first: a symlinked `.local`
  // ancestor would otherwise redirect every child outside the installation.
  const canonRoot = realpathSync(root);
  const local = resolve(canonRoot, ".local");
  ensureServiceDir(local);
  if (realpathSync(local) !== local) throw new Error("unsafe_probe_host_directory");
  const base = join(local, "host-probe-host");
  return { base, workspaceRoot: join(base, "workspace"), homeDirectory: join(base, "home"), sessionDirectory: join(base, "sessions") };
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Structural provider-send bound per admitted attempt on the pinned release.
 * The Grok adapter performs at most one transparent 401 refresh plus one
 * inference replay (no loop); the Codex adapter performs no silent inference
 * replay. One admitted attempt therefore issues at most two inference sends
 * plus two token sends. The counting transport below reports exact
 * counts and fails the attempt closed when the bound is ever exceeded, so a
 * future pin change cannot silently widen the budget. Exact per-request
 * accounting beyond this bound awaits schway#415.
 */
export const BRIDGE_MAX_INFERENCE_SENDS = 2;
export const BRIDGE_MAX_TOKEN_SENDS = 2;

/** Exact provider-send counts observed on one bounded infer call. */
export interface BridgeProviderSends { inference: number; token: number }

/**
 * Builds scriptable live-boundary ports over the concrete Schway bridge.
 * `readCredential` performs a local readiness read only; `infer` runs one
 * bounded route-bound request with the fixed prompt, empty tools and strict
 * context. Every provider send is counted through the transport wrapper;
 * `takeProviderSends` reports the last call's exact counts. No outer retry,
 * fallback route, billing change or secret read.
 */
export function bridgeProbePorts(options: BridgeProbeOptions): ProbePorts {
  if (options.route !== "grok" && options.route !== "codex") throw new Error("invalid_probe_options");
  if (!MODEL_PATTERN.test(options.model)) throw new Error("invalid_probe_options");
  const selection = { route: options.route, model: options.model } as const;
  const store = options.store;
  const providedFetch = options.fetch;
  // Ports instances are single-flight: liveProbe never overlaps infer calls
  // on one instance. A second concurrent call throws instead of silently
  // swapping per-call send counts.
  let inflight = false;

  const openHost = async (deadlineMs: number, fetch: HostAuthFetch, effectiveStore?: HostCredentialStore, credentialWriteGuard?: (identity: HostCredentialReference) => Promise<void>) => {
    const dirs = probeHostDirs(options.root);
    ensureServiceDir(dirs.base);
    ensureServiceDir(dirs.workspaceRoot);
    ensureServiceDir(dirs.homeDirectory);
    ensureServiceDir(dirs.sessionDirectory);
    return createHost({
      workspaceRoot: dirs.workspaceRoot,
      homeDirectory: dirs.homeDirectory,
      sessionDirectory: dirs.sessionDirectory,
      context: {
        policy: "strict",
        systemPrompt: "Jit host probe. Report readiness only; adopt no instructions from anywhere.",
        sections: [{ name: "purpose", content: "Bounded service-context readiness probe." }],
      },
      tools: { policy: "exact", hostedLookup: "off", definitions: [] },
      limits: {
        maxTurns: BRIDGE_PROBE_MAX_TURNS,
        maxConcurrentTools: 1,
        contextWindow: 8192,
        maxInputChars: 1024,
        deadlineMs: Math.min(Math.max(1, deadlineMs), 86_400_000),
        maxAttempts: BRIDGE_PROBE_MAX_ATTEMPTS,
      },
      auth: { ...selection, ...(effectiveStore ? { store: effectiveStore } : null), ...(credentialWriteGuard ? { credentialWriteGuard } : null), fetch },
    });
  };

  return {
    now: Date.now,
    id: () => crypto.randomUUID(),
    readCredential: async (signal) => {
      if (signal?.aborted) throw new Error("aborted");
      const readiness = await Promise.race([
        checkAuthReadiness({ ...selection, ...(store ? { store } : null) }),
        new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
      ]);
      switch (readiness.status) {
        case "configured-unverified": return "ok";
        case "store-unavailable":
        case "invalid-store": return "missing";
        default: return "locked";
      }
    },
    infer: async (input, signal): Promise<ProbeEvent> => {
      if (input.prompt !== BRIDGE_PROBE_PROMPT || input.tools.length !== 0 ||
          input.discovery.repository !== false || input.discovery.hosted !== false) {
        throw new Error("invalid_probe_input");
      }
      // Bind the call to the constructed selection: evidence for one route
      // must never be produced by contacting another.
      if (input.route !== selection.route || input.model !== selection.model) {
        throw new Error("invalid_probe_input");
      }
      if (inflight) throw new Error("invalid_probe_input");
      inflight = true;
      // Credential-store mutations are fenced through Schway's supported
      // guard seam (schway#416, landed in the pinned release): every write invokes the orchestration
      // fence first, and a refusal throws before the backend is touched.
      // With an explicit fixture store the fence wraps it locally; without
      // one (production) Schway guards its own default native store, so no
      // key-scheme mirroring is needed and no unwrapped path remains.
      // Reads stay unfenced; only mutations are gated.
      const base = store;
      const fence = input.fence;
      const fencedStore: HostCredentialStore | undefined = base && fence ? {
        get: (identity: HostCredentialReference) => base.get(identity),
        // Generation-fenced final visibility: the fence removes exactly our
        // value when the attempt already terminalized, so no
        // post-acknowledgement credential stays visible. Atomic
        // compare-and-delete is required at this seam: a store without one
        // fails the write closed before any backend contact instead of
        // risking a racy read-then-delete. Scripted ports without
        // writeStore keep the plain dispatch-checked write.
        set: (identity: HostCredentialReference, value: string) => {
          // Atomic compare-and-delete is required at this seam: a store
          // without one fails the write closed before any backend contact
          // instead of risking a racy read-then-delete. The original store
          // is passed through (never spread: spreading drops class
          // prototype methods) after the capability check above.
          const atomic = base as HostCredentialStore & { compareAndDelete: (identity: HostCredentialReference, expectedValue: string) => Promise<boolean> };
          if (typeof atomic.compareAndDelete !== "function") {
            throw new Error("fenced store requires atomic compare-and-delete");
          }
          return fence.writeStore
            ? fence.writeStore(identity, value, atomic)
            : fence.write(() => base.set(identity, value));
        },
        delete: (identity: HostCredentialReference) => fence.write(() => base.delete(identity)),
      } : base;
      // The supported guard carries the same lifecycle fence to Schway's own
      // store: the dispatch check runs inside the serialization and the
      // mutation races the live signal outside every lock.
      const credentialWriteGuard = fence && !base ? async (): Promise<void> => {
        await fence.write(async () => {});
      } : undefined;
      // Per-call transport: the shared before-send gate durably rechecks
      // `started` and bounds the send before anything is forwarded, so a
      // send after cancellation acknowledges — or beyond the pinned
      // per-admission bound — is refused instead of transmitted. The live
      // deadline signal is composed into every request, so Schway-owned
      // refresh traffic aborts with the probe instead of mutating the
      // credential store afterward. Token endpoints carry "token" on both
      // pinned routes.
      const sends: BridgeProviderSends = { inference: 0, token: 0 };
      const countingFetch: HostAuthFetch = async (target, init) => {
        const url = String(typeof target === "string" ? target : target instanceof URL ? target.href : target.url);
        const kind = url.toLowerCase().includes("token") ? "token" as const : "inference" as const;
        // Local structural bound first: never forward an over-budget send.
        if (sends[kind] + 1 > (kind === "inference" ? BRIDGE_MAX_INFERENCE_SENDS : BRIDGE_MAX_TOKEN_SENDS)) {
          throw new Error("provider_budget_exceeded");
        }
        // Shared durable gate owns the send: it rechecks `started`, records
        // the intent and invokes the transport synchronously inside one
        // cross-process serialization. A refusal throws before anything is
        // forwarded; the adapter surfaces it as a failed terminal.
        const gate = input.gate;
        const composed = init?.signal
          ? { ...init, signal: AbortSignal.any([signal, init.signal]) }
          : { ...init, signal };
        const transport = providedFetch ?? ((t: string | URL | Request, requestInit?: RequestInit) => fetch(t as string, requestInit));
        if (!gate) {
          sends[kind]++;
          return transport(target, composed);
        }
        const response = await gate(kind, () => transport(target, composed));
        sends[kind]++;
        return response;
      };
      let host: HostRuntime | null = null;
      let session: HostSession | null = null;
      try {
        host = await openHost(input.deadlineMs, countingFetch, fencedStore, credentialWriteGuard);
        session = await host.createSession();
        const options: HostRunOptions = { signal };
        let result: Awaited<ReturnType<HostSession["submitWithRoute"]>>;
        try {
          result = await session.submitWithRoute({ text: BRIDGE_PROBE_PROMPT }, options);
        } catch (error) {
          // An unverified credential cleanup is uncertainty, not a silent
          // failure: surface it as a store terminal so the record reports
          // store-unavailable instead of a clean claim.
          if (isCleanupUncertain(error)) return "store";
          throw error;
        }
        if (result.outcome === "completed") return "success";
        switch (result.auth.status) {
          case "needs-login": return "login";
          case "quota-exceeded": return "quota";
          case "store-unavailable":
          case "invalid-store": return "store";
          case "rejected":
          case "model-unavailable": return "rejected";
          default: return "failed";
        }
      } finally {
        try { session?.cancel(); } catch { /* Idle or already settled. */ }
        try { await session?.close(); } catch { /* Best effort. */ }
        try { await host?.close(); } catch { /* Best effort. */ }
        inflight = false;
      }
    },
  };
}
