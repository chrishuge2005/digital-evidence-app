import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: "Supabase service credentials not configured in Edge Function environment." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace(/^Bearer\s+/i, "");
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // 1. Authenticate caller using JWT
    const { data: { user: callerUser }, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !callerUser) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session token." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Parse and validate request body
    const body = await req.json().catch(() => ({}));
    const { teamId, email, displayName, badgeNumber, password } = body;

    if (!teamId) {
      return new Response(
        JSON.stringify({ error: "Department Team ID is required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!email || !String(email).trim()) {
      return new Response(
        JSON.stringify({ error: "Officer email address is required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!displayName || !String(displayName).trim()) {
      return new Response(
        JSON.stringify({ error: "Officer full name is required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!emailRegex.test(cleanEmail)) {
      return new Response(
        JSON.stringify({ error: `Invalid email address format: "${cleanEmail}".` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const cleanDisplayName = String(displayName).trim().slice(0, 100);
    const cleanBadgeNumber = badgeNumber ? String(badgeNumber).trim().slice(0, 50) : null;

    if (password && String(password).length < 6) {
      return new Response(
        JSON.stringify({ error: "Password must be at least 6 characters long." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Verify caller is a Higher Officer
    const { data: callerProfile, error: profileErr } = await adminClient
      .from("profiles")
      .select("role, display_name")
      .eq("user_id", callerUser.id)
      .single();

    if (profileErr || callerProfile?.role !== "HIGHER_OFFICER") {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Caller is not a Higher Officer." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Verify caller supervises the requested department team
    const { data: teamData, error: teamErr } = await adminClient
      .from("teams")
      .select("id, name, higher_officer_id")
      .eq("id", teamId)
      .eq("higher_officer_id", callerUser.id)
      .single();

    if (teamErr || !teamData) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: You do not supervise this department team." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Check if profile already exists
    const { data: existingProfile } = await adminClient
      .from("profiles")
      .select("user_id, email, display_name, role, team_id, badge_number")
      .ilike("email", cleanEmail)
      .maybeSingle();

    let createdAuthAccount = false;
    let invitedAuthAccount = false;

    if (existingProfile) {
      // Role guard
      if (existingProfile.role === "HIGHER_OFFICER") {
        return new Response(
          JSON.stringify({ error: "Invalid operation: Cannot add another Higher Officer as an ordinary team member." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Conflicting team check
      if (existingProfile.team_id && existingProfile.team_id !== teamId) {
        return new Response(
          JSON.stringify({ error: `Conflict: Officer "${cleanEmail}" is already assigned to another department team. Use an official transfer request to reassign officers.` }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } else {
      // 6. User does not exist in profiles - provision Auth account or send invite
      if (password && String(password).length >= 6) {
        const { data: newAuthData, error: createAuthErr } = await adminClient.auth.admin.createUser({
          email: cleanEmail,
          password: String(password),
          email_confirm: true,
          user_metadata: {
            full_name: cleanDisplayName,
            display_name: cleanDisplayName,
            role: "OFFICER",
            badge_number: cleanBadgeNumber,
          },
        });

        if (createAuthErr || !newAuthData?.user) {
          return new Response(
            JSON.stringify({ error: `Failed to create officer credentials: ${createAuthErr?.message || "Unknown error"}` }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        createdAuthAccount = true;
      } else {
        const { data: inviteData, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(cleanEmail, {
          data: {
            full_name: cleanDisplayName,
            display_name: cleanDisplayName,
            role: "OFFICER",
            badge_number: cleanBadgeNumber,
          },
        });

        if (inviteErr || !inviteData?.user) {
          return new Response(
            JSON.stringify({ error: `Failed to send officer invitation: ${inviteErr?.message || "Unknown error"}` }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        invitedAuthAccount = true;
      }

      // Ensure profile display_name and badge are synchronized
      const { data: createdUser } = await adminClient
        .from("profiles")
        .select("user_id")
        .ilike("email", cleanEmail)
        .maybeSingle();

      if (createdUser) {
        await adminClient
          .from("profiles")
          .update({
            display_name: cleanDisplayName,
            badge_number: cleanBadgeNumber,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", createdUser.user_id);
      }
    }

    // 7. Invoke the trusted database RPC 'add_officer_to_team' to enforce capacity quota and record audit trail
    // Set the caller's identity context so auth.uid() inside the RPC matches the Higher Officer
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") || "", {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });

    const { data: rpcData, error: rpcErr } = await userClient.rpc("add_officer_to_team", {
      p_team_id: teamId,
      p_email: cleanEmail,
      p_badge_number: cleanBadgeNumber,
    });

    if (rpcErr) {
      console.error("RPC add_officer_to_team error:", rpcErr);
      const isCapacityError = rpcErr.message?.toLowerCase().includes("capacity exceeded");
      const isConflictError = rpcErr.message?.toLowerCase().includes("conflict");
      const statusCode = isCapacityError ? 422 : isConflictError ? 409 : 400;

      return new Response(
        JSON.stringify({ error: rpcErr.message || "Failed to assign officer to team." }),
        { status: statusCode, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const actionMessage = createdAuthAccount
      ? `Officer account created with credentials and registered to ${teamData.name}.`
      : invitedAuthAccount
      ? `Invitation sent to ${cleanEmail} and officer assigned to ${teamData.name}.`
      : rpcData?.message || `Officer assigned to ${teamData.name} successfully.`;

    return new Response(
      JSON.stringify({
        success: true,
        message: actionMessage,
        action: rpcData?.action || (createdAuthAccount ? "CREATED_AND_ASSIGNED" : "ASSIGNED"),
        member: {
          user_id: rpcData?.user_id,
          email: cleanEmail,
          display_name: cleanDisplayName,
          badge_number: cleanBadgeNumber,
          team_id: teamId,
          role: "OFFICER",
          status: "ACTIVE",
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("Unhandled error in create-team-member:", err);
    return new Response(
      JSON.stringify({ error: err?.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
