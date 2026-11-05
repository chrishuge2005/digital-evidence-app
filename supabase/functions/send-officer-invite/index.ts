import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * SHA-256 helper in Deno Web Crypto
 */
async function hashToken(token: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generates a secure random 32-byte hex token
 */
function generateSecureToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
    const smtpUser = Deno.env.get("SMTP_USER") || "";
    const appRedirectUrl = Deno.env.get("APP_REDIRECT_URL") || "digital-evidence-app://accept-invite";

    console.log("[send-officer-invite] Request received", {
      method: req.method,
      hasAuth: Boolean(req.headers.get("Authorization")),
      hasServiceKey: Boolean(supabaseServiceKey),
      hasResendKey: Boolean(resendApiKey),
    });

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error("[send-officer-invite] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return new Response(
        JSON.stringify({ error: "Server credentials not configured in Edge Function environment." }),
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
    const {
      data: { user: callerUser },
      error: authError,
    } = await adminClient.auth.getUser(token);

    if (authError || !callerUser) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session token." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Parse and validate request body
    const body = await req.json().catch(() => ({}));
    const { teamId, email, displayName } = body;

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
      .select("id, name, team_code, higher_officer_id")
      .eq("id", teamId)
      .eq("higher_officer_id", callerUser.id)
      .single();

    if (teamErr || !teamData) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: You do not supervise this department team." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Generate secure token & token hash
    const rawToken = generateSecureToken();
    const tokenHash = await hashToken(rawToken);

    // 6. Call create_officer_invitation database RPC with caller's identity context
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") || "", {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });

    const { data: rpcData, error: rpcErr } = await userClient.rpc("create_officer_invitation", {
      p_team_id: teamId,
      p_email: cleanEmail,
      p_display_name: cleanDisplayName,
      p_token_hash: tokenHash,
      p_expires_in_days: 7,
    });

    if (rpcErr) {
      console.error("RPC create_officer_invitation error:", rpcErr);
      const isCapacityError = rpcErr.message?.toLowerCase().includes("capacity exceeded");
      const isConflictError = rpcErr.message?.toLowerCase().includes("conflict") || rpcErr.message?.toLowerCase().includes("already");
      const statusCode = isCapacityError ? 422 : isConflictError ? 409 : 400;

      return new Response(
        JSON.stringify({ error: rpcErr.message || "Failed to create officer invitation." }),
        { status: statusCode, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 7. Dispatch Email
    // Format acceptance link: digital-evidence-app://accept-invite?token=<rawToken>&email=<cleanEmail>
    const inviteLink = `${appRedirectUrl}?token=${rawToken}&email=${encodeURIComponent(cleanEmail)}`;
    const invitingOfficerName = callerProfile.display_name || "Supervising Higher Officer";
    const subject = `Invitation to Join ${teamData.name} - Digital Evidence Management`;
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; borderRadius: 8px;">
        <h2 style="color: #0f172a;">Digital Evidence Management System</h2>
        <p style="color: #334155; font-size: 16px;">Hello <strong>${cleanDisplayName}</strong>,</p>
        <p style="color: #334155; font-size: 15px; line-height: 1.5;">
          You have been officially invited by <strong>${invitingOfficerName}</strong> to join 
          <strong>${teamData.name}</strong> (${teamData.team_code}) as an authorized Officer.
        </p>
        <div style="margin: 30px 0; text-align: center;">
          <a href="${inviteLink}" 
             style="background-color: #007aff; color: #ffffff; padding: 12px 28px; font-size: 16px; font-weight: bold; text-decoration: none; border-radius: 6px; display: inline-block;">
            Accept Official Invitation
          </a>
        </div>
        <p style="color: #64748b; font-size: 13px; line-height: 1.4;">
          If clicking the button above does not open the app, copy and open this link on your officer device:
          <br />
          <a href="${inviteLink}" style="color: #007aff; word-break: break-all;">${inviteLink}</a>
        </p>
        <p style="color: #64748b; font-size: 12px; margin-top: 25px; border-top: 1px solid #e2e8f0; padding-top: 15px;">
          Note: This invitation link is unique to your email address and will expire in 7 days.
        </p>
      </div>
    `;

    let emailDelivered = false;
    let emailProviderError = "";

    // A) Try Resend API if configured
    if (resendApiKey) {
      try {
        const fromEmail = Deno.env.get("EMAIL_FROM") || "evidence-system@department.gov";
        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [cleanEmail],
            subject: subject,
            html: emailHtml,
          }),
        });

        if (resendRes.ok) {
          emailDelivered = true;
        } else {
          const resendErr = await resendRes.text();
          console.error("Resend API failed:", resendErr);
          emailProviderError = `Resend error: ${resendErr}`;
        }
      } catch (e: any) {
        console.error("Resend delivery exception:", e);
        emailProviderError = e.message;
      }
    }

    // B) Fallback: Supabase Auth inviteUserByEmail (Built-in Supabase SMTP mailer)
    if (!emailDelivered) {
      try {
        const { data: authInviteData, error: authInviteErr } = await adminClient.auth.admin.inviteUserByEmail(
          cleanEmail,
          {
            redirectTo: inviteLink,
            data: {
              display_name: cleanDisplayName,
              role: "OFFICER",
              invited_team_id: teamId,
            },
          }
        );

        if (!authInviteErr && authInviteData) {
          emailDelivered = true;
        } else if (authInviteErr) {
          console.warn("Supabase auth.admin.inviteUserByEmail notice:", authInviteErr.message);
          // If the officer already has an account, inviteUserByEmail returns "User already registered"
          if (authInviteErr.message?.toLowerCase().includes("already") || authInviteErr.message?.toLowerCase().includes("registered")) {
            // Send standard password recovery / magic link with invitation link
            const { error: resetErr } = await adminClient.auth.admin.generateLink({
              type: "magiclink",
              email: cleanEmail,
              options: { redirectTo: inviteLink },
            });
            if (!resetErr) {
              emailDelivered = true;
            } else {
              emailProviderError = resetErr.message;
            }
          } else {
            emailProviderError = authInviteErr.message;
          }
        }
      } catch (authErr: any) {
        console.error("Supabase inviteUserByEmail exception:", authErr);
        emailProviderError = authErr.message;
      }
    }

    if (!emailDelivered) {
      // Revert/revoke the invitation record so we don't leave a phantom active invitation
      await adminClient
        .from("officer_invitations")
        .update({ status: "REVOKED", updated_at: new Date().toISOString() })
        .eq("token_hash", tokenHash);

      return new Response(
        JSON.stringify({
          error: `Email delivery failed: ${emailProviderError || "Unable to deliver invitation email. Verify SMTP / Resend configuration."}`,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Official invitation email successfully sent to ${cleanEmail}.`,
        invitation: {
          teamId,
          email: cleanEmail,
          displayName: cleanDisplayName,
          expiresAt: rpcData?.expires_at,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("Unhandled error in send-officer-invite:", err);
    return new Response(
      JSON.stringify({ error: err?.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
