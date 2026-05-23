import ExpoModulesCore
import AVFoundation

public class ExpoVideoMetadataModule: Module, @unchecked Sendable {
  public func definition() -> ModuleDefinition {
    Name("ExpoVideoMetadata")

    AsyncFunction("getVideoInfo") { (sourceFilename: URL, options: ExpoVideoMetadataOptions) async throws -> [String: Any] in
      try await self.getVideoInfo(sourceFilename: sourceFilename, options: options)
    }
  }

  private func getOrientation(transform: CGAffineTransform, size: CGSize) -> String {
    // First check natural dimensions
    let isNaturallyPortrait = size.height > size.width

    // Calculate rotation angle from transform
    let angle = atan2(transform.b, transform.a)
    let degrees = angle * 180 / .pi
    let rotation = (Int(round(degrees)) + 360) % 360

    // Combine transform rotation with natural orientation
    switch rotation {
        case 0:
            return isNaturallyPortrait ? "Portrait" : "LandscapeRight"
        case 90, -270:
            return "Portrait"
        case 180, -180:
            return isNaturallyPortrait ? "PortraitUpsideDown" : "LandscapeLeft"
        case 270, -90:
            return "PortraitUpsideDown"
        default:
            // For unknown rotations, use natural dimensions
            return isNaturallyPortrait ? "Portrait" : "LandscapeRight"
    }
}

  internal func getVideoInfo(sourceFilename: URL, options: ExpoVideoMetadataOptions) async throws -> [String: Any] {
    if sourceFilename.isFileURL {
      guard FileSystemUtilities.permissions(appContext, for: sourceFilename).contains(.read) else {
        throw FileSystemReadPermissionException(sourceFilename.absoluteString)
      }
    }

    let assetURL = try await resolveAssetURL(sourceFilename: sourceFilename, options: options)
    defer {
      if assetURL != sourceFilename {
        try? FileManager.default.removeItem(at: assetURL)
      }
    }

    let asset = AVURLAsset(url: assetURL, options: ["AVURLAssetHTTPHeaderFieldsKey": options.headers])
    let duration = CMTimeGetSeconds(try await asset.load(.duration))
    let videoTracks = try await asset.loadTracks(withMediaType: .video)
    let audioTracks = try await asset.loadTracks(withMediaType: .audio)
    let metadata = try await asset.load(.metadata)
    let hasAudio = !audioTracks.isEmpty

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
    var isHDR: Bool? = nil
    var codec: String = ""
    var orientation: String = ""
    var audioSampleRate: Int = 0
    var audioChannels: Int = 0
    var audioCodec: String = ""
    var location: [String: Double]? = nil

    // If there are video tracks, extract more information
    if let videoTrack = videoTracks.first {
      // Bitrate
      bitrate = try await videoTrack.load(.estimatedDataRate)

      // Width and Height
      let size = try await videoTrack.load(.naturalSize)
      width = Int(size.width)
      height = Int(size.height)

      // Frame Rate
      frameRate = try await videoTrack.load(.nominalFrameRate)

      // Codec
      if let firstFormatDescription = try await videoTrack.load(.formatDescriptions).first {
        let codecType = CMFormatDescriptionGetMediaSubType(firstFormatDescription)
        codec = fourCharCodeToString(fourCharCode: codecType)
      }

      // Orientation
      orientation = getOrientation(transform: try await videoTrack.load(.preferredTransform), size: size)

      // HDR
      if #available(iOS 14.0, *) {
        isHDR = videoTrack.hasMediaCharacteristic(.containsHDRVideo)
      }
    }

    // Audio track information
    if let audioTrack = audioTracks.first {
      audioSampleRate = Int(try await audioTrack.load(.naturalTimeScale))

      // Extracting audio channels from the format descriptions
      let formatDescriptions = try await audioTrack.load(.formatDescriptions) as [CMAudioFormatDescription]
      if let firstFormatDescription = formatDescriptions.first {
        let audioStreamBasicDescription = CMAudioFormatDescriptionGetStreamBasicDescription(firstFormatDescription)?.pointee
        audioChannels = Int(audioStreamBasicDescription?.mChannelsPerFrame ?? 0)

        // Extract audio codec
        let codecType = CMFormatDescriptionGetMediaSubType(firstFormatDescription)
        audioCodec = fourCharCodeToString(fourCharCode: codecType)
      }
    }

    // Extract GPS metadata
    if let gpsData = extractGPSData(from: metadata) {
      location = gpsData
    }

    let hasDimensions = width > 0 && height > 0
    let aspectRatio = hasDimensions ? Double(width) / Double(height) : 0
    
    return [
      "duration": duration,
      "hasAudio": hasAudio,
      "isHDR": isHDR as Any,
      "fileSize": fileSize,
      "bitrate": bitrate,
      "fps": frameRate,
      "width": width,
      "height": height,
      "codec": codec,
      "orientation": orientation,
      "naturalOrientation": height > width ? "Portrait" : "Landscape",
      "aspectRatio": aspectRatio,
      "is16_9": hasDimensions && abs(aspectRatio - 16.0/9.0) < 0.01,
      "audioSampleRate": audioSampleRate,
      "audioChannels": audioChannels,
      "audioCodec": audioCodec,
      "location": location as Any
    ]
  }

  private func resolveAssetURL(sourceFilename: URL, options: ExpoVideoMetadataOptions) async throws -> URL {
    guard !sourceFilename.isFileURL else {
      return sourceFilename
    }

    do {
      try await assertAssetIsReadable(sourceFilename: sourceFilename, options: options)
      return sourceFilename
    } catch {
      return try await downloadRemoteAsset(sourceFilename: sourceFilename, options: options)
    }
  }

  private func assertAssetIsReadable(sourceFilename: URL, options: ExpoVideoMetadataOptions) async throws {
    let asset = AVURLAsset(url: sourceFilename, options: ["AVURLAssetHTTPHeaderFieldsKey": options.headers])
    _ = try await asset.load(.duration)
    _ = try await asset.loadTracks(withMediaType: .video)
  }

  private func downloadRemoteAsset(sourceFilename: URL, options: ExpoVideoMetadataOptions) async throws -> URL {
    var request = URLRequest(url: sourceFilename)
    for (header, value) in options.headers {
      request.setValue(value, forHTTPHeaderField: header)
    }

    let (downloadedURL, response) = try await URLSession.shared.download(for: request)
    if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
      try? FileManager.default.removeItem(at: downloadedURL)
      throw RemoteVideoDownloadException((sourceFilename.absoluteString, httpResponse.statusCode))
    }

    let fileExtension = sourceFilename.pathExtension.isEmpty ? "mp4" : sourceFilename.pathExtension
    let temporaryURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension(fileExtension)

    do {
      try FileManager.default.moveItem(at: downloadedURL, to: temporaryURL)
    } catch {
      try? FileManager.default.removeItem(at: downloadedURL)
      try? FileManager.default.removeItem(at: temporaryURL)
      throw error
    }
    return temporaryURL
  }
}

private func extractGPSData(from metadata: [AVMetadataItem]) -> [String: Double]? {
  let locationKey = "com.apple.quicktime.location.ISO6709"

  if let locationItem = metadata.first(where: { ($0.key as? String) == locationKey }),
     let locationString = locationItem.stringValue {
    return parseISO6709(locationString)
  }

  return nil
}

private func parseISO6709(_ string: String) -> [String: Double]? {
  // Format: +DD.DDDD+DDD.DDDD+AAA.AAA/
  // Where DD.DDDD is latitude, DDD.DDDD is longitude, and AAA.AAA is altitude (optional)
  let components = string.trimmingCharacters(in: CharacterSet(charactersIn: "/")).components(separatedBy: "+")
  guard components.count >= 3 else { return nil }

  let latitude = Double(components[1]) ?? 0
  let longitude = Double(components[2]) ?? 0
  let altitude = components.count > 3 ? Double(components[3]) : nil

  var result: [String: Double] = [
    "latitude": latitude,
    "longitude": longitude
  ]

  if let altitude = altitude {
    result["altitude"] = altitude
  }

  return result
}

// Helper function to convert FourCC code to String
private func fourCharCodeToString(fourCharCode: FourCharCode) -> String {
  let characters = [
    Character(UnicodeScalar((fourCharCode >> 24) & 0xFF)!),
    Character(UnicodeScalar((fourCharCode >> 16) & 0xFF)!),
    Character(UnicodeScalar((fourCharCode >> 8) & 0xFF)!),
    Character(UnicodeScalar(fourCharCode & 0xFF)!)
  ]
  // Remove any trailing whitespaces, since FourCC codes are 4 characters long and padded with spaces ("aac " for example)
  return String(characters).trimmingCharacters(in: .whitespaces)
}
