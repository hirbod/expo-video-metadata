import ExpoModulesCore
import AVFoundation

public class ExpoVideoMetadataModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoVideoMetadata")

    AsyncFunction("getVideoInfo", getVideoInfo).runOnQueue(.main)
  }

  internal func getVideoInfo(sourceFilename: URL, options: ExpoVideoMetadataOptions) throws -> [String: Any] {
    if sourceFilename.isFileURL {
      guard FileSystemUtilities.permissions(appContext, for: sourceFilename).contains(.read) else {
        throw FileSystemReadPermissionException(sourceFilename.absoluteString)
      }
    }

    let asset = AVURLAsset.init(url: sourceFilename, options: ["AVURLAssetHTTPHeaderFieldsKey": options.headers])
    let duration = CMTimeGetSeconds(asset.duration)
    let hasAudio = asset.tracks(withMediaType: .audio).count > 0

    var fileSize: Int64 = 0
    if let fileAttributes = try? FileManager.default.attributesOfItem(atPath: sourceFilename.path),
       let size = fileAttributes[.size] as? NSNumber {
      fileSize = size.int64Value
    }

    // Initialize default values
    var bitrate: Float = 0.0
    var width: Int = 0
    var height: Int = 0
    var frameRate: Float = 0.0
    var codec: String = ""
    var orientation: String = ""
    var audioSampleRate: Int = 0
    var audioChannels: Int = 0
    var audioCodec: String = ""

    // If there are video tracks, extract more information
    if let videoTrack = asset.tracks(withMediaType: .video).first {
      // Bitrate
      bitrate = videoTrack.estimatedDataRate

      // Width and Height
      let size = videoTrack.naturalSize
      width = Int(size.width)
      height = Int(size.height)

      // Frame Rate
      frameRate = videoTrack.nominalFrameRate

      // Codec
      if let firstFormatDescription = videoTrack.formatDescriptions.first {
        let formatDescription = firstFormatDescription as! CMFormatDescription
        let codecType = CMFormatDescriptionGetMediaSubType(formatDescription)
        codec = fourCharCodeToString(fourCharCode: codecType)
      }

      // Orientation
      let transform = videoTrack.preferredTransform
      if transform.a == 0 && transform.d == 0 {
        orientation = (transform.b == 1.0) ? "Portrait" : "PortraitUpsideDown"
      } else {
        orientation = (transform.a == 1.0) ? "LandscapeRight" : "LandscapeLeft"
      }
    }

    // Audio track information
    if let audioTrack = asset.tracks(withMediaType: .audio).first {
      audioSampleRate = Int(audioTrack.naturalTimeScale)

      // Extracting audio channels from the format descriptions
      if let formatDescriptions = audioTrack.formatDescriptions as? [CMAudioFormatDescription],
         let firstFormatDescription = formatDescriptions.first {
        let audioStreamBasicDescription = CMAudioFormatDescriptionGetStreamBasicDescription(firstFormatDescription)?.pointee
        audioChannels = Int(audioStreamBasicDescription?.mChannelsPerFrame ?? 0)

        // Extract audio codec
        let codecType = CMFormatDescriptionGetMediaSubType(firstFormatDescription)
        audioCodec = fourCharCodeToString(fourCharCode: codecType)
      }
    }

    return [
      "duration": duration,
      "hasAudio": hasAudio,
      "fileSize": fileSize,
      "bitrate": bitrate,
      "fps": frameRate,
      "width": width,
      "height": height,
      "codec": codec,
      "orientation": orientation,
      "audioSampleRate": audioSampleRate,
      "audioChannels": audioChannels,
      "audioCodec": audioCodec
    ]
  }

  // Helper function to convert FourCC code to String
  private func fourCharCodeToString(fourCharCode: FourCharCode) -> String {
    let characters = [
      Character(UnicodeScalar((fourCharCode >> 24) & 0xFF)!),
      Character(UnicodeScalar((fourCharCode >> 16) & 0xFF)!),
      Character(UnicodeScalar((fourCharCode >> 8) & 0xFF)!),
      Character(UnicodeScalar(fourCharCode & 0xFF)!)
    ]
    return String(characters)
  }
}
