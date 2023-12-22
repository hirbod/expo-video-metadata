import { VideoInfoOptions, VideoInfoResult } from "./ExpoVideoMetadata.types";
import ExpoVideoMetadataModule from "./ExpoVideoMetadataModule";

export { VideoInfoOptions, VideoInfoResult };

// Import the native module. On web, it will be resolved to ExpoVideoMetadata.web.ts
// and on native platforms to ExpoVideoMetadata.ts

/**
 * Create an image thumbnail from video provided via `sourceFilename`.
 *
 * @param sourceFilename An URI of the video, local or remote.
 * @param options Pass `headers` object in case `sourceFilename` is a remote URI, e.g { headers: "Authorization": "Bearer some-token" } etc.
 *
 * @return Returns a promise which fulfils with [`VideoInfoResult`](#Videoinforesult).
 */
export async function getVideoInfoAsync(
  sourceFilename: string,
  options: VideoInfoOptions = {},
): Promise<VideoInfoResult> {
  return await ExpoVideoMetadataModule.getVideoInfo(sourceFilename, options);
}
