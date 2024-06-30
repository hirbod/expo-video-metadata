package expo.modules.videometadata

import android.media.MediaMetadataRetriever
import android.net.Uri
import android.util.Log
import android.webkit.URLUtil
import expo.modules.core.errors.ModuleDestroyedException
import expo.modules.interfaces.filesystem.Permission
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File
import android.media.MediaExtractor
import android.media.MediaFeature
import android.media.MediaFormat
import java.math.BigDecimal
import java.math.RoundingMode

class ExpoVideoMetadataModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private val moduleCoroutineScope = CoroutineScope(Dispatchers.IO)

  override fun definition() = ModuleDefinition {
    Name("ExpoVideoMetadata")

    AsyncFunction("getVideoInfo") { sourceFilename: String, options: ExpoVideoMetadataOptions, promise: Promise ->
      if (URLUtil.isFileUrl(sourceFilename) && !isAllowedToRead(Uri.decode(sourceFilename).replace("file://", ""))) {
        throw VideoFileException()
      }

      withModuleScope(promise) {
        try {
          val retriever = MediaMetadataRetriever()
          val extractor = MediaExtractor()

          var fileSize: Long? = null

          if (URLUtil.isFileUrl(sourceFilename)) {
            retriever.setDataSource(Uri.decode(sourceFilename).replace("file://", ""))
            extractor.setDataSource(Uri.decode(sourceFilename).replace("file://", ""))
            fileSize = File(sourceFilename.replace("file://", "")).length()
          } else if (URLUtil.isContentUrl(sourceFilename)) {
            val fileUri = Uri.parse(sourceFilename)
            fileSize = File(sourceFilename).length()
            context.contentResolver.openFileDescriptor(fileUri, "r")?.use { parcelFileDescriptor ->
              retriever.setDataSource(parcelFileDescriptor.fileDescriptor)
              extractor.setDataSource(parcelFileDescriptor.fileDescriptor)
            }
          } else {
            retriever.setDataSource(sourceFilename, options.headers)
            extractor.setDataSource(sourceFilename, options.headers)
          }

          // extract metadata
          val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
          val duration = BigDecimal(durationMs)
            .divide(BigDecimal(1000), 15, RoundingMode.HALF_UP)
            .toDouble()

          val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
          val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
          val bitrate = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toIntOrNull()
          val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull()
          val hasAudio = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) != null

          val colorTransfer = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_COLOR_TRANSFER)?.toIntOrNull()
          var isHDR: Boolean? = null
          if (colorTransfer != null) {
            isHDR = colorTransfer == MediaFormat.COLOR_TRANSFER_ST2084 || colorTransfer == MediaFormat.COLOR_TRANSFER_HLG
          }

          // Extract GPS location
          val location = extractGPSLocation(retriever)

          // release
          retriever.release()

          // Additional metadata can be extracted here
          var audioChannels: Int? = null
          var audioSampleRate: Int? = null
          var audioCodec: String? = null
          var videoCodec: String? = null
          var frameRate: Float? = null

          val numTracks = extractor.trackCount
          for (i in 0 until numTracks) {
            val format = extractor.getTrackFormat(i)
            val mimeType = format.getString(MediaFormat.KEY_MIME) ?: continue
            if (mimeType.startsWith("audio/")) {
              audioChannels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
              audioSampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
              audioCodec = mapMimeTypeToCodecName(mimeType)
            } else if (mimeType.startsWith("video/")) {
              videoCodec = mapMimeTypeToCodecName(mimeType)

              // extract video frameRate
              if (format.containsKey(MediaFormat.KEY_FRAME_RATE)) {
                frameRate = try {
                  // Try to get frame rate as Integer and convert to Float
                  format.getInteger(MediaFormat.KEY_FRAME_RATE).toFloat()
                } catch (e: Exception) {
                  // If Integer retrieval fails, try as Float
                  format.getFloat(MediaFormat.KEY_FRAME_RATE)
                }
              }
            }
          }

          extractor.release()


          promise.resolve(
            mapOf(
              "audioChannels" to audioChannels,
              "duration" to duration,
              "width" to width,
              "height" to height,
              "bitrate" to bitrate,
              "fileSize" to fileSize,
              "hasAudio" to hasAudio,
              "isHDR" to isHDR,
              "audioCodec" to audioCodec,
              "orientation" to getOrientation(rotation),
              "audioSampleRate" to audioSampleRate,
              "audioCodec" to audioCodec,
              "codec" to videoCodec,
              "fps" to frameRate,
              "location" to location
            )
          )
        } catch (e: Exception) {
          Log.e(TAG, "Error retrieving video metadata: ${e.message}", e)
          promise.reject(ERROR_TAG, "Failed to retrieve video metadata", e)
        }
      }
    }


    OnDestroy {
      try {
        moduleCoroutineScope.cancel(ModuleDestroyedException())
      } catch (e: IllegalStateException) {
        Log.e(TAG, "The scope does not have a job in it")
      }
    }
  }

  private fun extractGPSLocation(retriever: MediaMetadataRetriever): Map<String, Double>? {
    val locationString = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_LOCATION)
    Log.d(TAG, "Raw location string: $locationString")

    if (locationString != null) {
      // Remove the leading "+" and trailing "/"
      val cleanedString = locationString.trim('+', '/')

      // Split the string into components
      val parts = cleanedString.split("+")

      if (parts.size >= 2) {
        val latitude = parts[0].toDoubleOrNull()
        val longitude = parts[1].toDoubleOrNull()
        val altitude = if (parts.size >= 3) parts[2].toDoubleOrNull() else null

        if (latitude != null && longitude != null) {
          Log.d(TAG, "Parsed location: lat=$latitude, lon=$longitude, alt=$altitude")
          return buildMap {
            put("latitude", latitude)
            put("longitude", longitude)
            if (altitude != null) {
              put("altitude", altitude)
            }
          }
        } else {
          Log.w(TAG, "Failed to parse GPS coordinates from location string")
        }
      } else {
        Log.w(TAG, "Invalid GPS location format in metadata")
      }
    } else {
      Log.i(TAG, "GPS location not found in video metadata")
    }

    return null
  }

  private fun isAllowedToRead(url: String): Boolean {
    val permissionModuleInterface = appContext.filePermission
      ?: throw FilePermissionsModuleNotFound()
    return permissionModuleInterface.getPathPermissions(context, url).contains(Permission.READ)
  }

  private fun getOrientation(rotation: Int?): String {
    return when (rotation) {
      0 -> "LandscapeRight"
      90 -> "Portrait"
      180 -> "LandscapeLeft"
      270 -> "PortraitUpsideDown"
      else -> "LandscapeRight" // Default or unknown rotation
    }
  }


  private fun mapMimeTypeToCodecName(mimeType: String): String {
    return when {
      mimeType.startsWith("audio/") -> {
        when {
          mimeType.contains("mp4a-latm") -> "aac" // AAC Audio
          mimeType.contains("ac3") -> "ac3" // AC3 Audio
          mimeType.contains("opus") -> "opus" // Opus Audio
          mimeType.contains("vorbis") -> "vorbis" // Vorbis Audio
          mimeType.contains("flac") -> "flac" // FLAC Audio
          // Add more audio mappings as needed
          else -> mimeType.substringAfter("audio/")
        }
      }
      mimeType.startsWith("video/") -> {
        when {
          mimeType.contains("avc") || mimeType.contains("h264") -> "avc1" // H.264/AVC Video
          mimeType.contains("hev") || mimeType.contains("h265") -> "hev1" // H.265/HEVC Video
          mimeType.contains("vp9") -> "vp9" // VP9 Video
          mimeType.contains("vp8") -> "vp8" // VP8 Video
          mimeType.contains("mp4v-es") -> "mp4v" // MPEG-4 Video
          // Add more video mappings as needed
          else -> mimeType.substringAfter("video/")
        }
      }
      else -> mimeType
    }
  }


  private inline fun withModuleScope(promise: Promise, crossinline block: () -> Unit) = moduleCoroutineScope.launch {
    try {
      block()
    } catch (e: CodedException) {
      promise.reject(e)
    } catch (e: ModuleDestroyedException) {
      promise.reject(TAG, "ExpoVideoMetadata module destroyed", e)
    }
  }

  companion object {
    private const val TAG = "ExpoVideoMetadata"
    private const val ERROR_TAG = "E_VIDEO_METADATA"
  }
}
