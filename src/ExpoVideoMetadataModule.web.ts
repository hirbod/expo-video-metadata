import type {
  VideoInfoOptions,
  VideoInfoResult,
  VideoSource,
} from "./ExpoVideoMetadata.types";

interface Track {
  id: string;
  kind: string;
  label: string;
  language: string;
}

interface AudioTrack extends Track {
  enabled: boolean;
}

interface VideoTrack extends Track {
  selected: boolean;
}

type TrackList<T> = T[];

interface HTMLVideoElementWithTracks extends HTMLVideoElement {
  videoTracks?: TrackList<VideoTrack>;
  audioTracks?: TrackList<AudioTrack>;
  mozHasAudio?: boolean;
  webkitAudioDecodedByteCount?: number;
  captureStream?(): MediaStream;
}

export default {
  name: "ExpoVideoMetadata",

  getVideoFrameRate(videoElement: HTMLVideoElementWithTracks) {
    if (!videoElement.captureStream) {
      console.info("captureStream method not supported");
      return 0;
    }

    const stream = videoElement.captureStream();
    const [videoTrack] = stream.getVideoTracks();

    if (!videoTrack) {
      console.info("No video track found");
      return 0;
    }

    return videoTrack.getSettings().frameRate ?? 0;
  },

  async getAudioBuffer(
    audioUrl: string,
    options: RequestInit = {}
  ): Promise<{ sampleRate: number; numberOfChannels: number }> {
    const audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)();

    try {
      const response = await fetch(audioUrl, options);
      const arrayBuffer = await response.arrayBuffer();

      return new Promise((resolve, reject) => {
        audioContext.decodeAudioData(
          arrayBuffer,
          ({ sampleRate, numberOfChannels }) =>
            resolve({ sampleRate, numberOfChannels }),
          reject
        );
      });
    } catch (error) {
      throw new Error(
        `Error fetching or decoding audio file: ${error.message}`
      );
    } finally {
      await audioContext.close();
    }
  },

  getBase64FileSize(base64String: string): number {
    const base64Data = base64String.replace(/^data:.+;base64,/, "");
    return atob(base64Data).length;
  },

  async getFileSize(url: string, options: RequestInit = {}): Promise<number> {
    if (url.startsWith("data:")) {
      return this.getBase64FileSize(url);
    }

    try {
      const response = await fetch(url, { method: "HEAD", ...options });
      const contentLength = response.headers.get("Content-Length");
      return contentLength ? parseInt(contentLength, 10) : 0;
    } catch (error) {
      console.error("Error fetching file size for URL:", url, error);
      return 0;
    }
  },

  async getVideoInfo(
    source: VideoSource,
    options: VideoInfoOptions = {}
  ): Promise<VideoInfoResult> {
    const video = document.createElement("video") as HTMLVideoElementWithTracks;
    let videoUrl = "";

    if (typeof source === "string") {
      videoUrl = source;
    } else if (source instanceof File || source instanceof Blob) {
      videoUrl = URL.createObjectURL(source);
    }

    Object.assign(video, {
      crossOrigin: "anonymous",
      autoplay: true,
      muted: true,
      playsInline: true,
    });

    const resetVideo = () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
      // Revoke the object URL if it was created
      if (source instanceof File || source instanceof Blob) {
        URL.revokeObjectURL(videoUrl);
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        // Can't use `loadedmetadata` event because it does not contain videoTracks, audioTracks and other metadata
        video.onloadeddata = () => resolve();
        video.onerror = () =>
          reject(new Error("Failed to load video metadata"));
        video.src = videoUrl;
        video.load();
        video.pause();
      });

      const { duration, videoWidth: width, videoHeight: height } = video;
      const videoTrack = video.videoTracks?.[0];
      const audioTrack = video.audioTracks?.[0];

      const hasAudio =
        Boolean(video.audioTracks?.length) ||
        video.mozHasAudio ||
        Boolean(video.webkitAudioDecodedByteCount);

      const fileSize =
        source instanceof File || source instanceof Blob
          ? source.size
          : await this.getFileSize(videoUrl, options);

      const bitRate =
        fileSize && duration ? Math.floor(fileSize / duration) : 0;

      const { numberOfChannels: audioChannels, sampleRate: audioSampleRate } =
        await this.getAudioBuffer(videoUrl);

      const fps = this.getVideoFrameRate(video);

      return {
        duration,
        width,
        height,
        bitRate,
        fileSize,
        hasAudio,
        audioSampleRate,
        isHDR: null, // not supported on web
        audioCodec: audioTrack?.label ?? "",
        codec: videoTrack?.label ?? "",
        audioChannels,
        fps,
        orientation: width >= height ? "Landscape" : "Portrait",
        location: null, // not supported on web
      };
    } finally {
      resetVideo();
    }
  },
};
