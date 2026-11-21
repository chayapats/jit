import ExpoModulesCore
import Foundation

/** Only a newly created leaf in the owner-selected directory; no overwrite, remove or executable API. */
public final class JitNativeExportModule: Module {
  public func definition() -> ModuleDefinition {
    Name("JitNativeExport")
    AsyncFunction("writeNew") { (directory: String, name: String, bytes: Data) throws in
      try JitExclusiveExport.writeNew(directory, name, bytes)
    }
  }
}
