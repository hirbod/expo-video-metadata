import ExpoModulesCore

internal struct ExpoVideoMetadataOptions: Record {
  @Field var headers: [String: String] = [String: String]()
}