import Darwin
import Foundation

private struct ExportFailure: Error { let code = "mobile_export_unavailable" }

/** Exclusive selected-directory writer, also exercised by the opt-in Darwin fixture. */
enum JitExclusiveExport {
  static func writeNew(_ directory: String, _ name: String, _ bytes: Data) throws {
    guard let url = URL(string: directory), url.isFileURL, url.host == nil || url.host == "", url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
      !name.isEmpty, name != ".", name != "..", name.utf8.count <= 255,
      !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || $0 == "/" || $0 == "\\" }),
      bytes.count <= 4 * 1024 * 1024 else { throw ExportFailure() }
    // The public Expo directory picker holds the selected security scope for the live Directory object.
    let parent = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard parent >= 0 else { throw ExportFailure() }; defer { Darwin.close(parent) }
    let file = Darwin.openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard file >= 0 else { throw ExportFailure() }; defer { Darwin.close(file) }
    try bytes.withUnsafeBytes { buffer in
      var offset = 0
      while offset < buffer.count {
        let count = Darwin.write(file, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { throw ExportFailure() }; offset += count
      }
    }
    guard Darwin.fsync(file) == 0 else { throw ExportFailure() }
  }
}
