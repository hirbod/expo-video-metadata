export type VideoInfoResult = {
  /**
   * Duration of the video in seconds (float).
   */
  duration: number;
  /**
   * Tells if the video has a audio track. If the video has no audio track, its considered a mute video.
   */
  hasAudio: boolean;
  /**
   * Available only on iOS >= 14. Tells if the video is a HDR video.
   */
  isHDR: boolean;
  /**
   * Width of the video in pixels.
   */
  width: number;
  /**
   * Height of the video in pixels.
   */
  height: number;
  /**
   * Frame rate of the video in frames per second.
   */
  fps: number;
  /**
   * Bit rate of the video in bits per second.
   */
  bitRate: number;
  /**
   * File size of the video in bytes. Works only for local files, returns 0 for remote files.
   */
  fileSize: number;
  /**
   * Video codec.
   */
  codec: string;
  /**
   * Video orientation.
   */
  orientation:
    | "Portrait"
    | "PortraitUpsideDown"
    | "Landscape"
    | "LandscapeRight"
    | "LandscapeLeft";
  /**
   * Audio sample rate of the video in samples per second.
   */
  audioSampleRate: number;
  /**
   * Audio channel count of the video.
   */
  audioChannels: number;
  /**
   * Audio codec of the video.
   */
  audioCodec: string;
};

export type VideoInfoOptions = {
  /**
   * In case `sourceFilename` is a remote URI, `headers` object is passed in a network request.
   */
  headers?: Record<string, string>;
};
