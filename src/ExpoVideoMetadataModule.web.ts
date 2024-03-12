import type {
  VideoInfoOptions,
  VideoInfoResult,
} from "./ExpoVideoMetadata.types";

// Define minimal structures for AudioTrack and VideoTrack based on the specification
interface AudioTrack {
  id: string;
  kind: string;
  label: string;
  language: string;
  enabled: boolean;
}

interface VideoTrack {
  id: string;
  kind: string;
  label: string;
  language: string;
  selected: boolean;
}

// Define AudioTrackList and VideoTrackList as arrays of their respective track types
type AudioTrackList = AudioTrack[];
type VideoTrackList = VideoTrack[];

// Extend the HTMLVideoElement type for browsers that support videoTracks and audioTracks
interface HTMLVideoElementWithTracks extends HTMLVideoElement {
  videoTracks?: VideoTrackList;
  audioTracks?: AudioTrackList;
  mozHasAudio?: boolean;
  webkitAudioDecodedByteCount?: number;
}

export default {
  get name(): string {
    return "ExpoVideoMetadata";
  },
  getVideoFrameRate(videoElement) {
    if (!videoElement.captureStream) {
      console.error("captureStream method not supported");
      return 0;
    }

    const stream = videoElement.captureStream();
    const videoTrack = stream.getVideoTracks()[0];

    if (!videoTrack) {
      console.error("No video track found");
      return 0;
    }

    const settings = videoTrack.getSettings();
    return settings.frameRate;
  },
  async getAudioBuffer(
    audioUrl: string,
    options = {}
  ): Promise<{ sampleRate: number; numberOfChannels: number }> {
    const audioContext = new (window.AudioContext ||
      // @ts-expect-error
      window.webkitAudioContext)();

    try {
      const response = await fetch(audioUrl, options);
      const arrayBuffer = await response.arrayBuffer();

      return new Promise((resolve, reject) => {
        audioContext.decodeAudioData(
          arrayBuffer,
          (audioBuffer) => {
            resolve({
              sampleRate: audioBuffer.sampleRate,
              numberOfChannels: audioBuffer.numberOfChannels,
            });
          },
          reject
        );
      });
    } catch (error) {
      // Handle fetch errors or other errors here
      throw new Error(
        "Error fetching or decoding audio file: " + error.message
      );
    } finally {
      audioContext.close();
    }
  },
  getBase64FileSize(base64String: string) {
    // Use a regular expression to remove any data URL prefix
    const base64Data = base64String.replace(/^data:.+;base64,/, "");

    // Decode the base64 string
    const binaryString = atob(base64Data);

    // Create an ArrayBuffer with the same length as the binary string
    const bytes = new Uint8Array(binaryString.length);

    // Fill the ArrayBuffer with elements from the binary string
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // The length of the ArrayBuffer is the size in bytes
    return bytes.length;
  },
  async getFileSize(url: string, options = {}) {
    if (url.startsWith("data:")) {
      // Handle data URL
      return this.getBase64FileSize(url);
    } else {
      // Handle regular URL
      try {
        const response = await fetch(url, { method: "HEAD", ...options });
        const contentLength = response.headers.get("Content-Length");
        return contentLength ? parseInt(contentLength, 10) : 0;
      } catch (error) {
        console.error("Error fetching file size for URL:", url, error);
        return 0;
      }
    }
  },
  async getVideoInfo(
    sourceFilename: string,
    options: VideoInfoOptions = {}
  ): Promise<VideoInfoResult> {
    return new Promise((resolve, reject) => {
      const video = document.createElement(
        "video"
      ) as HTMLVideoElementWithTracks;

      // this is required for Chrome, otherwise it can't detect audio
      video.muted = true;
      video.autoplay = true;

      // we need to wait for `loadeddata` instead of `loadedmetadata` because audioTracks and videoTracks are not available until then
      video.onloadeddata = async () => {
        const duration = video.duration; // in seconds
        const width = video.videoWidth;
        const height = video.videoHeight;

        // Attempt to extract codec information
        let videoCodec = "";
        let audioCodec = "";
        if (video.videoTracks && video.videoTracks.length > 0) {
          videoCodec = video.videoTracks[0].label || ""; // This is not always reliable
        }
        if (video.audioTracks && video.audioTracks.length > 0) {
          audioCodec = video.audioTracks[0].label || ""; // This is not always reliable
        }

        const hasAudio =
          Boolean(video.audioTracks && video.audioTracks.length) ||
          video.mozHasAudio ||
          Boolean(video.webkitAudioDecodedByteCount);

        let fileSize = 0;
        try {
          fileSize = await this.getFileSize(sourceFilename, options);
        } catch (error) {
          console.error("Error fetching file size:", error);
        }

        // just an estimate by formula Bitrate (Bps) = (File Size (in kilobytes) / Duration (in seconds)) * 8
        const bitRate =
          fileSize && duration ? Math.floor(fileSize / duration) : 0;

        video.remove();

        let audioChannels = 0;
        let audioSampleRate = 0;

        try {
          const audioBuffer = await this.getAudioBuffer(sourceFilename);
          audioChannels = audioBuffer.numberOfChannels;
          audioSampleRate = audioBuffer.sampleRate;
        } catch (error) {
          console.error("Error fetching audio buffer:", error);
        }

        let fps = 0;
        try {
          fps = this.getVideoFrameRate(video);
        } catch {
          // Ignore
        }

        resolve({
          duration,
          width,
          height,
          bitRate,
          fileSize,
          hasAudio,
          audioSampleRate, // Not available
          audioChannels, // Not available
          isHDR: null, // Not available
          audioCodec,
          codec: videoCodec,
          fps, // Not available
          orientation: width >= height ? "Landscape" : "Portrait",
        });
      };

      video.onerror = () => {
        reject(new Error("Failed to load video metadata"));
      };

      video.src = sourceFilename; // Set the source of the video
    });
  },
};
