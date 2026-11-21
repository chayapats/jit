import Foundation

// The actual authored Darwin writer, linked directly by the opt-in native fixture. No UIKit, picker or device claim.
@main
struct ExportFixture {
  static func main() throws {
    let arguments = CommandLine.arguments
    guard arguments.count == 4 else { fatalError("fixture_arguments") }
    do { try JitExclusiveExport.writeNew(arguments[1], arguments[2], Data(arguments[3].utf8)); print("created") }
    catch { print("refused") }
  }
}
