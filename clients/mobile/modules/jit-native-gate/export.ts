import { NativeModule, requireOptionalNativeModule } from "expo";
declare class NativeExport extends NativeModule {
  /** Create a new leaf exclusively in the current owner-selected iOS directory. Never replaces an existing name. */
  writeNew(directory: string, name: string, bytes: Uint8Array): Promise<void>;
}
export default requireOptionalNativeModule<NativeExport>("JitNativeExport");
