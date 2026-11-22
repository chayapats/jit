import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { fetch as expoFetch } from "expo/fetch";
import { MobileTransport, type MobileSecureStore } from "../../../src/s16/mobile/transport";
import { MobileSession } from "../../../src/s16/mobile/session";

/** OS-backed primitives used by the shared client; no random/hash fallback or global Request/Blob replacement. */
export function installNativeCrypto(): void {
  const current = globalThis.crypto ?? {} as Crypto;
  if (typeof current.randomUUID !== "function") Object.defineProperty(current, "randomUUID", { value: () => Crypto.randomUUID(), configurable: true });
  if (typeof current.getRandomValues !== "function") Object.defineProperty(current, "getRandomValues", { value: Crypto.getRandomValues, configurable: true });
  if (typeof current.subtle?.digest !== "function") {
    Object.defineProperty(current, "subtle", { configurable: true, value: {
      async digest(algorithm: AlgorithmIdentifier, input: BufferSource): Promise<ArrayBuffer> {
        const name = typeof algorithm === "string" ? algorithm : algorithm.name;
        if (name.toUpperCase() !== "SHA-256") throw new Error("mobile_crypto_algorithm_unsupported");
        const view = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        return Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(view));
      }
    } });
  }
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: current, configurable: true });
}

const custody: SecureStore.SecureStoreOptions = { keychainService: "io.jit.mobile", keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
/** SecureStore is the sole device session/configuration store; failures are never replaced with ordinary files. */
export const nativeStore: MobileSecureStore = {
  get: key => SecureStore.getItemAsync(key, custody),
  set: (key, value) => SecureStore.setItemAsync(key, value, custody),
  delete: key => SecureStore.deleteItemAsync(key, custody)
};

/** Explicit actual streaming Expo Fetch. The transport sets omit/manual/error, origin, cookie and complete-body guards. */
export function createNativeSession(origin: string): MobileSession {
  installNativeCrypto();
  return new MobileSession(new MobileTransport({ origin, store: nativeStore, fetch: async (url, init) => {
    const result = await expoFetch(url, { ...(init.method ? { method: init.method } : {}), ...(init.headers ? { headers: init.headers } : {}), ...(init.body !== undefined && init.body !== null ? { body: init.body } : {}), credentials: "omit", ...(init.redirect ? { redirect: init.redirect } : {}), ...(init.signal ? { signal: init.signal } : {}) });
    // Expo implements the standard streaming Response. Bun's broader ambient Response adds unused members.
    return result as unknown as Response;
  } }));
}
