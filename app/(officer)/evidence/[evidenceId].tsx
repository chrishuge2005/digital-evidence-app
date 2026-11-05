import React, { useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, ScrollView, Alert, Pressable, TouchableOpacity, Modal, Image, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { ScreenContainer } from '../../../components/ScreenContainer';
import { PrimaryButton } from '../../../components/PrimaryButton';
import { VerificationStatusBadge } from '../../../components/VerificationStatusBadge';
import { useAuth } from '../../../contexts/AuthContext';
import { supabase } from '../../../services/supabase';
import { localEvidenceService } from '../../../services/localEvidenceService';
import { hashService } from '../../../services/hashService';
import { custodyService } from '../../../services/custodyService';
import { syncService } from '../../../services/syncService';
import { Evidence, EvidenceAttachment, VerificationStatus } from '../../../types/evidence';

export default function EvidenceDetails() {
  const { evidenceId } = useLocalSearchParams<{ evidenceId: string }>();
  const router = useRouter();
  const { user, profile, team } = useAuth();
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [attachments, setAttachments] = useState<EvidenceAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [hashingStates, setHashingStates] = useState<Record<string, boolean>>({});
  const [errorState, setErrorState] = useState<{
    type: 'NOT_FOUND' | 'UNAUTHORIZED' | 'NETWORK_ERROR' | null;
    message: string;
  }>({ type: null, message: '' });

  // State for the in-app image viewer
  const [openingFile, setOpeningFile] = useState<string | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);

  useFocusEffect(
    React.useCallback(() => {
      loadDetails();
    }, [evidenceId])
  );

  const loadDetails = async () => {
    try {
      // 1. Extract and validate the identifier passed by navigation
      if (!evidenceId || typeof evidenceId !== 'string' || !evidenceId.trim()) {
        setErrorState({
          type: 'NOT_FOUND',
          message: 'Invalid or missing evidence identifier.'
        });
        setEvidence(null);
        setLoading(false);
        return;
      }

      const cleanId = evidenceId.trim();
      let cloudRecord: any = null;
      let cloudError: any = null;
      let isAuthError = false;

      // 2. Attempt Supabase cloud lookup using clean identifier
      try {
        const { data: byEvId, error: errByEvId } = await supabase
          .from('evidence')
          .select('*')
          .eq('evidence_id', cleanId)
          .maybeSingle();

        if (errByEvId) {
          cloudError = errByEvId;
          if (
            errByEvId.code === '42501' || 
            errByEvId.message?.toLowerCase().includes('permission') ||
            errByEvId.message?.toLowerCase().includes('row-level security')
          ) {
            isAuthError = true;
          }
        } else if (byEvId) {
          cloudRecord = byEvId;
        } else {
          // If cleanId is UUID format, attempt query by primary key 'id'
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (uuidRegex.test(cleanId)) {
            const { data: byId, error: errById } = await supabase
              .from('evidence')
              .select('*')
              .eq('id', cleanId)
              .maybeSingle();

            if (errById) {
              cloudError = errById;
              if (errById.code === '42501') isAuthError = true;
            } else if (byId) {
              cloudRecord = byId;
            }
          }
        }
      } catch (netErr: any) {
        cloudError = netErr;
      }

      // 3. Successfully resolved from Cloud
      if (cloudRecord) {
        const internalDbId = cloudRecord.id;
        const businessId = cloudRecord.evidence_id || cleanId;

        // Fetch cloud attachments
        let cloudAtts: any[] = [];
        try {
          const { data: attData, error: attErr } = await supabase
            .from('evidence_attachments')
            .select('*')
            .or(`evidence_id.eq.${internalDbId},evidence_id.eq.${businessId}`);

          if (attData) cloudAtts = attData;
          if (attErr) console.warn('Supabase attachment fetch error:', attErr.message);
        } catch (attE) {
          console.warn('Could not query cloud attachments:', attE);
        }

        // Check local store for any cached attachment metadata (e.g. localUri)
        const localMatch = await localEvidenceService.getLocalEvidenceById(businessId);
        const localAttMap = new Map<string, EvidenceAttachment>();
        if (localMatch?.attachments) {
          for (const a of localMatch.attachments) {
            localAttMap.set(a.attachmentId, a);
            if (a.originalName) localAttMap.set(a.originalName, a);
          }
        }

        const mappedEvidence: Evidence = {
          id: cloudRecord.id,
          evidenceId: businessId,
          teamId: cloudRecord.team_id,
          ownerId: cloudRecord.owner_id,
          created_by: cloudRecord.created_by,
          createdBy: cloudRecord.created_by || cloudRecord.owner_id,
          assignedOfficerId: cloudRecord.assigned_officer_id,
          title: cloudRecord.title,
          description: cloudRecord.description,
          category: cloudRecord.category,
          location: cloudRecord.location,
          capturedAt: cloudRecord.captured_at,
          status: cloudRecord.status,
          verificationStatus: cloudRecord.verification_status,
          cloudVerificationStatus: cloudRecord.cloud_verification_status,
          syncStatus: 'SYNCED',
          lastSyncedAt: cloudRecord.updated_at || cloudRecord.created_at,
          createdAt: cloudRecord.created_at,
          updatedAt: cloudRecord.updated_at,
        };

        const rawList = cloudAtts.length > 0 ? cloudAtts : (localMatch?.attachments || []);
        const mappedAttachments: EvidenceAttachment[] = rawList.map((att: any) => {
          const attId = att.attachment_id || att.attachmentId || att.id;
          const localRef = localAttMap.get(attId) || localAttMap.get(att.file_name || att.original_name);

          return {
            id: att.id,
            attachmentId: attId,
            evidenceId: businessId,
            originalName: att.file_name || att.original_name || att.originalName || 'file',
            mimeType: att.file_type || att.mime_type || att.mimeType || 'application/octet-stream',
            fileSize: Number(att.file_size || att.fileSize || 0),
            localUri: localRef?.localUri || '',
            storageFileId: att.storage_file_id || att.storage_path || att.storageFileId || null,
            storagePath: att.storage_path || att.storage_file_id || att.storagePath || null,
            sha256: att.sha256 || localRef?.sha256 || '',
            uploadStatus: att.storage_file_id ? 'UPLOADED' : (att.upload_status || att.uploadStatus || 'PENDING'),
            cloudVerificationStatus: att.cloud_verification_status || att.cloudVerificationStatus,
            cloudLastVerifiedHash: att.cloud_last_verified_hash || att.cloudLastVerifiedHash,
            cloudLastVerifiedAt: att.cloud_last_verified_at || att.cloudLastVerifiedAt,
            createdAt: att.created_at || att.createdAt || new Date().toISOString(),
            updatedAt: att.updated_at || att.updatedAt || new Date().toISOString(),
          };
        });

        setEvidence(mappedEvidence);
        setAttachments(mappedAttachments);
        setErrorState({ type: null, message: '' });
        return;
      }

      // 4. Cloud record not found or network offline: Fallback to local SQLite / AsyncStorage store
      const localData = await localEvidenceService.getLocalEvidenceById(cleanId);
      if (localData?.evidence) {
        const localEv = localData.evidence;

        // Authorization Guard: ensure local evidence belongs to user or user's active team
        const currentUserId = user?.id;
        const currentTeamId = team?.teamId || (user as any)?.user_metadata?.team_id;

        const isOwner =
          localEv.ownerId === currentUserId ||
          localEv.createdBy === currentUserId ||
          (localEv as any).created_by === currentUserId;
        const isSameTeam = currentTeamId && localEv.teamId === currentTeamId;
        const isHigherOfficer = profile?.role === 'HIGHER_OFFICER';

        if (!isOwner && !isSameTeam && !isHigherOfficer && currentUserId) {
          setErrorState({
            type: 'UNAUTHORIZED',
            message: 'Access Denied: You do not have authorization to view this local evidence record.'
          });
          setEvidence(null);
          return;
        }

        // Ensure default sync status indicates pending / local only
        if (!localEv.syncStatus) {
          localEv.syncStatus = 'LOCAL_ONLY';
        }

        setEvidence(localEv);
        setAttachments(localData.attachments || []);
        setErrorState({ type: null, message: '' });
        return;
      }

      // 5. Neither cloud nor local record was found - determine appropriate error state
      if (isAuthError) {
        setErrorState({
          type: 'UNAUTHORIZED',
          message: 'Access Denied: You do not have permission to view this evidence record.'
        });
      } else if (cloudError && !cloudError.message?.includes('JSON object requested, multiple (or no) rows returned')) {
        setErrorState({
          type: 'NETWORK_ERROR',
          message: cloudError.message || 'Unable to connect to cloud services and no local record was found. Please check your network connection.'
        });
      } else {
        setErrorState({
          type: 'NOT_FOUND',
          message: `Evidence with identifier "${cleanId}" could not be found.`
        });
      }

      setEvidence(null);
    } catch (error: any) {
      console.error('Evidence detail load error:', error);
      setErrorState({
        type: 'NETWORK_ERROR',
        message: error.message || 'An unexpected error occurred while loading evidence details.'
      });
      setEvidence(null);
    } finally {
      setLoading(false);
    }
  };

  const handleMarkAsReviewed = async () => {
    if (!evidence || !user) return;
    try {
      const officerName = profile?.display_name || user.user_metadata?.display_name || 'Officer';
      const userRole = profile?.role === 'HIGHER_OFFICER' ? 'HIGHER_OFFICER' : 'OFFICER';

      await custodyService.createCustodyEvent({
        evidenceId: evidence.evidenceId,
        teamId: evidence.teamId,
        action: 'EVIDENCE_REVIEWED',
        performedByUserId: user.id,
        performedBy: officerName,
        role: userRole,
        status: 'SUCCESS',
        notes: 'Evidence record opened and reviewed by investigator.'
      });

      Alert.alert("Success", "Evidence review logged to chain of custody.");
    } catch (error: any) {
      Alert.alert("Error", error.message || "Failed to log review event.");
    }
  };

  const handleGenerateHash = async (attachment: EvidenceAttachment) => {
    if (attachment.sha256) {
      return Alert.alert("Notice", "Immutable original fingerprint already exists.");
    }

    setHashingStates(prev => ({ ...prev, [attachment.attachmentId]: true }));
    try {
      const hash = await hashService.calculateSha256(attachment.localUri);
      await localEvidenceService.updateAttachmentMetadata(attachment.attachmentId, {
        sha256: hash,
      });
      await loadDetails();
      Alert.alert("Success", "Immutable original SHA-256 fingerprint generated.");
    } catch (error: any) {
      await localEvidenceService.updateAttachmentMetadata(attachment.attachmentId, {
        sha256: '',
      });
      await loadDetails();
      Alert.alert("Hash Generation Failed", error.message || "Unable to generate fingerprint.");
    } finally {
      setHashingStates(prev => ({ ...prev, [attachment.attachmentId]: false }));
    }
  };

  const copyToClipboard = async (hash: string, label: string) => {
    await Clipboard.setStringAsync(hash);
    Alert.alert("Copied", `${label} copied to clipboard.`);
  };

  const formatHash = (hash: string) => {
    if (!hash || hash.length !== 64) return hash;
    return `${hash.substring(0, 12)}...${hash.substring(52)}`;
  };

  // Generate a temporary URL to view the private file or open local file
  const handleViewAttachment = async (storagePath: string | undefined, attachmentId: string, mimeType: string) => {
    const att = attachments.find(a => a.attachmentId === attachmentId);

    // If file is not yet synced to cloud, allow local preview if localUri is present and image
    if (!storagePath) {
      if (att?.localUri && mimeType && mimeType.startsWith('image/')) {
        setViewerUrl(att.localUri);
        return;
      }
      Alert.alert('Not Synced', 'This file has not been synced to the cloud yet. Please sync first.');
      return;
    }

    setOpeningFile(attachmentId);
    try {
      const { data, error } = await supabase.storage
        .from('evidence-files')
        .createSignedUrl(storagePath, 3600); 

      if (error) throw error;

      if (data?.signedUrl) {
        // If it's an image, open it in our in-app modal viewer
        if (mimeType && mimeType.startsWith('image/')) {
          setViewerUrl(data.signedUrl);
        } else {
          // If it's a PDF or video, fallback to the external browser/viewer
          const supported = await Linking.canOpenURL(data.signedUrl);
          if (supported) {
            await Linking.openURL(data.signedUrl);
          } else {
            Alert.alert('Error', 'Cannot open this type of file on this device.');
          }
        }
      }
    } catch (error: any) {
      console.error("View attachment error:", error);
      Alert.alert('Error', 'Failed to load the file securely.');
    } finally {
      setOpeningFile(null);
    }
  };

  if (loading) {
    return (
      <ScreenContainer style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading evidence details...</Text>
      </ScreenContainer>
    );
  }

  if (!evidence) {
    if (errorState.type === 'UNAUTHORIZED') {
      return (
        <ScreenContainer style={styles.center}>
          <Ionicons name="lock-closed" size={56} color="#DC2626" />
          <Text style={styles.errorTitle}>Access Denied</Text>
          <Text style={styles.errorDescription}>{errorState.message}</Text>
          <PrimaryButton
            title="Go Back"
            onPress={() => router.back()}
            style={{ marginTop: 20, minWidth: 160 }}
          />
        </ScreenContainer>
      );
    }

    if (errorState.type === 'NETWORK_ERROR') {
      return (
        <ScreenContainer style={styles.center}>
          <Ionicons name="cloud-offline" size={56} color="#D97706" />
          <Text style={styles.errorTitle}>Connection Error</Text>
          <Text style={styles.errorDescription}>{errorState.message}</Text>
          <View style={{ flexDirection: 'row', marginTop: 20, gap: 12 }}>
            <PrimaryButton
              title="Retry"
              onPress={() => {
                setLoading(true);
                loadDetails();
              }}
              style={{ backgroundColor: '#007AFF', paddingHorizontal: 24 }}
            />
            <PrimaryButton
              title="Go Back"
              onPress={() => router.back()}
              style={{ backgroundColor: '#6B7280', paddingHorizontal: 24 }}
            />
          </View>
        </ScreenContainer>
      );
    }

    return (
      <ScreenContainer style={styles.center}>
        <Ionicons name="document-text-outline" size={56} color="#6B7280" />
        <Text style={styles.errorTitle}>Evidence Not Found</Text>
        <Text style={styles.errorDescription}>
          {errorState.message || 'The requested evidence record could not be found locally or in the cloud.'}
        </Text>
        <PrimaryButton
          title="Go Back"
          onPress={() => router.back()}
          style={{ marginTop: 20, minWidth: 160 }}
        />
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.headerContainer}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="arrow-back" size={28} color="#007AFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{evidence.evidenceId}</Text>
        </View>

        {/* Offline / Pending Sync Indicator Banner */}
        {evidence.syncStatus !== 'SYNCED' && (
          <View style={styles.offlineBanner}>
            <Ionicons name="cloud-offline-outline" size={22} color="#854D0E" style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.offlineBannerTitle}>Local Evidence (Pending Cloud Sync)</Text>
              <Text style={styles.offlineBannerText}>
                This evidence is preserved locally on device and will synchronize when online.
              </Text>
            </View>
          </View>
        )}
        
        {/* Main Details Card */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.label}>Evidence Status</Text>
            <VerificationStatusBadge status={(evidence.verificationStatus as VerificationStatus) || 'PENDING'} />
          </View>

          <Text style={styles.label}>Title</Text>
          <Text style={styles.value}>{evidence.title}</Text>
          
          <Text style={styles.label}>Description</Text>
          <Text style={styles.value}>{evidence.description || 'N/A'}</Text>
          
          <Text style={styles.label}>Category</Text>
          <Text style={styles.value}>{evidence.category}</Text>
          
          <Text style={styles.label}>Location</Text>
          <Text style={styles.value}>{evidence.location || 'N/A'}</Text>
          
          <Text style={styles.label}>Captured At</Text>
          <Text style={styles.value}>{evidence.capturedAt || 'N/A'}</Text>

          <View style={styles.buttonSpacing}>
            <PrimaryButton 
              title="Mark as Reviewed" 
              onPress={handleMarkAsReviewed} 
              style={{ backgroundColor: '#4A5568', marginBottom: 10 }} 
            />
            <PrimaryButton 
              title="View Chain of Custody" 
              onPress={() => router.push(`/(officer)/evidence/custody-history?evidenceId=${evidence.evidenceId}`)} 
              style={{ marginBottom: 10 }}
            />
            
            <PrimaryButton 
              title="Transfer Custody" 
              onPress={() => router.push({
                pathname: '/(officer)/transfer/[id]',
                params: { id: evidence.evidenceId }
              })}
              style={{ backgroundColor: '#0284C7' }} 
            />
          </View>
        </View>

        {/* Cloud Synchronization Status Card Section */}
        <View style={styles.card}>
          <Text style={styles.cardHeader}>Cloud Metadata Synchronization</Text>
          <Text style={styles.label}>Sync Status:</Text>
          <Text style={[styles.badge, evidence.syncStatus === 'SYNCED' ? styles.verified : styles.pending]}>
            {evidence.syncStatus || 'LOCAL_ONLY'}
          </Text>

          {evidence.lastSyncedAt && (
            <>
              <Text style={styles.label}>Last Synced At:</Text>
              <Text style={styles.value}>{new Date(evidence.lastSyncedAt).toLocaleString()}</Text>
            </>
          )}

          {evidence.syncError && (
            <>
              <Text style={styles.label}>Sync Error:</Text>
              <Text style={[styles.value, { color: '#DC2626' }]}>{evidence.syncError}</Text>
            </>
          )}

          <PrimaryButton
            title="Retry Sync"
            onPress={async () => {
              const result = await syncService.syncEvidenceItem(evidence.evidenceId);
              if (result.success) {
                Alert.alert('Success', 'Cloud metadata synchronized successfully.');
                loadDetails();
              } else {
                Alert.alert('Sync Failed', result.error || 'Unable to synchronize.');
                loadDetails();
              }
            }}
            style={{ marginTop: 12, backgroundColor: '#007AFF' }}
          />
        </View>

        <Text style={styles.sectionTitle}>Attachments ({attachments.length})</Text>
        {attachments.length === 0 ? (
          <Text style={styles.noFiles}>No attachments found.</Text>
        ) : (
          attachments.map(att => {
            const isHashing = hashingStates[att.attachmentId];
            return (
              <View key={att.attachmentId} style={styles.attachmentCard}>
                <Text style={styles.attFilename}>{att.originalName}</Text>
                <Text style={styles.attMeta}>Type: {att.mimeType} • {(att.fileSize / 1024).toFixed(2)} KB</Text>
                
                <View style={styles.hashSection}>
                  <Text style={styles.hashHeader}>Original SHA-256 (Immutable):</Text>
                  {att.sha256 ? (
                    <View style={styles.hashBox}>
                      <Text style={styles.hashText}>{formatHash(att.sha256)}</Text>
                      <Pressable style={styles.copyBtn} onPress={() => copyToClipboard(att.sha256!, 'Original SHA-256')}>
                        <Text style={styles.copyText}>Copy</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <View style={styles.missingHashBox}>
                      <Text style={styles.missingHashText}>Fingerprint not available</Text>
                      {isHashing ? (
                        <ActivityIndicator size="small" color="#007AFF" />
                      ) : (
                        <PrimaryButton 
                          title="Generate Fingerprint" 
                          onPress={() => handleGenerateHash(att)} 
                          style={styles.generateBtn} 
                        />
                      )}
                    </View>
                  )}

                  {att.cloudLastVerifiedHash && (
                    <>
                      <Text style={[styles.hashHeader, { marginTop: 10 }]}>Last Verified Cloud SHA-256:</Text>
                      <View style={[styles.hashBox, { backgroundColor: '#F1F3F5' }]}>
                        <Text style={[styles.hashText, { color: '#495057' }]}>{formatHash(att.cloudLastVerifiedHash)}</Text>
                        <Pressable style={[styles.copyBtn, { backgroundColor: '#495057' }]} onPress={() => copyToClipboard(att.cloudLastVerifiedHash!, 'Cloud SHA-256')}>
                          <Text style={styles.copyText}>Copy</Text>
                        </Pressable>
                      </View>
                      <Text style={styles.attMeta}>Verified At: {att.cloudLastVerifiedAt ? new Date(att.cloudLastVerifiedAt).toLocaleString() : 'N/A'}</Text>
                    </>
                  )}
                </View>

                {/* View File Button */}
                <View style={{ marginTop: 12 }}>
                  <PrimaryButton
                    title={openingFile === att.attachmentId ? "Loading..." : "View File"}
                    onPress={() => handleViewAttachment(att.storageFileId || att.storagePath || undefined, att.attachmentId, att.mimeType || '')}
                    disabled={openingFile === att.attachmentId || (!att.storageFileId && !att.storagePath && !att.localUri)}
                    style={{ 
                      backgroundColor: (att.storageFileId || att.storagePath || att.localUri) ? '#0284C7' : '#94A3B8', 
                      paddingVertical: 10 
                    }}
                  />
                  {!att.storageFileId && !att.storagePath && !att.localUri && (
                    <Text style={styles.notSyncedText}>File must be stored locally or synced to cloud to view.</Text>
                  )}
                </View>

              </View>
            );
          })
        )}
      </ScrollView>

      {/* Full Screen In-App Image Viewer Modal */}
      <Modal visible={!!viewerUrl} transparent={true} animationType="fade" onRequestClose={() => setViewerUrl(null)}>
        <View style={styles.modalViewerContainer}>
          <TouchableOpacity style={styles.closeModalButton} onPress={() => setViewerUrl(null)}>
            <Ionicons name="close" size={36} color="#FFF" />
          </TouchableOpacity>
          {viewerUrl && (
            <Image source={{ uri: viewerUrl }} style={styles.fullScreenImage} resizeMode="contain" />
          )}
        </View>
      </Modal>

    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { marginTop: 12, color: '#666', fontSize: 15 },
  errorTitle: { fontSize: 20, fontWeight: 'bold', color: '#1E293B', marginTop: 14 },
  errorDescription: { fontSize: 14, color: '#64748B', textAlign: 'center', marginTop: 8, lineHeight: 20 },
  headerContainer: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  backButton: { marginRight: 15 },
  headerTitle: { fontSize: 24, fontWeight: 'bold', color: '#007AFF' },
  offlineBanner: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    backgroundColor: '#FEF9C3', 
    borderColor: '#FDE047', 
    borderWidth: 1, 
    borderRadius: 8, 
    padding: 12, 
    marginBottom: 16 
  },
  offlineBannerTitle: { fontSize: 13, fontWeight: 'bold', color: '#854D0E' },
  offlineBannerText: { fontSize: 12, color: '#A16207', marginTop: 2 },
  card: { backgroundColor: '#FFF', padding: 20, borderRadius: 12, elevation: 2, marginBottom: 20 },
  cardHeader: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 12 },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  label: { fontSize: 12, color: '#666', marginTop: 12 },
  value: { fontSize: 16, fontWeight: '600', color: '#333', marginTop: 4 },
  badge: { alignSelf: 'flex-start', marginTop: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, fontSize: 12, fontWeight: 'bold', overflow: 'hidden' },
  verified: { backgroundColor: '#DCFCE7', color: '#166534' },
  pending: { backgroundColor: '#FEF9C3', color: '#854D0E' },
  buttonSpacing: { marginTop: 16 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 10 },
  noFiles: { fontSize: 14, color: '#888', fontStyle: 'italic' },
  attachmentCard: { backgroundColor: '#F0F4F8', padding: 15, borderRadius: 8, marginBottom: 15 },
  attFilename: { fontSize: 16, fontWeight: 'bold', color: '#333', marginBottom: 4 },
  attMeta: { fontSize: 12, color: '#666', marginTop: 4 },
  hashSection: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#DDD' },
  hashHeader: { fontSize: 12, fontWeight: 'bold', color: '#333', marginBottom: 4 },
  hashBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#E8F0FE', padding: 8, borderRadius: 6 },
  hashText: { fontSize: 13, fontFamily: 'monospace', color: '#007AFF' },
  copyBtn: { backgroundColor: '#007AFF', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 4 },
  copyText: { color: '#FFF', fontSize: 11, fontWeight: 'bold' },
  missingHashBox: { marginTop: 5 },
  missingHashText: { fontSize: 13, color: '#FF3B30', fontStyle: 'italic', marginBottom: 8 },
  generateBtn: { paddingVertical: 6 },
  notSyncedText: { fontSize: 11, color: '#64748B', fontStyle: 'italic', marginTop: 6, textAlign: 'center' },
  
  // Image Viewer Styles
  modalViewerContainer: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.95)', justifyContent: 'center', alignItems: 'center' },
  closeModalButton: { position: 'absolute', top: 50, right: 20, zIndex: 10, padding: 10 },
  fullScreenImage: { width: '100%', height: '80%' }
});
