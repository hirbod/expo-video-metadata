package expo.modules.videometadata

import android.media.MediaMetadataRetriever
import android.net.Uri
import android.util.Log
import android.webkit.URLUtil
import expo.modules.core.errors.ModuleDestroyedException
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.services.FilePermissionService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File
import android.media.MediaExtractor
import android.media.MediaFormat
import java.math.BigDecimal
import java.math.RoundingMode
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.abs

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
          promise.resolve(readVideoMetadata(sourceFilename, options, allowRemoteFallback = true))
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

  private fun readVideoMetadata(
    sourceFilename: String,
    options: ExpoVideoMetadataOptions,
    allowRemoteFallback: Boolean
  ): Map<String, Any?> {
    val retriever = MediaMetadataRetriever()
    val extractor = MediaExtractor()
    var temporaryFile: File? = null

    try {
      var fileSize: Long? = null
      val isRemoteUrl = URLUtil.isNetworkUrl(sourceFilename)

      if (URLUtil.isFileUrl(sourceFilename)) {
        val path = Uri.decode(sourceFilename).replace("file://", "")
        retriever.setDataSource(path)
        extractor.setDataSource(path)
        fileSize = File(path).length()
      } else if (URLUtil.isContentUrl(sourceFilename)) {
        val fileUri = Uri.parse(sourceFilename)
        fileSize = File(sourceFilename).length()
        context.contentResolver.openFileDescriptor(fileUri, "r")?.use { parcelFileDescriptor ->
          retriever.setDataSource(parcelFileDescriptor.fileDescriptor)
          extractor.setDataSource(parcelFileDescriptor.fileDescriptor)
        }
      } else if (isRemoteUrl) {
        retriever.setDataSource(sourceFilename, options.headers)
        extractor.setDataSource(sourceFilename, options.headers)
      } else {
        retriever.setDataSource(sourceFilename)
        extractor.setDataSource(sourceFilename)
        fileSize = File(sourceFilename).length()
      }

      val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
      val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
      val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
      val numTracks = extractor.trackCount

      if (isRemoteUrl && allowRemoteFallback && durationMs == 0L && width == null && height == null && numTracks == 0) {
        retriever.release()
        extractor.release()
        temporaryFile = downloadRemoteVideo(sourceFilename, options)
        return readVideoMetadata(temporaryFile.absolutePath, options, allowRemoteFallback = false)
      }

      val duration = BigDecimal(durationMs)
        .divide(BigDecimal(1000), 15, RoundingMode.HALF_UP)
        .toDouble()

      val bitrate = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toIntOrNull()
      val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull()
      val hasAudio = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) != null

      val colorTransfer = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_COLOR_TRANSFER)?.toIntOrNull()
      var isHDR: Boolean? = null
      if (colorTransfer != null) {
        isHDR = colorTransfer == MediaFormat.COLOR_TRANSFER_ST2084 || colorTransfer == MediaFormat.COLOR_TRANSFER_HLG
      }

      val location = extractGPSLocation(retriever)
      val orientation = getOrientation(rotation, width, height)

      var audioChannels: Int? = null
      var audioSampleRate: Int? = null
      var audioCodec: String? = null
      var videoCodec: String? = null
      var frameRate: Float? = null

      for (i in 0 until numTracks) {
        val format = extractor.getTrackFormat(i)
        val mimeType = format.getString(MediaFormat.KEY_MIME) ?: continue
        if (mimeType.startsWith("audio/")) {
          audioChannels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
          audioSampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
          audioCodec = mapMimeTypeToCodecName(mimeType)
        } else if (mimeType.startsWith("video/")) {
          videoCodec = mapMimeTypeToCodecName(mimeType)

          if (format.containsKey(MediaFormat.KEY_FRAME_RATE)) {
            frameRate = try {
              format.getInteger(MediaFormat.KEY_FRAME_RATE).toFloat()
            } catch (e: Exception) {
              format.getFloat(MediaFormat.KEY_FRAME_RATE)
            }
          }
        }
      }

      return mapOf(
        "audioChannels" to audioChannels,
        "duration" to duration,
        "width" to width,
        "height" to height,
        "bitrate" to bitrate,
        "fileSize" to fileSize,
        "hasAudio" to hasAudio,
        "isHDR" to isHDR,
        "audioCodec" to audioCodec,
        "orientation" to orientation,
        "naturalOrientation" to if (width != null && height != null && width != 0 && height != 0) {
          if (height > width) "Portrait" else "Landscape"
        } else "Landscape",
        "aspectRatio" to if (width != null && height != null && height != 0) {
          width.toDouble() / height.toDouble()
        } else null,
        "is16_9" to if (width != null && height != null && height != 0) {
          abs((width.toDouble() / height.toDouble()) - 16.0/9.0) < 0.01
        } else false,
        "audioSampleRate" to audioSampleRate,
        "audioCodec" to audioCodec,
        "codec" to videoCodec,
        "fps" to frameRate,
        "location" to location
      )
    } finally {
      try {
        retriever.release()
      } catch (_: Exception) {
      }
      try {
        extractor.release()
      } catch (_: Exception) {
      }
      temporaryFile?.delete()
    }
  }

  private fun downloadRemoteVideo(sourceFilename: String, options: ExpoVideoMetadataOptions): File {
    val connection = URL(sourceFilename).openConnection()
    for ((header, value) in options.headers) {
      connection.setRequestProperty(header, value)
    }

    if (connection is HttpURLConnection) {
      connection.connect()
      if (connection.responseCode !in 200..299) {
        throw RemoteVideoDownloadException(sourceFilename, connection.responseCode)
      }
    }

    val extension = Uri.parse(sourceFilename).lastPathSegment
      ?.substringAfterLast('.', "mp4")
      ?.takeIf { it.isNotBlank() }
      ?: "mp4"
    val temporaryFile = File.createTempFile("expo-video-metadata-", ".$extension", context.cacheDir)

    try {
      connection.getInputStream().use { input ->
        temporaryFile.outputStream().use { output ->
          input.copyTo(output)
        }
      }
    } catch (e: Exception) {
      temporaryFile.delete()
      throw e
    }

    return temporaryFile
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
    return permissionModuleInterface.getPathPermissions(context, url).contains(FilePermissionService.Permission.READ)
  }

  private fun getOrientation(rotation: Int?, width: Int?, height: Int?): String {
    // If dimensions are null or zero, default to LandscapeRight
    if (width == null || height == null || width == 0 || height == 0) {
      return "LandscapeRight"
    }

    val isNaturallyPortrait = height > width

    // If no rotation, use natural orientation
    if (rotation == null) {
      return if (isNaturallyPortrait) "Portrait" else "LandscapeRight"
    }

    // Normalize rotation to 0-360
    val normalizedRotation = ((rotation % 360) + 360) % 360

    return when (normalizedRotation) {
      0 -> if (isNaturallyPortrait) "Portrait" else "LandscapeRight"
      90 -> "Portrait"
      180 -> if (isNaturallyPortrait) "PortraitUpsideDown" else "LandscapeLeft"
      270 -> "PortraitUpsideDown"
      else -> if (isNaturallyPortrait) "Portrait" else "LandscapeRight"
    }
  }

  private fun mapMimeTypeToCodecName(mimeType: String): String {
    return when {
      mimeType.startsWith("audio/") -> {
        when {
          mimeType.contains("mp4a-latm") -> "aac"
          mimeType.contains("ac3") -> "ac3"
          mimeType.contains("opus") -> "opus"
          mimeType.contains("vorbis") -> "vorbis"
          mimeType.contains("flac") -> "flac"
          else -> mimeType.substringAfter("audio/")
        }
      }
      mimeType.startsWith("video/") -> {
        when {
          mimeType.contains("avc") || mimeType.contains("h264") -> "avc1"
          mimeType.contains("hev") || mimeType.contains("h265") -> "hev1"
          mimeType.contains("vp9") -> "vp9"
          mimeType.contains("vp8") -> "vp8"
          mimeType.contains("mp4v-es") -> "mp4v"
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
