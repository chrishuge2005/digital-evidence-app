import { supabase } from './supabase';
import * as FileSystem from 'expo-file-system/legacy';
import { EvidenceAttachment } from '../types/evidence';

// Maximum allowed evidence file size: 50 MB
export const MAX_EVIDENCE_FILE_SIZE = 50 * 1024 * 1024;

// Supported evidence file types
const SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
];

export const storageService = {
  /**
   * Validate a local evidence file before upload.
   */
  async validateFile(
    localUri: string,
    fileSize: number,
    mimeType: string
  ): Promise<{ valid: boolean; error?: string }> {
    console.log('========== FILE VALIDATION ==========');
    console.log('Local URI:', localUri);
    console.log('File size:', fileSize);
    console.log('MIME type:', mimeType);

    // -----------------------------------------
    // 1. Validate URI
    // -----------------------------------------
    if (!localUri || typeof localUri !== 'string') {
      return {
        valid: false,
        error: 'Local file URI is missing or invalid.',
      };
    }

    // -----------------------------------------
    // 2. Validate file size
    // -----------------------------------------
    if (fileSize > MAX_EVIDENCE_FILE_SIZE) {
      return {
        valid: false,
        error: 'File size exceeds the 50MB maximum limit.',
      };
    }

    // -----------------------------------------
    // 3. Check whether local file exists
    // -----------------------------------------
    try {
      const fileInfo = await FileSystem.getInfoAsync(localUri);

      console.log('File information:', fileInfo);

      if (!fileInfo.exists) {
        return {
          valid: false,
          error:
            'The selected evidence file does not exist on the device.',
        };
      }

      if (fileInfo.isDirectory) {
        return {
          valid: false,
          error:
            'The selected URI points to a directory instead of a file.',
        };
      }

      // If fileSize was not provided by DocumentPicker,
      // check the actual file size.
      if (
        (!fileSize || fileSize <= 0) &&
        'size' in fileInfo &&
        typeof fileInfo.size === 'number'
      ) {
        if (fileInfo.size > MAX_EVIDENCE_FILE_SIZE) {
          return {
            valid: false,
            error: 'File size exceeds the 50MB maximum limit.',
          };
        }
      }
    } catch (error: any) {
      console.error(
        'FileSystem validation error:',
        error
      );

      return {
        valid: false,
        error:
          `Unable to access the selected evidence file. ` +
          `${error?.message || 'Unknown file system error.'}`,
      };
    }

    // -----------------------------------------
    // 4. Validate MIME type
    // -----------------------------------------
    if (mimeType && mimeType.trim() !== '') {
      const normalizedMimeType =
        mimeType.toLowerCase().trim();

      if (
        !SUPPORTED_MIME_TYPES.includes(
          normalizedMimeType
        )
      ) {
        return {
          valid: false,
          error:
            `Unsupported file format: ${mimeType}`,
        };
      }
    }

    console.log('File validation successful.');

    return {
      valid: true,
    };
  },

  /**
   * Upload an evidence attachment to the
   * private Supabase Storage bucket.
   *
   * Storage structure:
   *
   * evidence-files/
   *   teamId/
   *     evidenceId/
   *       attachmentId_filename
   */
  async uploadAttachmentFile(
    teamId: string,
    evidenceId: string,
    attachment: EvidenceAttachment
  ): Promise<{
    success: boolean;
    storagePath?: string;
    error?: string;
  }> {
    try {
      console.log('');
      console.log('========================================');
      console.log('STARTING EVIDENCE ATTACHMENT UPLOAD');
      console.log('========================================');

      console.log('Team ID:', teamId);
      console.log('Evidence ID:', evidenceId);
      console.log('Attachment:', attachment);

      // -----------------------------------------
      // 1. Validate IDs
      // -----------------------------------------
      if (!teamId) {
        return {
          success: false,
          error: 'Team ID is missing.',
        };
      }

      if (!evidenceId) {
        return {
          success: false,
          error: 'Evidence ID is missing.',
        };
      }

      // -----------------------------------------
      // 2. Validate attachment
      // -----------------------------------------
      if (!attachment) {
        return {
          success: false,
          error: 'Attachment information is missing.',
        };
      }

      if (!attachment.localUri) {
        return {
          success: false,
          error: 'Attachment local URI is missing.',
        };
      }

      // -----------------------------------------
      // 3. Validate local file
      // -----------------------------------------
      const validation =
        await this.validateFile(
          attachment.localUri,
          attachment.fileSize || 0,
          attachment.mimeType || ''
        );

      if (!validation.valid) {
        console.error(
          'File validation failed:',
          validation.error
        );

        return {
          success: false,
          error: validation.error,
        };
      }

      // -----------------------------------------
      // 4. Create safe filename
      // -----------------------------------------
      const originalName =
        attachment.originalName ||
        'evidence_file';

      const safeName = originalName
        .replace(
          /[^a-zA-Z0-9_.-]/g,
          '_'
        )
        .replace(
          /_+/g,
          '_'
        );

      // -----------------------------------------
      // 5. Create deterministic storage path
      // -----------------------------------------
      const storagePath =
        `${teamId}/${evidenceId}/` +
        `${attachment.attachmentId}_${safeName}`;

      console.log(
        'Supabase storage path:',
        storagePath
      );

      // -----------------------------------------
      // 6. Read local file as Base64
      // -----------------------------------------
      console.log(
        'Reading local evidence file...'
      );

      let base64Data: string;

      try {
        base64Data =
          await FileSystem.readAsStringAsync(
            attachment.localUri,
            {
              encoding:
                FileSystem.EncodingType.Base64,
            }
          );
      } catch (error: any) {
        console.error(
          'Failed to read local evidence file:',
          error
        );

        return {
          success: false,
          error:
            `Unable to read the selected evidence file. ` +
            `${error?.message || ''}`,
        };
      }

      if (!base64Data) {
        return {
          success: false,
          error:
            'The selected evidence file is empty or could not be read.',
        };
      }

      console.log(
        'Evidence file successfully read.'
      );

      // -----------------------------------------
      // 7. Convert Base64 to Uint8Array
      // -----------------------------------------
      let bytes: Uint8Array;

      try {
        const binaryString =
          atob(base64Data);

        const length =
          binaryString.length;

        bytes =
          new Uint8Array(length);

        for (
          let i = 0;
          i < length;
          i++
        ) {
          bytes[i] =
            binaryString.charCodeAt(i);
        }
      } catch (error: any) {
        console.error(
          'Base64 conversion error:',
          error
        );

        return {
          success: false,
          error:
            'Failed to convert evidence file into upload format.',
        };
      }

      console.log(
        'File converted to Uint8Array.'
      );

      console.log(
        'Upload size:',
        bytes.length,
        'bytes'
      );

      // -----------------------------------------
      // 8. Upload to Supabase Storage
      // -----------------------------------------
      console.log(
        'Uploading evidence to Supabase Storage...'
      );

      const {
        error: uploadError,
      } = await supabase.storage
        .from('evidence-files')
        .upload(
          storagePath,
          bytes,
          {
            contentType:
              attachment.mimeType ||
              'application/octet-stream',

            upsert: true,
          }
        );

      // -----------------------------------------
      // 9. Handle upload error
      // -----------------------------------------
      if (uploadError) {
        console.error(
          'Supabase Storage upload error:',
          uploadError
        );

        return {
          success: false,
          error:
            uploadError.message ||
            'Supabase Storage upload failed.',
        };
      }

      // -----------------------------------------
      // 10. Upload successful
      // -----------------------------------------
      console.log('');
      console.log(
        '========================================'
      );
      console.log(
        'EVIDENCE ATTACHMENT UPLOAD SUCCESSFUL'
      );
      console.log(
        '========================================'
      );
      console.log(
        'Storage path:',
        storagePath
      );

      return {
        success: true,
        storagePath,
      };
    } catch (error: any) {
      console.error(
        'Unexpected storage upload exception:',
        error
      );

      return {
        success: false,
        error:
          error?.message ||
          'Unexpected storage upload exception occurred.',
      };
    }
  },

  /**
   * Download an evidence attachment from
   * private Supabase Storage to a local URI.
   */
  async downloadAttachmentFile(
    storagePath: string,
    localDestinationUri: string
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      console.log(
        'Downloading evidence:',
        storagePath
      );

      // -----------------------------------------
      // 1. Validate paths
      // -----------------------------------------
      if (!storagePath) {
        return {
          success: false,
          error:
            'Storage path is missing.',
        };
      }

      if (!localDestinationUri) {
        return {
          success: false,
          error:
            'Local destination URI is missing.',
        };
      }

      // -----------------------------------------
      // 2. Download from Supabase
      // -----------------------------------------
      const {
        data,
        error,
      } = await supabase.storage
        .from('evidence-files')
        .download(storagePath);

      if (error) {
        console.error(
          'Supabase download error:',
          error
        );

        return {
          success: false,
          error: error.message,
        };
      }

      if (!data) {
        return {
          success: false,
          error:
            'No file data was returned from Supabase.',
        };
      }

      // -----------------------------------------
      // 3. Convert Blob to Base64
      // -----------------------------------------
      const reader =
        new FileReader();

      return new Promise(
        (resolve) => {
          reader.onloadend =
            async () => {
              try {
                const result =
                  reader.result as string;

                if (!result) {
                  resolve({
                    success: false,
                    error:
                      'Downloaded file data is empty.',
                  });

                  return;
                }

                const parts =
                  result.split(',');

                const base64Data =
                  parts.length > 1
                    ? parts[1]
                    : null;

                if (!base64Data) {
                  resolve({
                    success: false,
                    error:
                      'Failed to extract file data.',
                  });

                  return;
                }

                // -----------------------------------------
                // 4. Write file to device
                // -----------------------------------------
                await FileSystem.writeAsStringAsync(
                  localDestinationUri,
                  base64Data,
                  {
                    encoding:
                      FileSystem.EncodingType.Base64,
                  }
                );

                console.log(
                  'Evidence downloaded successfully:',
                  localDestinationUri
                );

                resolve({
                  success: true,
                });
              } catch (
                writeError: any
              ) {
                console.error(
                  'File write error:',
                  writeError
                );

                resolve({
                  success: false,
                  error:
                    writeError?.message ||
                    'Failed to save downloaded evidence locally.',
                });
              }
            };

          reader.onerror =
            () => {
              resolve({
                success: false,
                error:
                  'Failed to read downloaded evidence file.',
              });
            };

          reader.readAsDataURL(
            data
          );
        }
      );
    } catch (error: any) {
      console.error(
        'Download exception:',
        error
      );

      return {
        success: false,
        error:
          error?.message ||
          'Unexpected download exception occurred.',
      };
    }
  },

  /**
   * Check whether a file exists
   * inside Supabase Storage.
   */
  async fileExists(
    storagePath: string
  ): Promise<boolean> {
    try {
      if (!storagePath) {
        return false;
      }

      const pathParts =
        storagePath.split('/');

      if (pathParts.length < 2) {
        return false;
      }

      const fileName =
        pathParts.pop();

      if (!fileName) {
        return false;
      }

      const folderPath =
        pathParts.join('/');

      const {
        data,
        error,
      } = await supabase.storage
        .from('evidence-files')
        .list(folderPath);

      if (error || !data) {
        console.error(
          'Storage existence check error:',
          error
        );

        return false;
      }

      return data.some(
        (file) =>
          file.name === fileName
      );
    } catch (error) {
      console.error(
        'fileExists exception:',
        error
      );

      return false;
    }
  },

  /**
   * Delete an evidence attachment
   * from Supabase Storage.
   */
  async deleteAttachmentFile(
    storagePath: string
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      if (!storagePath) {
        return {
          success: false,
          error:
            'Storage path is missing.',
        };
      }

      const {
        error,
      } = await supabase.storage
        .from('evidence-files')
        .remove([
          storagePath,
        ]);

      if (error) {
        console.error(
          'Storage delete error:',
          error
        );

        return {
          success: false,
          error: error.message,
        };
      }

      console.log(
        'Evidence attachment deleted:',
        storagePath
      );

      return {
        success: true,
      };
    } catch (error: any) {
      console.error(
        'Delete exception:',
        error
      );

      return {
        success: false,
        error:
          error?.message ||
          'Failed to delete evidence attachment.',
      };
    }
  },
};