import { File, FileMode, type FileHandle } from "expo-file-system";
import { StreamSource } from "mediabunny";

import type { VideoInfoOptions, VideoSource } from "./ExpoVideoMetadata.types";
import { createBlobSourceInfo, createUrlSourceInfo, type SourceInfo } from "./sourceInfo";
import { isLocalFileSource } from "./utils";

function createFileSystemSourceInfo(file: File): SourceInfo {
  let handle: FileHandle | null = null;
  const fileSize = file.size;

  const getHandle = () => {
    handle ??= file.open(FileMode.ReadOnly);
    return handle;
  };

  return {
    source: new StreamSource({
      getSize: () => fileSize,
      read: (start, end) => {
        const readStart = Math.max(0, Math.min(start, fileSize));
        const readEnd = Math.max(readStart, Math.min(end, fileSize));
        const length = readEnd - readStart;

        if (length === 0) {
          return new Uint8Array();
        }

        const currentHandle = getHandle();
        currentHandle.offset = readStart;
        return currentHandle.readBytes(length);
      },
      dispose: () => {
        handle?.close();
        handle = null;
      },
      prefetchProfile: "fileSystem",
    }),
    fileSize,
  };
}

export async function createSourceInfo(
  source: VideoSource,
  options: VideoInfoOptions
): Promise<SourceInfo> {
  const blobSourceInfo = await createBlobSourceInfo(source);
  if (blobSourceInfo) {
    return blobSourceInfo;
  }

  if (typeof source === "string" && isLocalFileSource(source)) {
    return createFileSystemSourceInfo(new File(source));
  }

  if (typeof source === "string") {
    return await createUrlSourceInfo(source, options);
  }

  throw new TypeError("Unsupported video source.");
}
