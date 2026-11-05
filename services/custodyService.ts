import AsyncStorage from '@react-native-async-storage/async-storage';
import { CustodyEvent, CustodyAction } from '../types/custody';
import { supabase } from './supabase';

const CUSTODY_KEY = '@local_custody_events';

export const custodyService = {
  generateCustodyId(): string {
    const year = new Date().getFullYear();
    const randomNum = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
    return `CUS-${year}-${randomNum}`;
  },

  async getAllCustodyEvents(): Promise<CustodyEvent[]> {
    try {
      const stored = await AsyncStorage.getItem(CUSTODY_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.error("Failed to fetch custody events:", error);
      return [];
    }
  },

  async getLocalCustodyHistory(evidenceId: string): Promise<CustodyEvent[]> {
    try {
      const events = await this.getAllCustodyEvents();
      return events
        .filter(e => e.evidenceId === evidenceId)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    } catch (error) {
      console.error("Failed to fetch local evidence custody history:", error);
      return [];
    }
  },

  async getCloudCustodyHistory(evidenceId: string): Promise<CustodyEvent[]> {
    try {
      // 1. Fetch the primary UUID for the evidence record
      const { data: cloudEvidence, error: fetchError } = await supabase
        .from('evidence')
        .select('id')
        .eq('evidence_id', evidenceId)
        .maybeSingle();

      if (fetchError || !cloudEvidence) {
        return [];
      }

      // 2. Fetch custody events associated with that internal UUID
      const { data, error } = await supabase
        .from('evidence_custody')
        .select('*')
        .eq('evidence_id', cloudEvidence.id)
        .order('timestamp', { ascending: false });

      if (error) {
        console.warn('Cloud custody fetch warning:', error.message);
        return [];
      }

      if (!data) return [];

      return data.map((row) => ({
        custodyId: row.custody_id,
        evidenceId: evidenceId, // Map back to the string ID for the app UI
        teamId: row.team_id,
        action: row.action as CustodyAction,
        performedByUserId: row.performed_by_user_id,
        performedBy: row.performed_by,
        role: row.role,
        timestamp: row.timestamp,
        status: row.status,
        notes: row.notes,
        recipientUserId: row.recipient_user_id,
        recipientName: row.recipient_name,
        recipientRole: row.recipient_role,
        syncStatus: 'SYNCED',
        lastSyncedAt: row.timestamp,
      }));
    } catch (err) {
      console.error('Exception fetching cloud custody:', err);
      return [];
    }
  },

  async getMergedCustodyHistory(evidenceId: string): Promise<CustodyEvent[]> {
    const local = await this.getLocalCustodyHistory(evidenceId);
    const cloud = await this.getCloudCustodyHistory(evidenceId);

    // Merge logic: Use cloud records as a base, but overwrite with local if local exists.
    const mergedMap = new Map<string, CustodyEvent>();
    
    cloud.forEach((event) => mergedMap.set(event.custodyId, event));
    local.forEach((event) => mergedMap.set(event.custodyId, event));

    return Array.from(mergedMap.values()).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  },

  async createCustodyEvent(params: {
    evidenceId: string;
    teamId: string;
    action: CustodyAction;
    performedByUserId: string;
    performedBy: string;
    role: "OFFICER" | "HIGHER_OFFICER";
    status: "SUCCESS" | "FAILED";
    notes?: string;
  }): Promise<CustodyEvent> {
    if (!params.evidenceId || !params.teamId || !params.action || !params.performedByUserId || !params.performedBy || !params.role || !params.status) {
      throw new Error("Missing required fields for custody event creation.");
    }

    const newEvent: CustodyEvent = {
      custodyId: this.generateCustodyId(),
      evidenceId: params.evidenceId,
      teamId: params.teamId,
      action: params.action,
      performedByUserId: params.performedByUserId,
      performedBy: params.performedBy,
      role: params.role,
      timestamp: new Date().toISOString(),
      status: params.status,
      notes: params.notes,
      syncStatus: "PENDING"
    };

    try {
      // 1. Save locally (Append-only & Offline First)
      const existingEvents = await this.getAllCustodyEvents();
      const updatedEvents = [...existingEvents, newEvent];
      await AsyncStorage.setItem(CUSTODY_KEY, JSON.stringify(updatedEvents));

      // 2. Trigger background cloud synchronization dynamically to break circular dependencies
      import('./syncService').then(({ syncService }) => {
        syncService.syncCustodyEvent(newEvent.custodyId).catch(err => {
          console.log("Background custody sync deferred:", err);
        });
      }).catch(importErr => {
        console.warn("Failed to load syncService dynamically:", importErr);
      });

      return newEvent;
    } catch (error) {
      console.error("Failed to save custody event:", error);
      throw new Error("Failed to persist custody event locally.");
    }
  },

  async updateSyncStatus(
    custodyId: string,
    status: 'LOCAL_ONLY' | 'PENDING' | 'SYNCED' | 'FAILED',
    lastSyncedAt?: string,
    syncError?: string
  ): Promise<void> {
    try {
      const stored = await AsyncStorage.getItem(CUSTODY_KEY);
      if (!stored) return;
      
      const history: CustodyEvent[] = JSON.parse(stored);
      const index = history.findIndex((e) => e.custodyId === custodyId);

      if (index !== -1) {
        history[index].syncStatus = status;
        if (lastSyncedAt) history[index].lastSyncedAt = lastSyncedAt;
        
        if (syncError !== undefined) {
          history[index].syncError = syncError;
        } else {
          delete history[index].syncError;
        }
        
        await AsyncStorage.setItem(CUSTODY_KEY, JSON.stringify(history));
      }
    } catch (error) {
      console.error("Failed to update custody sync status:", error);
    }
  }
};