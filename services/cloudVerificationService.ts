import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from './supabase';
import { hashService } from './hashService';
import { custodyService } from './custodyService';
import { localEvidenceService } from './localEvidenceService';

export type CloudVerificationStatus = 'NOT_VERIFIED' | 'VERIFIED' | 'INTEGRITY_FAILED' | 'UNAVAILABLE';

export type CloudVerificationResult =
  | {
      status: 'VERIFIED';
      originalHash: string;
      currentHash: string;
      verifiedAt: string;
    }
  | {
      status: 'INTEGRITY_FAILED';
      originalHash: string;
      currentHash: string;
      verifiedAt: string;
    }
  | {
      status: 'UNAVAILABLE';
      originalHash: string;
      currentHash?: string;
      verifiedAt?: string;
      errorMessage: string;
    };

export async function verifyCloudAttachment({
  evidenceId,
  teamId,
  attachmentId,
  storagePath,
  originalHash,
  userId,
  userRole,
  userName,
}: {
  evidenceId: string;
  teamId: string;
  attachmentId: string;
  storagePath: string;
  originalHash: string;
  userId: string;
  userRole: string;
  userName: string;
}): Promise<CloudVerificationResult> {
  // 1. Role verification guard: Only Higher Officers / Admins can perform official cloud verification
  const normalizedRole = userRole ? String(userRole).toUpperCase() : '';
  const validOfficerRoles = ['HIGHER_OFFICER', 'ADMIN'];

  if (!validOfficerRoles.includes(normalizedRole)) {
    return {
      status: 'UNAVAILABLE',
      originalHash,
      errorMessage: 'Access denied: Only Higher Officers can perform official cloud verification.',
    };
  }

  const verifiedAt = new Date().toISOString();
  const cacheDir = FileSystem.cacheDirectory || `${FileSystem.documentDirectory}temp/`;
  const tempFilePath = `${cacheDir}verify_${Date.now()}_${attachmentId}`;

  try {
    // 2. Download from standardized private Supabase Storage bucket ('evidence-files')
    const { data, error: downloadError } = await supabase.storage
      .from('evidence-files')
      .download(storagePath);

    if (downloadError || !data) {
      await updateCloudVerificationRecord(attachmentId, {
        cloud_verification_status: 'UNAVAILABLE',
        cloud_last_verified_at: verifiedAt,
      });

      return {
        status: 'UNAVAILABLE',
        originalHash,
        verifiedAt,
        errorMessage: downloadError?.message || 'Storage download failed or file missing.',
      };
    }

    // Convert blob to base64 and write to temp file for chunked SHA-256 calculation
    const reader = new FileReader();
    const base64Data = await new Promise<string>((resolve, reject) => {
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result.split(',')[1] || '');
        } else {
          reject(new Error('Failed to read downloaded file data.'));
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(data);
    });

    await FileSystem.writeAsStringAsync(tempFilePath, base64Data, {
      encoding: FileSystem.EncodingType.Base64,
    });

    // 3. Calculate current SHA-256 byte-for-byte using the memory-safe hashService
    const currentHash = await hashService.calculateSha256(tempFilePath);

    // Clean up temporary file immediately
    await FileSystem.deleteAsync(tempFilePath, { idempotent: true });

    if (!currentHash) {
      throw new Error('SHA-256 calculation returned empty hash.');
    }

    // 4. Compare hashes (normalize casing)
    const normalizedOriginal = originalHash.trim().toLowerCase();
    const normalizedCurrent = currentHash.trim().toLowerCase();
    const isMatch = normalizedOriginal === normalizedCurrent;

    const status: CloudVerificationStatus = isMatch ? 'VERIFIED' : 'INTEGRITY_FAILED';

    // 5. Update attachment record (NEVER modify original SHA-256)
    await updateCloudVerificationRecord(attachmentId, {
      cloud_verification_status: status,
      cloud_last_verified_hash: currentHash,
      cloud_last_verified_at: verifiedAt,
    });

    // 6. Record immutable custody event
    const custodyAction = isMatch ? 'CLOUD_EVIDENCE_VERIFIED' : 'CLOUD_EVIDENCE_VERIFICATION_FAILED';
    await custodyService.createCustodyEvent({
      evidenceId,
      teamId,
      action: custodyAction,
      performedByUserId: userId,
      performedBy: userName,
      role: 'HIGHER_OFFICER',
      status: isMatch ? 'SUCCESS' : 'FAILED',
      notes: `Cloud verification on attachment ${attachmentId}. Result: ${status}. Original: ${normalizedOriginal}, Current: ${normalizedCurrent}`,
    });

    if (isMatch) {
      return {
        status: 'VERIFIED',
        originalHash,
        currentHash,
        verifiedAt,
      };
    } else {
      return {
        status: 'INTEGRITY_FAILED',
        originalHash,
        currentHash,
        verifiedAt,
      };
    }
  } catch (err: any) {
    try {
      await FileSystem.deleteAsync(tempFilePath, { idempotent: true });
    } catch {}

    await updateCloudVerificationRecord(attachmentId, {
      cloud_verification_status: 'UNAVAILABLE',
      cloud_last_verified_at: verifiedAt,
    });

    return {
      status: 'UNAVAILABLE',
      originalHash,
      verifiedAt,
      errorMessage: err?.message || 'Unexpected network or storage error during verification.',
    };
  }
}

async function updateCloudVerificationRecord(
  attachmentId: string,
  updates: {
    cloud_verification_status: string;
    cloud_last_verified_hash?: string;
    cloud_last_verified_at: string;
  }
) {
  try {
    // 1. Update in Supabase cloud DB
    await supabase
      .from('evidence_attachments')
      .update(updates)
      .eq('attachment_id', attachmentId);

    // 2. Update local metadata cache
    await localEvidenceService.updateAttachmentMetadata(attachmentId, {
      cloudVerificationStatus: updates.cloud_verification_status as any,
      cloudLastVerifiedHash: updates.cloud_last_verified_hash,
      cloudLastVerifiedAt: updates.cloud_last_verified_at,
    });
  } catch (error) {
    console.warn('Failed to update cloud verification metadata record:', error);
  }
}