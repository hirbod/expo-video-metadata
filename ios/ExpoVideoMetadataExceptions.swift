import ExpoModulesCore

internal class FileSystemReadPermissionException: GenericException<String> {
  override var reason: String {
    "File '\(param)' is not readable"
  }
}
