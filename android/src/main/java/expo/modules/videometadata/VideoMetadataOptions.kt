package expo.modules.videometadata

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

data class ExpoVideoMetadataOptions(
  @Field
  val headers: Map<String, String> = emptyMap()
) : Record
