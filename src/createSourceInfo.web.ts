import { BlobSource, UrlSource } from "mediabunny";

import type {
  VideoInfoOptions,
  VideoSource,
} from "./ExpoVideoMetadata.types";
import type { SourceInfo } from "./createSourceInfo";

export function isBlobLikeSource(source: string) {
  return source.startsWith("blob:") || source.startsWith("data:");
}

export function isLocalFileSource(source: string) {
  return source.startsWith("file:") || source.startsWith("content:");
}

function isBlobSource(source: VideoSource): source is Blob {
  return typeof Blob !== "undefined" && source instanceof Blob;
}

async function safeRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

export async function createSourceInfo(
  source: VideoSource,
  options: VideoInfoOptions
): Promise<SourceInfo> {
  if (isBlobSource(source)) {
    return {
      source: new BlobSource(source),
      fileSize: source.size,
    };
  }

  if (isBlobLikeSource(source)) {
    const response = await fetch(source);
    const blob = await response.blob();

    return {
      source: new BlobSource(blob),
      fileSize: blob.size,
    };
  }

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
