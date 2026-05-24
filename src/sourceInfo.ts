import { BlobSource, UrlSource, type Source } from "mediabunny";

import type { VideoInfoOptions, VideoSource } from "./ExpoVideoMetadata.types";
import { isBlobLikeSource, safeRead } from "./utils";

export type SourceInfo = {
  source: Source;
  fileSize: number;
};

function isBlobSource(source: VideoSource): source is Blob {
  return typeof Blob !== "undefined" && source instanceof Blob;
}

export async function createBlobSourceInfo(source: VideoSource): Promise<SourceInfo | null> {
  if (isBlobSource(source)) {
    return {
      source: new BlobSource(source),
      fileSize: source.size,
    };
  }

  if (typeof source === "string" && isBlobLikeSource(source)) {
    const response = await fetch(source);
    const blob = await response.blob();

    return {
      source: new BlobSource(blob),
      fileSize: blob.size,
    };
  }

  return null;
}

export async function createUrlSourceInfo(
  source: string,
  options: VideoInfoOptions
): Promise<SourceInfo> {
  const urlSource = new UrlSource(source, {
    requestInit: {
      headers: options.headers,
    },
    getRetryDelay: () => null,
  });

  return {
    source: urlSource,
    fileSize: (await safeRead(() => urlSource.getSizeOrNull(), null)) ?? 0,
  };
}
