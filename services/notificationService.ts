import { supabase } from './supabase';

export interface AppNotification {
  id: string;
  recipient_user_id: string;
  type: string;
  title: string;
  message: string;
  evidence_id: string | null;
  transfer_request_id: string | null;
  invitation_id?: string | null;
  is_read: boolean;
  created_at: string;
}

export const notificationService = {
  async getMyNotifications(): Promise<AppNotification[]> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];

    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('recipient_user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as AppNotification[]) || [];
  },

  async markAsRead(notificationId: string): Promise<void> {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notificationId);
    if (error) throw error;
  }
};
