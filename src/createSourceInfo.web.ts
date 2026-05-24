import type { VideoInfoOptions, VideoSource } from "./ExpoVideoMetadata.types";
import { createBlobSourceInfo, createUrlSourceInfo, type SourceInfo } from "./sourceInfo";

export async function createSourceInfo(
  source: VideoSource,
  options: VideoInfoOptions
): Promise<SourceInfo> {
  const blobSourceInfo = await createBlobSourceInfo(source);
  if (blobSourceInfo) {
    return blobSourceInfo;
  }

  if (typeof source === "string") {
    return await createUrlSourceInfo(source, options);
  }

  throw new TypeError("Unsupported video source.");
}
