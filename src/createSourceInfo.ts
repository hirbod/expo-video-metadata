import { File, FileMode, type FileHandle } from "expo-file-system";
import { BlobSource, Source, UrlSource } from "mediabunny";

import type {
  VideoInfoOptions,
  VideoSource,
} from "./ExpoVideoMetadata.types";

export type SourceInfo = {
  source: Source;
  fileSize: number;
};

type SourceReadResult = {
  bytes: Uint8Array;
  view: DataView;
  offset: number;
};

export function isBlobLikeSource(source: string) {
  return source.startsWith("blob:") || source.startsWith("data:");
}

export function isLocalFileSource(source: string) {
  return source.startsWith("file:") || source.startsWith("content:");
}

function isBlobSource(source: VideoSource): source is Blob {
  return typeof Blob !== "undefined" && source instanceof Blob;
}

class ExpoFileSystemSource extends Source {
  private handle: FileHandle | null;
  private readonly size: number;

  constructor(file: File) {
    super();

    this.handle = file.open(FileMode.ReadOnly);
    this.size = this.handle.size ?? file.size;
  }

  _getFileSize() {
    return this.size;
  }

  _read(start: number, end: number): SourceReadResult | null {
    const handle = this.handle;
    if (!handle) {
      return null;
    }

    const readStart = Math.max(0, Math.min(start, this.size));
    const readEnd = Math.max(readStart, Math.min(end, this.size));
    const length = readEnd - readStart;

    if (length === 0) {
      return null;
    }

    handle.offset = readStart;
    const bytes = handle.readBytes(length);
    const actualEnd = readStart + bytes.byteLength;

    (
      this as unknown as {
        _dispatchRead: (start: number, end: number) => void;
      }
    )._dispatchRead(readStart, actualEnd);

    return {
      bytes,
      view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      offset: readStart,
    };
  }

  _dispose() {
    this.handle?.close();
    this.handle = null;
  }
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

  if (isLocalFileSource(source)) {
    const file = new File(source);

    return {
      source: new ExpoFileSystemSource(file),
      fileSize: file.size,
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
