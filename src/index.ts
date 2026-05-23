import type { VideoInfoOptions, VideoInfoResult, VideoSource } from "./ExpoVideoMetadata.types";
import ExpoVideoMetadataModule from "./ExpoVideoMetadataModule";

export type {
  AudioTrackInfo,
  BaseTrackInfo,
  ColorSpaceInfo,
  MediaTrackInfo,
  MetadataImageInfo,
  MetadataTagsInfo,
  PacketStatsInfo,
  RationalInfo,
  VideoInfoOptions,
  VideoInfoResult,
  VideoSource,
  VideoTrackInfo,
} from "./ExpoVideoMetadata.types";

/**
 * Retrieves video metadata.
 *
 * @param source A local or remote URI. On web, it can also be a File or Blob.
 * @param options Pass `headers` for remote URIs. Use `exactDuration` or
 * `packetStatsSampleCount: null` when you need full scans instead of fast
 * metadata estimates.
 *
 * @return Returns a promise which fulfils with [`VideoInfoResult`](#Videoinforesult).
 */
export async function getVideoInfoAsync(
  source: VideoSource,
  options: VideoInfoOptions = {}
): Promise<VideoInfoResult> {
  return await ExpoVideoMetadataModule.getVideoInfo(source, options);
}
