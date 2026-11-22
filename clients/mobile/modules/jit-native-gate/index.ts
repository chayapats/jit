import { NativeModule, requireNativeModule } from "expo";

/** Native visibility epoch and local setup facts; never a credential, service selection, command or approval. */
export interface NativeLifecycle { epoch: number; active: boolean }
declare class NativeGate extends NativeModule<{ lifecycle: (state: NativeLifecycle) => void }> {
  status(): Promise<NativeLifecycle>;
  acknowledge(epoch: number): Promise<boolean>;
  nativePushConfigured(): Promise<boolean>;
}
export default requireNativeModule<NativeGate>("JitNativeGate");
