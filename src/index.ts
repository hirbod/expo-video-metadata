import {
  VideoInfoOptions,
  VideoInfoResult,
  VideoSource,
} from "./ExpoVideoMetadata.types";
import ExpoVideoMetadataModule from "./ExpoVideoMetadataModule";

export { VideoInfoOptions, VideoInfoResult };

// Import the native module. On web, it will be resolved to ExpoVideoMetadata.web.ts
// and on native platforms to ExpoVideoMetadata.ts

/**
 * Retrieves video metadata.
 *
 * @param source An URI (string) of the video, local or remote. On web, it can be a File or Blob object, too. base64 URIs are supported but not recommended, as they can be very large and cause performance issues.
 * @param options Pass `headers` object in case `sourceFilename` is a remote URI, e.g { headers: "Authorization": "Bearer some-token" } etc.
 *
 * @return Returns a promise which fulfils with [`VideoInfoResult`](#Videoinforesult).
 */
export async function getVideoInfoAsync(
  source: VideoSource,
  options: VideoInfoOptions = {}
): Promise<VideoInfoResult> {
  return await ExpoVideoMetadataModule.getVideoInfo(source, options);
}
