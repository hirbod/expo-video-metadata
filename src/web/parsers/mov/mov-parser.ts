// mov-parser.ts
import type {
  MP4Box,
  ParsedVideoMetadata,
  VideoTrackMetadata,
} from '../../../ExpoVideoMetadata.types'
import { BinaryReaderImpl } from '../../binary-reader'
import { MP4ColorParser } from '../mp4/mp4-color'
import { MP4Parser } from '../mp4/mp4-parser'

/**
 * Parser for QuickTime MOV container format.
 * Extends MP4Parser to handle MOV-specific boxes and metadata.
 */
export class MOVParser extends MP4Parser {
  // Additional QuickTime specific atoms
  private static readonly QT_ATOMS = {
    CLAP: 'clap', // Clean aperture - defines visible image area
    TAPT: 'tapt', // Track aperture mode - defines display dimensions
    FIEL: 'fiel', // Field handling - defines interlacing mode
    CTMD: 'ctmd', // Content mode dimensions - defines content display size
    PASP: 'pasp', // Pixel aspect ratio - defines pixel shape
  }

  // Debug flag that can be set based on environment
  private static readonly DEBUG = process.env.NODE_ENV !== 'production'

  /**
   * Parses MOV container metadata.
   * @returns Promise resolving to video metadata including MOV-specific information
   */
  public async parse(): Promise<ParsedVideoMetadata> {
    const metadata = await super.parse()
    if (MOVParser.DEBUG) {
      console.debug('MOV metadata:', metadata)
    }
    return {
      ...metadata,
      container: 'mov',
    }
  }

  /**
   * Parses video track information including MOV-specific metadata.
   * @param trak - The video track box to parse
   * @param moovBoxes - Array of boxes from the movie container
   * @returns Promise resolving to video track metadata
   */
  protected async parseVideoTrack(trak: MP4Box, moovBoxes: MP4Box[]): Promise<VideoTrackMetadata> {
    // Get base metadata from MP4 parser
    const baseMetadata = await super.parseVideoTrack(trak, moovBoxes)
    if (MOVParser.DEBUG) {
      console.debug('Base metadata from MOV:', baseMetadata)
    }

    // Parse QuickTime specific boxes by traversing the hierarchy
    const trakBoxes = await this.parseBoxes(trak.data!)
    const mdia = this.findBox(trakBoxes, 'mdia')
    if (!mdia) {
      if (MOVParser.DEBUG) {
        console.debug('No mdia box found')
      }
      return baseMetadata
    }

    const mdiaBoxes = await this.parseBoxes(mdia.data!)
    const minf = this.findBox(mdiaBoxes, 'minf')
    if (!minf) {
      if (MOVParser.DEBUG) {
        console.debug('No minf box found')
      }
      return baseMetadata
    }

    const minfBoxes = await this.parseBoxes(minf.data!)
    const stbl = this.findBox(minfBoxes, 'stbl')
    if (!stbl) {
      if (MOVParser.DEBUG) {
        console.debug('No stbl box found')
      }
      return baseMetadata
    }

    const stblBoxes = await this.parseBoxes(stbl.data!)
    const stsd = this.findBox(stblBoxes, 'stsd')

    if (MOVParser.DEBUG) {
      console.debug('Found STSD box:', stsd ? { size: stsd.size } : 'not found')
    }

    if (stsd) {
      const stsdBoxes = await this.parseBoxes(stsd.data!)
      if (MOVParser.DEBUG) {
        console.debug(
          'STSD boxes:',
          stsdBoxes.map((b) => ({ type: b.type, size: b.size }))
        )
      }

      // Find video format box
      const videoBox = this.findVideoBox(stsdBoxes)
      if (videoBox) {
        if (MOVParser.DEBUG) {
          console.debug('Found video format box:', { type: videoBox.type, size: videoBox.size })
        }

        // For ProRes, QuickTime atoms are stored as raw data after the format header
        if (videoBox.type.startsWith('ap')) {
          // ProRes types all start with 'ap'
          const reader = new BinaryReaderImpl(videoBox.data!)

          // Log the raw data for debugging
          if (MOVParser.DEBUG) {
            console.debug(
              'ProRes box raw data:',
              Array.from(reader.data.slice(0, Math.min(100, reader.data.length))).map(
                (b) => '0x' + b.toString(16).padStart(2, '0')
              )
            )
          }

          // Skip version and flags (4 bytes)
          reader.skip(4) // uint8 version + uint24 flags

          // Skip data reference index (4 bytes)
          reader.skip(4) // uint32 data reference index

          // Skip pre-defined (4 bytes)
          reader.skip(4) // Reserved for QuickTime

          // Skip format identifier (4 bytes - 'FFMP')
          reader.skip(4) // Format type identifier

          // Skip format info (8 bytes)
          reader.skip(8) // Format specific info

          // Read width and height (2 bytes each)
          const width = reader.readUint16()
          const height = reader.readUint16()
          if (MOVParser.DEBUG) {
            console.debug('ProRes dimensions:', { width, height })
          }

          // Skip resolution (8 bytes)
          reader.skip(8) // Fixed-point 16.16 horizontal and vertical resolution

          // Skip data size (4 bytes)
          reader.skip(4) // uint32 data size

          // Skip frame count (2 bytes)
          reader.skip(2) // uint16 frame count per sample

          // Skip compressor name (32 bytes)
          reader.skip(32) // Pascal string[32] compressor name

          // Skip depth (2 bytes)
          reader.skip(2) // uint16 depth/bits per pixel

          // Skip color table ID (2 bytes)
          reader.skip(2) // int16 color table ID, -1 means no color table

          // Now we should be at the start of the QuickTime atoms
          const foundClap = false
          const foundCtmd = false
          while (reader.remaining() >= 8) {
            const startOffset = reader.offset
            const size = reader.readUint32()

            // Validate size
            if (size < 8 || size > reader.remaining() + 4) {
              if (MOVParser.DEBUG) {
                console.debug(
                  'Invalid atom size:',
                  size,
                  'remaining:',
                  reader.remaining(),
                  'at offset:',
                  startOffset
                )
              }
              break
            }

            const type = reader.readString(4)
            if (MOVParser.DEBUG) {
              console.debug('Found QuickTime atom:', { size, type, offset: startOffset })
            }

            // Create box from atom data
            const box: MP4Box = {
              type,
              size,
              data: reader.data.subarray(reader.offset, startOffset + size),
              start: startOffset,
              end: startOffset + size,
            }

            // Handle QuickTime-specific boxes
            switch (type) {
              case MOVParser.QT_ATOMS.CLAP: {
                if (MOVParser.DEBUG) {
                  console.debug('Found CLAP box in ProRes')
                }
                const { width, height } = this.parseClap(box)
                if (width && height) {
                  baseMetadata.displayAspectWidth = width
                  baseMetadata.displayAspectHeight = height
                } else {
                  if (MOVParser.DEBUG) {
                    console.debug('CLAP box found but dimensions could not be parsed')
                  }
                }
                break
              }
              case MOVParser.QT_ATOMS.FIEL: {
                if (MOVParser.DEBUG) {
                  console.debug('Found FIEL box in ProRes')
                }
                const fielInfo = this.parseFiel(box)
                if (fielInfo) {
                  if (MOVParser.DEBUG) {
                    console.debug('Field handling:', fielInfo)
                  }
                }
                break
              }
              case MOVParser.QT_ATOMS.CTMD: {
                if (MOVParser.DEBUG) {
                  console.debug('Found CTMD box in ProRes')
                }
                const ctmdInfo = this.parseCtmd(box)
                if (ctmdInfo?.width && ctmdInfo?.height) {
                  if (MOVParser.DEBUG) {
                    console.debug('Content mode dimensions:', ctmdInfo)
                  }
                } else {
                  if (MOVParser.DEBUG) {
                    console.debug('CTMD box found but dimensions could not be parsed')
                  }
                }
                break
              }
              case MOVParser.QT_ATOMS.PASP: {
                if (MOVParser.DEBUG) {
                  console.debug('Found PASP box in ProRes')
                }
                const { hSpacing, vSpacing } = this.parsePasp(box)
                if (hSpacing && vSpacing) {
                  const pixelAspectRatio = hSpacing / vSpacing
                  baseMetadata.displayAspectWidth = Math.round(
                    baseMetadata.width * pixelAspectRatio
                  )
                  baseMetadata.displayAspectHeight = baseMetadata.height
                }
                break
              }
              case 'colr':
              case 'clli':
              case 'mdcv': {
                // Pass color-related boxes to MP4ColorParser
                const colorInfo = MP4ColorParser.parseColorInfo(box.data!)
                if (colorInfo.matrixCoefficients || colorInfo.fullRange !== null) {
                  if (!baseMetadata.colorInfo) {
                    baseMetadata.colorInfo = colorInfo
                  } else {
                    // Merge with existing color info, preserving non-null values
                    baseMetadata.colorInfo = {
                      matrixCoefficients:
                        colorInfo.matrixCoefficients || baseMetadata.colorInfo.matrixCoefficients,
                      transferCharacteristics:
                        colorInfo.transferCharacteristics ||
                        baseMetadata.colorInfo.transferCharacteristics,
                      primaries: colorInfo.primaries || baseMetadata.colorInfo.primaries,
                      fullRange:
                        colorInfo.fullRange !== null
                          ? colorInfo.fullRange
                          : baseMetadata.colorInfo.fullRange,
                    }
                  }
                }
                break
              }
            }

            // Skip to end of atom
            reader.seek(startOffset + size)
          }

          if (!foundClap) {
            if (MOVParser.DEBUG) {
              console.debug('No CLAP box found in ProRes')
            }
          }
          if (!foundCtmd) {
            if (MOVParser.DEBUG) {
              console.debug('No CTMD box found in ProRes')
            }
          }
        } else {
          // For non-ProRes formats, parse boxes normally
          const videoBoxes = await this.parseBoxes(videoBox.data!)
          if (MOVParser.DEBUG) {
            console.debug(
              'Video format boxes:',
              videoBoxes.map((b) => ({ type: b.type, size: b.size }))
            )
          }

          // Look for QuickTime-specific boxes
          const clap = this.findBox(videoBoxes, MOVParser.QT_ATOMS.CLAP)
          if (clap) {
            if (MOVParser.DEBUG) {
              console.debug('Found CLAP box')
            }
            const { width, height } = this.parseClap(clap)
            if (width && height) {
              baseMetadata.displayAspectWidth = width
              baseMetadata.displayAspectHeight = height
            }
          } else {
            if (MOVParser.DEBUG) {
              console.debug('No CLAP box found in video format box')
            }
          }

          const fiel = this.findBox(videoBoxes, MOVParser.QT_ATOMS.FIEL)
          if (fiel) {
            if (MOVParser.DEBUG) {
              console.debug('Found FIEL box')
            }
            // Field handling could affect display, but we currently don't use this
          } else {
            if (MOVParser.DEBUG) {
              console.debug('No FIEL box found in video format box')
            }
          }

          const ctmd = this.findBox(videoBoxes, MOVParser.QT_ATOMS.CTMD)
          if (ctmd) {
            if (MOVParser.DEBUG) {
              console.debug('Found CTMD box')
            }
            // Content mode dimensions could provide additional display info
          } else {
            if (MOVParser.DEBUG) {
              console.debug('No CTMD box found in video format box')
            }
          }

          const pasp = this.findBox(videoBoxes, MOVParser.QT_ATOMS.PASP)
          if (pasp) {
            if (MOVParser.DEBUG) {
              console.debug('Found PASP box')
            }
            const { hSpacing, vSpacing } = this.parsePasp(pasp)
            if (hSpacing && vSpacing) {
              const pixelAspectRatio = hSpacing / vSpacing
              baseMetadata.displayAspectWidth = Math.round(baseMetadata.width * pixelAspectRatio)
              baseMetadata.displayAspectHeight = baseMetadata.height
            }
          }
        }
      }

      // Parse track aperture mode dimensions
      const tapt = this.findBox(trakBoxes, MOVParser.QT_ATOMS.TAPT)
      if (tapt) {
        if (MOVParser.DEBUG) {
          console.debug('Found TAPT box')
        }
        const { width, height } = await this.parseTapt(tapt)
        if (width && height) {
          // TAPT takes precedence over CLAP if both exist
          baseMetadata.displayAspectWidth = width
          baseMetadata.displayAspectHeight = height
        }
      }
    }

    return baseMetadata
  }

  /**
   * Parses Clean Aperture (CLAP) box to get display dimensions.
   * Values are stored as rational numbers (N/D format).
   * @param clap - The CLAP box to parse
   * @returns Object containing width and height if valid
   */
  private parseClap(clap: MP4Box): { width?: number; height?: number } {
    if (MOVParser.DEBUG) {
      console.debug('Parsing CLAP box')
    }
    const reader = new BinaryReaderImpl(clap.data!)

    // All values are 32-bit unsigned integers representing numerator/denominator pairs
    const cleanApertureWidthN = reader.readUint32() // Width numerator
    const cleanApertureWidthD = reader.readUint32() // Width denominator
    const cleanApertureHeightN = reader.readUint32() // Height numerator
    const cleanApertureHeightD = reader.readUint32() // Height denominator
    const horizOffN = reader.readUint32() // Horizontal offset numerator
    const horizOffD = reader.readUint32() // Horizontal offset denominator
    const vertOffN = reader.readUint32() // Vertical offset numerator
    const vertOffD = reader.readUint32() // Vertical offset denominator

    if (MOVParser.DEBUG) {
      console.debug('CLAP values:', {
        width: {
          numerator: cleanApertureWidthN,
          denominator: cleanApertureWidthD,
          value: cleanApertureWidthD !== 0 ? cleanApertureWidthN / cleanApertureWidthD : 'invalid',
        },
        height: {
          numerator: cleanApertureHeightN,
          denominator: cleanApertureHeightD,
          value:
            cleanApertureHeightD !== 0 ? cleanApertureHeightN / cleanApertureHeightD : 'invalid',
        },
        horizontalOffset: {
          numerator: horizOffN,
          denominator: horizOffD,
          value: horizOffD !== 0 ? horizOffN / horizOffD : 'invalid',
        },
        verticalOffset: {
          numerator: vertOffN,
          denominator: vertOffD,
          value: vertOffD !== 0 ? vertOffN / vertOffD : 'invalid',
        },
      })
    }

    if (cleanApertureWidthD !== 0 && cleanApertureHeightD !== 0) {
      return {
        width: Math.round(cleanApertureWidthN / cleanApertureWidthD),
        height: Math.round(cleanApertureHeightN / cleanApertureHeightD),
      }
    }

    return {}
  }

  /**
   * Parses Pixel Aspect Ratio (PASP) box.
   * Values represent the relative width and height of a pixel.
   * @param pasp - The PASP box to parse
   * @returns Object containing horizontal and vertical spacing if valid
   */
  private parsePasp(pasp: MP4Box): { hSpacing?: number; vSpacing?: number } {
    if (MOVParser.DEBUG) {
      console.debug('Parsing PASP box')
    }
    const reader = new BinaryReaderImpl(pasp.data!)

    // Read horizontal and vertical spacing as 32-bit unsigned integers
    const hSpacing = reader.readUint32() // Horizontal pixels per unit
    const vSpacing = reader.readUint32() // Vertical pixels per unit
    if (MOVParser.DEBUG) {
      console.debug('PASP values:', { hSpacing, vSpacing })
    }

    if (vSpacing !== 0) {
      const ratio = hSpacing / vSpacing // Pixel aspect ratio (width/height)
      if (MOVParser.DEBUG) {
        console.debug('PASP pixel aspect ratio:', ratio)
      }
      return { hSpacing, vSpacing }
    }

    return {}
  }

  /**
   * Parses Track Aperture (TAPT) box to get display dimensions.
   * Values are stored in fixed-point 16.16 format.
   * @param tapt - The TAPT box to parse
   * @returns Promise resolving to width and height if valid
   */
  private async parseTapt(tapt: MP4Box): Promise<{ width?: number; height?: number }> {
    if (MOVParser.DEBUG) {
      console.debug('Parsing TAPT box')
    }
    const taptBoxes = await this.parseBoxes(tapt.data!)
    if (MOVParser.DEBUG) {
      console.debug(
        'TAPT boxes:',
        taptBoxes.map((b) => ({ type: b.type, size: b.size }))
      )
    }

    // Look for clef (clean aperture dimensions) box
    const clef = this.findBox(taptBoxes, 'clef')
    if (!clef?.data || clef.data.length < 12) {
      // clef box must be at least 12 bytes (4 for version/flags + 8 for dimensions)
      return {}
    }

    const reader = new BinaryReaderImpl(clef.data)

    // Version (1 byte) and flags (3 bytes)
    const version = reader.readUint8() // Version of the clef box
    reader.skip(3) // Reserved flags
    if (MOVParser.DEBUG) {
      console.debug('CLEF version:', version)
    }

    // Fixed point 16.16 values for dimensions
    const width = reader.readUint32() // Upper 16 bits = integer part, lower 16 bits = fraction
    const height = reader.readUint32() // Upper 16 bits = integer part, lower 16 bits = fraction

    // Convert from fixed point to integer by shifting right 16 bits
    const displayWidth = width >> 16 // Divide by 2^16 to get integer part
    const displayHeight = height >> 16 // Divide by 2^16 to get integer part

    if (MOVParser.DEBUG) {
      console.debug('CLEF dimensions:', {
        raw: { width, height },
        display: { displayWidth, displayHeight },
      })
    }

    return {
      width: displayWidth,
      height: displayHeight,
    }
  }

  /**
   * Parses Field Handling (FIEL) box to get interlacing information.
   * @param fiel - The FIEL box to parse
   * @returns Object containing fields count and dominance, or null if invalid
   */
  private parseFiel(fiel: MP4Box): { fields: number; dominance: number } | null {
    if (!fiel.data || fiel.data.length < 2) return null // FIEL box must be at least 2 bytes

    const reader = new BinaryReaderImpl(fiel.data)
    const fields = reader.readUint8() // 1 = progressive, 2 = interlaced
    const dominance = reader.readUint8() // For interlaced: 0 = top-field first, 1 = bottom-field first

    if (MOVParser.DEBUG) {
      console.debug('FIEL values:', {
        fields,
        dominance,
        description: `${fields === 1 ? 'Progressive' : 'Interlaced'}, ${
          fields === 1 ? 'N/A' : dominance === 0 ? 'Top field first' : 'Bottom field first'
        }`,
      })
    }

    return { fields, dominance }
  }

  /**
   * Parses Content Mode Dimensions (CTMD) box.
   * Values are stored in fixed-point 16.16 format.
   * @param ctmd - The CTMD box to parse
   * @returns Object containing width and height if valid, null if invalid
   */
  private parseCtmd(ctmd: MP4Box): { width?: number; height?: number } | null {
    if (!ctmd.data || ctmd.data.length < 12) return null // CTMD box must be at least 12 bytes (4 for version/flags + 8 for dimensions)

    const reader = new BinaryReaderImpl(ctmd.data)

    // Version (1 byte) and flags (3 bytes)
    const version = reader.readUint8()
    reader.skip(3) // Reserved flags

    // Content mode dimensions are in fixed point 16.16
    const width = reader.readUint32() // Upper 16 bits = integer part, lower 16 bits = fraction
    const height = reader.readUint32() // Upper 16 bits = integer part, lower 16 bits = fraction

    // Convert from fixed point to integer by shifting right 16 bits
    const displayWidth = width >> 16 // Divide by 2^16 to get integer part
    const displayHeight = height >> 16 // Divide by 2^16 to get integer part

    if (MOVParser.DEBUG) {
      console.debug('CTMD values:', {
        version,
        raw: { width, height },
        display: { displayWidth, displayHeight },
      })
    }

    return {
      width: displayWidth,
      height: displayHeight,
    }
  }
}
