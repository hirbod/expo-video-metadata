import type { VideoInfoOptions, VideoSource } from '../../ExpoVideoMetadata.types'

export const getQuickFileSize = async (
  source: VideoSource,
  options: VideoInfoOptions = {}
): Promise<number> => {
  if (source instanceof File || source instanceof Blob) {
    return source.size
  }

  if (typeof source === 'string') {
    if (source.startsWith('data:')) {
      const base64Data = source.replace(/^data:.+;base64,/, '')
      return atob(base64Data).length
    }

    try {
      const response = await fetch(source, { method: 'HEAD', ...options })
      const size = response.headers.get('Content-Length')
      return size ? Number.parseInt(size, 10) : 0
    } catch (error) {
      console.debug('Error getting file size:', error)
      return 0
    }
  }

  return 0
}
