import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Alert, Pressable, TouchableOpacity, Linking, Modal, Image } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { ScreenContainer } from '../../../components/ScreenContainer';
import { PrimaryButton } from '../../../components/PrimaryButton';
import { VerificationStatusBadge } from '../../../components/VerificationStatusBadge';
import { useAuth } from '../../../contexts/AuthContext';
import { supabase } from '../../../services/supabase';
import { evidenceService } from '../../../services/evidenceService';
import { localEvidenceService } from '../../../services/localEvidenceService';
import { custodyService } from '../../../services/custodyService';
import { verifyCloudAttachment } from '../../../services/cloudVerificationService';

export default function HigherOfficerEvidenceDetails() {
  const { evidenceId } = useLocalSearchParams<{ evidenceId: string }>();
  const router = useRouter();
  const { user, profile, team } = useAuth();

  const [evidence, setEvidence] = useState<any | null>(null);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [custodyHistory, setCustodyHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [errorState, setErrorState] = useState<{
    type: 'NOT_FOUND' | 'UNAUTHORIZED' | 'NETWORK_ERROR' | null;
    message: string;
  }>({ type: null, message: '' });
  
  // State for the in-app image viewer
  const [openingFile, setOpeningFile] = useState<string | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [verifyingFiles, setVerifyingFiles] = useState<Record<string, boolean>>({});

  const handleVerifyAttachment = async (att: any) => {
    if (!evidence || !user) return;
    
    const attId = att.attachment_id || att.attachmentId;
    setVerifyingFiles(prev => ({ ...prev, [attId]: true }));
    
    try {
      const result = await verifyCloudAttachment({
        evidenceId: evidence.evidence_id || evidence.evidenceId,
        teamId: evidence.team_id || evidence.teamId,
        attachmentId: attId,
        storagePath: att.storage_file_id || att.storageFileId,
        originalHash: att.sha256,
        userId: user.id,
        userRole: profile?.role || 'HIGHER_OFFICER',
        userName: profile?.display_name || user.user_metadata?.display_name || 'Higher Officer'
      });
      
      const currentHashToShow = ('currentHash' in result && result.currentHash) ? result.currentHash : 'N/A';
      Alert.alert(
        result.status === 'VERIFIED' ? 'Integrity Verified' : 'Integrity Mismatch',
        result.status === 'VERIFIED' 
          ? 'The downloaded file SHA-256 fingerprint matches the original immutable hash stored at registration.'
          : `Warning: Integrity check failed! The current file hash does not match the original hash.\n\nOriginal: ${result.originalHash.substring(0, 10)}...\nCurrent: ${currentHashToShow.substring(0, 10)}...`
      );
      
      await loadEvidenceDetails();
    } catch (err: any) {
      console.error('File verification error:', err);
      Alert.alert('Verification Failed', err.message || 'An unexpected error occurred during file check.');
    } finally {
      setVerifyingFiles(prev => ({ ...prev, [attId]: false }));
    }
  };

  useFocusEffect(
    React.useCallback(() => {
      loadEvidenceDetails();
    }, [evidenceId])
  );

  const loadEvidenceDetails = async () => {
    if (!evidenceId || typeof evidenceId !== 'string' || !evidenceId.trim()) {
      setErrorState({ type: 'NOT_FOUND', message: 'Invalid or missing evidence identifier.' });
      setEvidence(null);
      setLoading(false);
      return;
    }

    const cleanId = evidenceId.trim();
    let currentEvidence: any = null;
    let isAuthError = false;
    let isNetError = false;

    try {
      setLoading(true);
      setErrorState({ type: null, message: '' });
      
      // 1. Try finding by business evidence_id
      try {
        const { data: evData, error: evErr } = await supabase
          .from('evidence')
          .select('*')
          .eq('evidence_id', cleanId)
          .maybeSingle();

        if (evErr) {
          if (evErr.code === '42501' || evErr.message?.toLowerCase().includes('permission') || evErr.message?.toLowerCase().includes('row-level security')) {
            isAuthError = true;
          } else {
            isNetError = true;
          }
        } else if (evData) {
          currentEvidence = evData;
        }
      } catch (e: any) {
        isNetError = true;
      }

      // 2. If not found and cleanId looks like a UUID, try finding by primary key 'id'
      if (!currentEvidence && !isAuthError) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(cleanId)) {
          try {
            const { data: evById, error: errById } = await supabase
              .from('evidence')
              .select('*')
              .eq('id', cleanId)
              .maybeSingle();

            if (errById) {
              if (errById.code === '42501' || errById.message?.toLowerCase().includes('permission') || errById.message?.toLowerCase().includes('row-level security')) {
                isAuthError = true;
              } else {
                isNetError = true;
              }
            } else if (evById) {
              currentEvidence = evById;
            }
          } catch {
            isNetError = true;
          }
        }
      }

      // 3. Fallback to local storage
      if (!currentEvidence && !isAuthError) {
        try {
          const localMatch = await localEvidenceService.getLocalEvidenceById(cleanId);
          if (localMatch?.evidence) {
            const currentHoTeamId = team?.teamId;
            const evTeamId = localMatch.evidence.teamId || (localMatch.evidence as any).team_id;
            if (currentHoTeamId && evTeamId && currentHoTeamId !== evTeamId) {
              setErrorState({
                type: 'UNAUTHORIZED',
                message: 'Access Denied: You do not have permission to view evidence belonging to another team.'
              });
              setEvidence(null);
              setLoading(false);
              return;
            }
            currentEvidence = localMatch.evidence;
          }
        } catch {}
      }

      if (!currentEvidence) {
        if (isAuthError) {
          setErrorState({ type: 'UNAUTHORIZED', message: 'You do not have permission to view evidence belonging to another team.' });
        } else if (isNetError) {
          setErrorState({ type: 'NETWORK_ERROR', message: 'Could not connect to the cloud server. Please check your internet connection.' });
        } else {
          setErrorState({ type: 'NOT_FOUND', message: 'Evidence record not found.' });
        }
        setEvidence(null);
        setLoading(false);
        return;
      }

      setEvidence(currentEvidence);

      const internalDbId = currentEvidence.id || cleanId;
      const businessId = currentEvidence.evidence_id || currentEvidence.evidenceId || cleanId;

      // Query attachments
      try {
        const { data: attData, error: attErr } = await supabase
          .from('evidence_attachments')
          .select('*')
          .or(`evidence_id.eq.${internalDbId},evidence_id.eq.${businessId}`);

        if (attErr) console.warn('Supabase Attachment Fetch Error:', attErr.message);

        let mergedAtts = attData || [];
        try {
          const localMatch = await localEvidenceService.getLocalEvidenceById(businessId);
          if (localMatch?.attachments && localMatch.attachments.length > 0) {
            const attMap = new Map<string, any>();
            mergedAtts.forEach((a: any) => attMap.set(a.attachment_id || a.attachmentId, a));
            localMatch.attachments.forEach((la: any) => {
              const k = la.attachment_id || la.attachmentId;
              if (!attMap.has(k)) {
                attMap.set(k, la);
              } else {
                const existing = attMap.get(k);
                if (!existing.local_uri && la.localUri) existing.local_uri = la.localUri;
              }
            });
            mergedAtts = Array.from(attMap.values());
          }
        } catch {}

        setAttachments(mergedAtts);
      } catch (attErr) {
        console.warn('Error fetching attachments:', attErr);
      }

      // Query custody history
      try {
        const { data: custodyData, error: custodyErr } = await supabase
          .from('evidence_custody')
          .select('*')
          .or(`evidence_id.eq.${internalDbId},evidence_id.eq.${businessId}`)
          .order('timestamp', { ascending: true });
          
        if (custodyErr) console.warn('Supabase Custody Fetch Error:', custodyErr.message);
        setCustodyHistory(custodyData || []);
      } catch (custodyErr) {
        console.warn('Error fetching custody events:', custodyErr);
      }

    } catch (err: any) {
      console.error('Error loading evidence details:', err);
      setErrorState({ type: 'NETWORK_ERROR', message: 'An unexpected error occurred while loading evidence details.' });
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', `${label} copied to clipboard.`);
  };

  const formatHash = (hash: string) => {
    if (!hash || hash.length !== 64) return hash;
    return `${hash.substring(0, 12)}...${hash.substring(52)}`;
  };

  const handleViewAttachment = async (storagePath: string, attachmentId: string, mimeType: string) => {
    if (!storagePath) {
      Alert.alert('Error', 'File path is missing. The file may not have finished uploading.');
      return;
    }

    setOpeningFile(attachmentId);
    try {
      const { data, error } = await supabase.storage
        .from('evidence-files')
        .createSignedUrl(storagePath, 3600); 

      if (error) throw error;

      if (data?.signedUrl) {
        if (mimeType && mimeType.startsWith('image/')) {
          setViewerUrl(data.signedUrl);
        } else {
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

  const handleOfficialVerification = async () => {
    if (!evidence || !user) return;
    const targetId = evidence.evidence_id || evidence.evidenceId;

    Alert.alert(
      'Verify Evidence?',
      `Evidence ID: ${targetId}\n\nThe current files will be officially verified against their immutable original SHA-256 fingerprints by Higher Officer oversight.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Verify',
          onPress: async () => {
            setVerifying(true);
            try {
              const { data: profileCheck } = await supabase
                .from('profiles')
                .select('role')
                .eq('user_id', user.id)
                .single();

              const validOfficerRoles = ['HIGHER_OFFICER', 'higher_officer', 'ADMIN', 'admin'];
              
              if (!profileCheck || !validOfficerRoles.includes(profileCheck.role)) {
                throw new Error('Unauthorized: Only Higher Officers can perform official verification.');
              }

              const success = await evidenceService.updateVerificationStatus(targetId, 'VERIFIED');
              
              const officerName = profile?.display_name || user.user_metadata?.display_name || 'Higher Officer';
              await custodyService.createCustodyEvent({
                evidenceId: targetId,
                teamId: evidence.team_id || evidence.teamId,
                action: success ? 'EVIDENCE_VERIFIED' : 'EVIDENCE_VERIFICATION_FAILED',
                performedByUserId: user.id,
                performedBy: officerName,
                role: 'HIGHER_OFFICER',
                status: success ? 'SUCCESS' : 'FAILED',
                notes: success ? 'Official verification passed: hashes match.' : 'Official verification failed: integrity mismatch.'
              });

              Alert.alert(
                success ? 'Verification Passed' : 'Verification Failed', 
                success ? 'Evidence integrity verified successfully.' : 'Integrity mismatch detected.'
              );
              await loadEvidenceDetails();
            } catch (error: any) {
              Alert.alert('Verification Error', error.message || 'Failed to complete verification.');
            } finally {
              setVerifying(false);
            }
          }
        }
      ]
    );
  };

  if (loading) {
    return (
      <ScreenContainer>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Loading evidence details...</Text>
        </View>
      </ScreenContainer>
    );
  }

  if (!evidence) {
    const isNetwork = errorState.type === 'NETWORK_ERROR';
    const isAuth = errorState.type === 'UNAUTHORIZED';
    const iconName = isNetwork ? 'cloud-offline-outline' : isAuth ? 'lock-closed-outline' : 'alert-circle-outline';
    const title = isNetwork ? 'Network Connection Error' : isAuth ? 'Access Denied' : 'Evidence Not Found';
    const desc = errorState.message || (isAuth ? 'You do not have authorization to view this evidence.' : isNetwork ? 'Unable to reach the server. Please check your network connection.' : 'The requested evidence could not be found.');

    return (
      <ScreenContainer>
        <View style={styles.center}>
          <Ionicons name={iconName} size={48} color={isAuth ? '#EF4444' : isNetwork ? '#F59E0B' : '#64748B'} style={{ marginBottom: 12 }} />
          <Text style={styles.errorTitle}>{title}</Text>
          <Text style={styles.errorText}>{desc}</Text>
          <View style={styles.errorActionRow}>
            {isNetwork && (
              <TouchableOpacity style={styles.retryButton} onPress={loadEvidenceDetails}>
                <Ionicons name="refresh" size={18} color="#FFF" style={{ marginRight: 6 }} />
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.backLinkButton} onPress={() => router.back()}>
              <Text style={styles.backLinkText}>Return to Cases</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScreenContainer>
    );
  }

  const currentEvidenceId = evidence.evidence_id || evidence.evidenceId;

  return (
    <ScreenContainer>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        {/* Header with Back Button */}
        <View style={styles.headerContainer}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="arrow-back" size={28} color="#007AFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{currentEvidenceId}</Text>
        </View>

        {/* Core Metadata Card */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.label}>Verification Status</Text>
            <VerificationStatusBadge status={evidence.verification_status || evidence.verificationStatus} />
          </View>

          <Text style={styles.label}>Title</Text>
          <Text style={styles.value}>{evidence.title}</Text>

          <Text style={styles.label}>Description</Text>
          <Text style={styles.value}>{evidence.description || 'N/A'}</Text>

          <Text style={styles.label}>Category</Text>
          <Text style={styles.value}>{evidence.category || 'N/A'}</Text>

          <Text style={styles.label}>Location</Text>
          <Text style={styles.value}>{evidence.location || 'N/A'}</Text>

          <Text style={styles.label}>Captured At</Text>
          <Text style={styles.value}>{evidence.captured_at || evidence.capturedAt ? new Date(evidence.captured_at || evidence.capturedAt).toLocaleString() : 'N/A'}</Text>

          <Text style={styles.label}>Current Owner ID</Text>
          <Text style={styles.valueSecondary}>{evidence.owner_id || evidence.ownerId || 'N/A'}</Text>

          {/* Official Verification Button */}
          <View style={{ marginTop: 20 }}>
            <PrimaryButton
              title={verifying ? "Verifying Evidence..." : "Verify Evidence"}
              onPress={handleOfficialVerification}
              disabled={verifying}
              style={{ backgroundColor: '#059669' }}
            />
          </View>
        </View>

        {/* Attachments & SHA-256 Fingerprints */}
        <Text style={styles.sectionTitle}>Attachments & SHA-256 ({attachments.length})</Text>
        {attachments.length === 0 ? (
          <Text style={styles.noFiles}>No attachments recorded.</Text>
        ) : (
          attachments.map(att => (
            <View key={att.attachment_id || att.attachmentId} style={styles.attachmentCard}>
              <Text style={styles.attFilename}>{att.original_name || att.originalName}</Text>
              <Text style={styles.attMeta}>Type: {att.mime_type || att.mimeType} • {((att.file_size || att.fileSize || 0) / 1024).toFixed(2)} KB</Text>
              
              <Text style={[
                styles.attMeta, 
                { 
                  fontWeight: 'bold', 
                  color: (att.cloud_verification_status || att.cloudVerificationStatus) === 'VERIFIED' ? '#16A34A' :
                         (att.cloud_verification_status || att.cloudVerificationStatus) === 'INTEGRITY_FAILED' ? '#DC2626' : '#64748B'
                }
              ]}>
                Integrity Check: {att.cloud_verification_status || att.cloudVerificationStatus || 'NOT_VERIFIED'}
                {(att.cloud_last_verified_at || att.cloudLastVerifiedAt) ? ` (${new Date(att.cloud_last_verified_at || att.cloudLastVerifiedAt).toLocaleDateString()})` : ''}
              </Text>

              <View style={styles.hashSection}>
                <Text style={styles.hashHeader}>Original SHA-256 (Immutable):</Text>
                <View style={styles.hashBox}>
                  <Text style={styles.hashText}>{formatHash(att.sha256)}</Text>
                  <Pressable style={styles.copyBtn} onPress={() => copyToClipboard(att.sha256, 'Original SHA-256')}>
                    <Text style={styles.copyText}>Copy</Text>
                  </Pressable>
                </View>
              </View>

              {/* View & Verify Action Row */}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                <View style={{ flex: 1 }}>
                  <PrimaryButton
                    title={openingFile === (att.attachment_id || att.attachmentId) ? "Loading..." : "View File"}
                    onPress={() => handleViewAttachment(
                      att.storage_file_id || att.storageFileId, 
                      att.attachment_id || att.attachmentId,
                      att.mime_type || att.mimeType
                    )}
                    disabled={openingFile === (att.attachment_id || att.attachmentId) || verifyingFiles[att.attachment_id || att.attachmentId]}
                    style={{ backgroundColor: '#0284C7', paddingVertical: 10 }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <PrimaryButton
                    title={verifyingFiles[att.attachment_id || att.attachmentId] ? "Checking..." : "Verify Integrity"}
                    onPress={() => handleVerifyAttachment(att)}
                    disabled={openingFile === (att.attachment_id || att.attachmentId) || verifyingFiles[att.attachment_id || att.attachmentId]}
                    style={{ backgroundColor: '#10B981', paddingVertical: 10 }}
                  />
                </View>
              </View>
            </View>
          ))
        )}

        {/* Chain of Custody Timeline */}
        <Text style={styles.sectionTitle}>Chain of Custody Timeline</Text>
        {custodyHistory.length === 0 ? (
          <Text style={styles.noFiles}>No custody history found.</Text>
        ) : (
          custodyHistory.map((event, index) => (
            <View key={event.custody_id || event.id || index} style={styles.custodyEventCard}>
              <View style={styles.custodyHeader}>
                <Text style={styles.custodyAction}>{event.action}</Text>
                <Text style={styles.custodyStatus}>{event.status}</Text>
              </View>
              <Text style={styles.custodyNotes}>{event.notes || 'No notes provided.'}</Text>
              <Text style={styles.custodyMeta}>By: {event.performed_by || event.performedBy} ({event.role})</Text>
              <Text style={styles.custodyDate}>{new Date(event.timestamp).toLocaleString()}</Text>
            </View>
          ))
        )}
      </ScrollView>

      {/* Full Screen In-App Image Viewer */}
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
  container: { padding: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { marginTop: 10, color: '#666' },
  errorTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 8, textAlign: 'center' },
  errorText: { color: '#64748B', fontSize: 14, textAlign: 'center', marginBottom: 20 },
  errorActionRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  retryButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#007AFF', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  retryButtonText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  backLinkButton: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: '#F1F5F9' },
  backLinkText: { color: '#475569', fontWeight: '600', fontSize: 14 },
  headerContainer: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  backButton: { marginRight: 15 },
  headerTitle: { fontSize: 24, fontWeight: 'bold', color: '#007AFF', fontFamily: 'monospace' },
  card: { backgroundColor: '#FFF', padding: 20, borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 20, elevation: 1 },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  label: { fontSize: 12, color: '#64748B', marginTop: 12 },
  value: { fontSize: 16, fontWeight: '600', color: '#1E293B', marginTop: 2 },
  valueSecondary: { fontSize: 13, fontWeight: '500', color: '#475569', marginTop: 2, fontFamily: 'monospace' },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 12, marginTop: 10 },
  noFiles: { fontSize: 14, color: '#888', fontStyle: 'italic', marginBottom: 10 },
  attachmentCard: { backgroundColor: '#F8FAFC', padding: 16, borderRadius: 10, borderWidth: 1, borderColor: '#CBD5E1', marginBottom: 14 },
  attFilename: { fontSize: 15, fontWeight: 'bold', color: '#1E293B', marginBottom: 4 },
  attMeta: { fontSize: 12, color: '#64748B', marginBottom: 8 },
  hashSection: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#E2E8F0' },
  hashHeader: { fontSize: 11, fontWeight: 'bold', color: '#475569', marginBottom: 4 },
  hashBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#EFF6FF', padding: 8, borderRadius: 6 },
  hashText: { fontSize: 13, fontFamily: 'monospace', color: '#007AFF' },
  copyBtn: { backgroundColor: '#007AFF', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 4 },
  copyText: { color: '#FFF', fontSize: 11, fontWeight: 'bold' },
  custodyEventCard: { backgroundColor: '#FFF', padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 10, borderLeftWidth: 4, borderLeftColor: '#007AFF', elevation: 1 },
  custodyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  custodyAction: { fontSize: 13, fontWeight: 'bold', color: '#1E293B' },
  custodyStatus: { fontSize: 11, fontWeight: 'bold', color: '#166534' },
  custodyNotes: { fontSize: 13, color: '#334155', marginBottom: 6 },
  custodyMeta: { fontSize: 11, color: '#64748B' },
  custodyDate: { fontSize: 11, color: '#94A3B8', marginTop: 2 },
  modalViewerContainer: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.95)', justifyContent: 'center', alignItems: 'center' },
  closeModalButton: { position: 'absolute', top: 50, right: 20, zIndex: 10, padding: 10 },
  fullScreenImage: { width: '100%', height: '80%' }
});
