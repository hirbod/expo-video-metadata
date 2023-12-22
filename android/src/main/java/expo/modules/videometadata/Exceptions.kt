package expo.modules.videometadata

import expo.modules.kotlin.exception.CodedException

class VideoFileException :
  CodedException("Can't read file")

class FilePermissionsModuleNotFound :
  CodedException("File permissions module not found")