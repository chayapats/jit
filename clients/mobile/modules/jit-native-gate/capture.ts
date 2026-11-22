import { NativeModule, requireNativeModule } from "expo";

/** Epoch-bound one-use native PCM lease, separate from visibility acknowledgement and every service command. */
declare class NativeCapture extends NativeModule {
  requestPermission(): Promise<{ granted: boolean }>;
  prepare(epoch: number, maxMs: number): Promise<string>;
  start(lease: string): Promise<void>;
  finish(lease: string): Promise<unknown>;
  cancel(lease: string): Promise<void>;
}
export default requireNativeModule<NativeCapture>("JitNativeCapture");
