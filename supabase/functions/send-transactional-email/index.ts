import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { render } from "npm:@react-email/render@0.0.17";
import { templates, type TemplateMap } from "../_shared/transactional-email-templates/registry.ts";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const {
      templateName,
      recipientEmail,
      templateData,
      idempotencyKey,
    }: {
      templateName:    keyof TemplateMap;
      recipientEmail:  string;
      templateData:    TemplateMap[keyof TemplateMap];
      idempotencyKey?: string;
    } = await req.json();

    // ── Validate input ──────────────────────────────────────────────────────
    if (!templateName || !recipientEmail || !templateData) {
      return new Response(
        JSON.stringify({ error: "templateName, recipientEmail, and templateData are required" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    const tmpl = templates[templateName];
    if (!tmpl) {
      return new Response(
        JSON.stringify({ error: `Unknown template: ${templateName}` }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    // ── Service-role Supabase client ────────────────────────────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Suppression check ───────────────────────────────────────────────────
    const { data: suppressed } = await supabase
      .from("suppressed_emails")
      .select("email")
      .eq("email", recipientEmail)
      .maybeSingle();

    if (suppressed) {
      await supabase.from("email_send_log").insert({
        template_name:   templateName,
        recipient_email: recipientEmail,
        status:          "suppressed",
      });
      console.log(`[send-transactional-email] ${recipientEmail} is suppressed — skipping`);
      return new Response(JSON.stringify({ success: true, suppressed: true }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Get-or-create unsubscribe token ─────────────────────────────────────
    const { data: existingToken } = await supabase
      .from("email_unsubscribe_tokens")
      .select("token")
      .eq("email", recipientEmail)
      .is("used_at", null)
      .maybeSingle();

    let unsubscribeToken: string;
    if (existingToken?.token) {
      unsubscribeToken = existingToken.token;
    } else {
      unsubscribeToken = crypto.randomUUID();
      await supabase.from("email_unsubscribe_tokens").insert({
        email: recipientEmail,
        token: unsubscribeToken,
      });
    }

    // ── Render template ─────────────────────────────────────────────────────
    const html    = await render(tmpl.component(templateData as any));
    const subject = tmpl.subject(templateData as any);

    // ── Insert pending log row ──────────────────────────────────────────────
    const messageId = crypto.randomUUID();
    await supabase.from("email_send_log").insert({
      message_id:      messageId,
      template_name:   templateName,
      recipient_email: recipientEmail,
      status:          "pending",
    });

    // ── Enqueue via pgmq RPC ────────────────────────────────────────────────
    const { error: enqueueError } = await supabase.rpc("enqueue_email", {
      queue_name: "transactional_emails",
      payload: {
        to:               recipientEmail,
        from:             "TableFinder <notify@notify.tablefinder.ai>",
        sender_domain:    "notify.tablefinder.ai",
        subject,
        html,
        purpose:          "transactional",
        label:            templateName,
        idempotency_key:  idempotencyKey ?? messageId,
        message_id:       messageId,
        unsubscribe_token: unsubscribeToken,
        queued_at:        new Date().toISOString(),
      },
    });

    if (enqueueError) throw new Error(`enqueue_email RPC failed: ${enqueueError.message}`);

    console.log(`[send-transactional-email] enqueued ${templateName} → ${recipientEmail} (${messageId})`);
    return new Response(JSON.stringify({ success: true, messageId }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[send-transactional-email]", err?.message);
    return new Response(JSON.stringify({ error: err?.message ?? "Failed to send email" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
