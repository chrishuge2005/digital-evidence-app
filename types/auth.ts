import { Session, User } from '@supabase/supabase-js';

export type UserRole = 'OFFICER' | 'HIGHER_OFFICER';

export interface Profile {
  id: string;
  user_id: string;
  display_name: string;
  email: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export type AuthContextType = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (name: string, email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<{ error: Error | null }>;
  refreshProfile: () => Promise<void>;
};