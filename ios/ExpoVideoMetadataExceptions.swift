import ExpoModulesCore

internal class FileSystemReadPermissionException: GenericException<String>, @unchecked Sendable {
  override var reason: String {
    "File '\(param)' is not readable"
  }
}

internal class RemoteVideoDownloadException: GenericException<(String, Int)>, @unchecked Sendable {
  override var reason: String {
    "Remote video '\(param.0)' could not be downloaded. HTTP status code: \(param.1)"
  }
}
