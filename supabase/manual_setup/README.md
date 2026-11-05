# Supabase Database Security & Setup Guide

**Project:** THE BLOCKCHAIN-BASED DIGITAL EVIDENCE MANAGEMENT AND CHAIN OF CUSTODY SYSTEM  
**Target Supabase Project URL:** `https://lomidjdbmbidvfpneeyc.supabase.co`  
**Location:** `supabase/manual_setup/`  
**Security Status:** Audited & Hardened (Anti-Recursion, Row-Locked Capacity, Append-Only Forensic Ledger)

This directory contains the hardened, production-grade SQL scripts required to configure the PostgreSQL database, Row Level Security (RLS) policies, business integrity triggers, private evidence storage, and automated security verification tests for the Digital Evidence Management mobile application.

---

## 1. Security Architecture & Hardening Highlights

| Risk Vector | Vulnerability Found in Original Setup | Hardened Repair Implemented |
| :--- | :--- | :--- |
| **Profile Exposure** | `profiles_select_policy` contained unconditional `OR true`, exposing all user accounts globally. | Removed `OR true`. Scoped strictly to caller, active team peers, and supervising Higher Officer. Added `find_officer_by_email()` RPC. |
| **Team Leakage** | `teams_select_policy` contained unconditional `OR true`. | Removed `OR true`. Scoped to active team membership. Added `lookup_team_by_code()` RPC for secure team registration. |
| **Self-Elevation** | User signup trigger trusted `raw_user_meta_data->>'role'` to grant `HIGHER_OFFICER`. | `handle_new_user()` strictly forces `OFFICER` for all self-registrations. Higher Officers must be promoted via `promote_officer_to_higher_officer()`. |
| **Team Self-Enrollment** | `team_members_insert_policy` allowed ordinary officers to insert themselves into arbitrary teams. | Removed self-enrollment. Only supervising Higher Officers can enroll officers into teams. |
| **5-Officer Quota Race** | Capacity check used non-locking `SELECT COUNT(*)`, vulnerable to concurrent addition over-allocation. | Implemented row-level lock (`PERFORM 1 FROM public.teams WHERE id = NEW.team_id FOR UPDATE;`), making quota enforcement atomic. |
| **Custody Tampering** | Forensically sensitive custody and audit records could be modified if admin rights were misused. | Hardened PostgreSQL triggers (`enforce_custody_immutability`) that abort any `UPDATE` or `DELETE` on `evidence_custody` and `audit_logs`. |
| **Transfer Forgery** | `accept_custody_transfer()` trusted caller-supplied display names and lacked multi-factor validations. | Rewrote procedure to extract verified profile names from DB, lock rows with `FOR UPDATE`, and validate active team membership, sender ownership, and evidence bindings. |
| **Dual-Auth Deletion** | Officers could attempt client-side table updates to mark evidence `DELETED`. | Implemented `approve_evidence_deletion()` requiring Higher Officer authority and enforcing dual-authorization (supervisor cannot approve their own request). |
| **Storage Path Malformation** | Direct cast `(storage.foldername(name))[1]::uuid` would crash queries on non-UUID paths. | Implemented `safe_cast_uuid()` helper returning NULL on malformed paths. Validated evidence existence and team bounds on upload/download. |
| **Blockchain Forgery** | Clients could insert `CONFIRMED` status records directly into `blockchain_anchors`. | Restricted client inserts to `status = 'PENDING'`. Only backend `service_role` (Edge Function) can confirm transactions. |
| **Policy Drop Safety** | Previous setup dropped all policies across `public` schema. | Targeted policy cleanup explicitly constrained to application tables only. |

---

## 2. File Inventory

| File | Purpose | Description |
| :--- | :--- | :--- |
| **`05_complete_setup.sql`** | **Complete Consolidated Setup (Recommended)** | Single all-in-one script containing the entire schema, indexes, helpers, RLS policies, triggers, and storage configuration wrapped in a transaction (`BEGIN; ... COMMIT;`). |
| **`01_database_schema.sql`** | Core Schema & Tables | Defines all 11 tables, foreign keys, performance indexes, and `safe_cast_uuid()` utility. |
| **`02_security_policies.sql`** | Row Level Security (RLS) | Security helper functions and granular RLS policies for all 11 tables. |
| **`03_functions_triggers.sql`** | Functions, Triggers & Procedures | Immutability triggers, 5-officer atomic quota, `accept_custody_transfer()`, and `approve_evidence_deletion()`. |
| **`04_storage_policies.sql`** | Storage Bucket & Policies | Creates private `evidence-files` bucket (50 MB limit) and secures `storage.objects`. |
| **`06_security_tests.sql`** | Automated Verification Test Suite | Executable transaction script verifying all 18 security controls with clean rollback. |

---

## 3. How to Deploy in Supabase Dashboard

### Recommended: All-in-One Deployment
1. Log in to your Supabase Dashboard:  
   **[https://supabase.com/dashboard/project/lomidjdbmbidvfpneeyc](https://supabase.com/dashboard/project/lomidjdbmbidvfpneeyc)**
2. In the left navigation, select **SQL Editor** (`>_`).
3. Click **"New query"**.
4. Open `supabase/manual_setup/05_complete_setup.sql` in your local text editor.
5. Copy the entire file content and paste it into the Supabase SQL Editor.
6. Click **"Run"** (green button or `Ctrl+Enter`).
7. Verify that the output returns **`Success. No rows returned`**.

### Executing the Security Test Suite
1. After running `05_complete_setup.sql`, create another **"New query"** in the SQL Editor.
2. Open `supabase/manual_setup/06_security_tests.sql`.
3. Copy and paste the entire script into the query editor.
4. Click **"Run"**.
5. Check the **Messages / Output** tab:
   - All 18 tests will execute in an isolated transaction.
   - You should see `SECURITY TEST RESULTS: 18 / 18 PASSED (0 FAILED)`.
   - The test transaction automatically executes a clean rollback, leaving zero test data in your database.

---

## 4. Post-Deployment Dashboard Settings

### 1. Disable Email Confirmation (Recommended for Local Dev)
By default, Supabase requires email confirmation before a user can sign in.
- Go to **Authentication &rarr; Providers &rarr; Email**.
- Under **Email Auth**, toggle **"Confirm email"** to **OFF**.
- Click **Save**.

### 2. Provisioning the First Higher Officer
Because public self-registration defaults strictly to `OFFICER`:
1. Have the lead investigator sign up in the mobile app (or create them via **Authentication &rarr; Users**).
2. Note their User UID from the Auth table.
3. In the SQL Editor, run this one-time command to elevate them to Higher Officer:
   ```sql
   UPDATE public.profiles 
   SET role = 'HIGHER_OFFICER' 
   WHERE user_id = '<COPIED_USER_UID>';
   ```
4. Future Higher Officers can be promoted directly by this Higher Officer using the app or the `promote_officer_to_higher_officer()` procedure.

### 3. Deploy Blockchain Edge Function
Deploy the blockchain notarization worker from your terminal:
```bash
npx supabase link --project-ref lomidjdbmbidvfpneeyc
npx supabase secrets set BLOCKCHAIN_RPC_URL="<RPC_URL>" BLOCKCHAIN_CONTRACT_ADDRESS="<CONTRACT_ADDRESS>" BLOCKCHAIN_CHAIN_ID="<CHAIN_ID>" BLOCKCHAIN_PRIVATE_KEY="<RELAYER_KEY>"
npx supabase functions deploy process-blockchain-anchor
```
