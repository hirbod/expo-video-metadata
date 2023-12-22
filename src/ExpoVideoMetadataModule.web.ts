import type {
  VideoInfoOptions,
  VideoInfoResult,
} from "./ExpoVideoMetadata.types";

export default {
  get name(): string {
    return "ExpoVideoMetadata";
  },
  async getVideoInfoAsync(
    sourceFilename: string,
    options: VideoInfoOptions = {},
  ): Promise<VideoInfoResult> {
    throw new Error("ExpoVideoMetadata not supported on Expo Web yet");
  },
};
