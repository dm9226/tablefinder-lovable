import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { SiteFooter } from "@/components/SiteFooter";

const schema = z.object({
  name:    z.string().min(1, "Name is required").max(100, "Name must be 100 characters or less"),
  email:   z.string().email("Please enter a valid email address").max(254, "Email is too long"),
  message: z.string().min(1, "Message is required").max(2000, "Message must be 2000 characters or less"),
});

type FormValues = z.infer<typeof schema>;

const Contact = () => {
  const [submitted, setSubmitted] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const messageValue = watch("message") ?? "";

  const onSubmit = async (data: FormValues) => {
    try {
      const id = crypto.randomUUID();

      // Insert into contact_submissions (no .select() — insert-only policy)
      const { error: dbError } = await supabase
        .from("contact_submissions")
        .insert({ id, name: data.name, email: data.email, message: data.message });

      if (dbError) throw new Error(dbError.message);

      // Send notification email via Lovable transactional email
      const { error: emailError } = await supabase.functions.invoke("send-transactional-email", {
        body: {
          templateName:   "contact-form-notification",
          recipientEmail: "contact@tablefinder.ai",
          idempotencyKey: `contact-${id}`,
          templateData:   { name: data.name, email: data.email, message: data.message },
        },
      });

      if (emailError) {
        // DB insert succeeded — don't block the user, just log
        console.error("[contact] email send error:", emailError.message);
      }

      setSubmitted(true);
      toast.success("Message sent! We'll be in touch within 1–2 business days.");
    } catch (err: any) {
      console.error("[contact] submit error:", err);
      toast.error("Something went wrong. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Helmet>
        <title>Contact — TableFinder</title>
        <meta name="description" content="Get in touch with the TableFinder team." />
        <link rel="canonical" href="https://tablefinder.ai/contact" />
      </Helmet>

      <header className="pt-6 pb-3 px-4 text-center">
        <Link to="/" className="inline-block">
          <h1 className="font-heading text-3xl md:text-4xl font-bold text-foreground tracking-tight">
            Table<span className="text-primary">Finder</span>
          </h1>
        </Link>
      </header>

      <main className="flex-1 max-w-2xl mx-auto px-4 py-10 w-full">
        <h2 className="font-heading text-3xl md:text-4xl font-bold text-foreground mb-2">
          Contact
        </h2>
        <p className="text-muted-foreground font-body text-sm mb-8">
          We aim to respond within 1–2 business days.
        </p>

        {submitted ? (
          <div className="p-8 rounded-lg bg-card border border-border text-center space-y-2">
            <p className="font-heading text-xl font-semibold text-foreground">Thank you!</p>
            <p className="text-muted-foreground font-body text-sm">
              Your message has been sent. We'll be in touch soon.
            </p>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit(onSubmit)}
            className="p-6 rounded-lg bg-card border border-border space-y-5"
            noValidate
          >
            {/* Name */}
            <div className="space-y-1.5">
              <label
                htmlFor="contact-name"
                className="text-sm font-body font-medium text-foreground"
              >
                Name
              </label>
              <input
                id="contact-name"
                type="text"
                autoComplete="name"
                placeholder="Your name"
                {...register("name")}
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-foreground font-body text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                disabled={isSubmitting}
              />
              {errors.name && (
                <p className="text-xs text-destructive font-body">{errors.name.message}</p>
              )}
            </div>

            {/* Email */}
            <div className="space-y-1.5">
              <label
                htmlFor="contact-email"
                className="text-sm font-body font-medium text-foreground"
              >
                Email
              </label>
              <input
                id="contact-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                {...register("email")}
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-foreground font-body text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                disabled={isSubmitting}
              />
              {errors.email && (
                <p className="text-xs text-destructive font-body">{errors.email.message}</p>
              )}
            </div>

            {/* Message */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="contact-message"
                  className="text-sm font-body font-medium text-foreground"
                >
                  Message
                </label>
                <span className="text-xs text-muted-foreground font-body">
                  {messageValue.length}/2000
                </span>
              </div>
              <textarea
                id="contact-message"
                rows={5}
                placeholder="How can we help?"
                {...register("message")}
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-foreground font-body text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none disabled:opacity-50"
                disabled={isSubmitting}
              />
              {errors.message && (
                <p className="text-xs text-destructive font-body">{errors.message.message}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-body font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Sending…" : "Send Message"}
            </button>
          </form>
        )}
      </main>

      <SiteFooter />
    </div>
  );
};

export default Contact;
