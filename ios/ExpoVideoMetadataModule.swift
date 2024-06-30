import ExpoModulesCore
import AVFoundation

public class ExpoVideoMetadataModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoVideoMetadata")
    
    AsyncFunction("getVideoInfo", getVideoInfo)
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
    var isHDR: Bool? = nil
    var codec: String = ""
    var orientation: String = ""
    var audioSampleRate: Int = 0
    var audioChannels: Int = 0
    var audioCodec: String = ""
    var location: [String: Double]? = nil
    
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
      
      // HDR
      if #available(iOS 14.0, *) {
        isHDR = videoTrack.hasMediaCharacteristic(.containsHDRVideo)
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
    
    // Extract GPS metadata
    if let gpsData = extractGPSData(from: asset.metadata) {
      location = gpsData
    }
    
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
      "audioSampleRate": audioSampleRate,
      "audioChannels": audioChannels,
      "audioCodec": audioCodec,
      "location": location as Any
    ]
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

