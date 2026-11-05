import { Profile } from './auth';

export type TeamMemberRole = 'OFFICER' | 'HIGHER_OFFICER';
export type TeamMemberStatus = 'ACTIVE' | 'INACTIVE';

export interface Team {
  id: string;
  name: string;
  higher_officer_id: string;
  created_at: string;
  updated_at: string;
  higher_officer?: Profile;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: TeamMemberRole;
  status: TeamMemberStatus;
  joined_at: string;
  removed_at: string | null;
  profile?: Profile;
}