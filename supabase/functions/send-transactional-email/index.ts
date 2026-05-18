import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
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

    const LOVABLE_EMAIL_KEY = Deno.env.get("LOVABLE_EMAIL_API_KEY") ?? "";
    const FROM_EMAIL        = Deno.env.get("LOVABLE_FROM_EMAIL") ?? "notify@notify.tablefinder.ai";

    if (!LOVABLE_EMAIL_KEY) {
      throw new Error("LOVABLE_EMAIL_API_KEY is not configured");
    }

    // Render the React Email template to HTML
    const html    = await render(tmpl.component(templateData as any));
    const subject = tmpl.subject(templateData as any);

    const payload: Record<string, unknown> = {
      from:    FROM_EMAIL,
      to:      recipientEmail,
      subject,
      html,
    };
    if (idempotencyKey) payload.idempotencyKey = idempotencyKey;

    const resp = await fetch("https://api.lovable.email/v1/send", {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${LOVABLE_EMAIL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Email API error ${resp.status}: ${err.slice(0, 300)}`);
    }

    const result = await resp.json();
    return new Response(JSON.stringify({ success: true, result }), {
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
