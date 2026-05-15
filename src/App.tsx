import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast, Toaster } from "sonner";

const App = () => {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [joined, setJoined] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    const { error } = await supabase.from("waitlist").insert({ email: email.trim().toLowerCase() });
    setSubmitting(false);
    if (error) {
      if (error.code === "23505") {
        setJoined(true);
        toast.success("You're already on the list — thank you.");
      } else {
        toast.error("Please enter a valid email address.");
      }
      return;
    }
    setJoined(true);
    toast.success("You're on the list. We'll be in touch.");
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Helmet>
        <title>TableFinder — Helping diners discover their next great meal</title>
        <meta
          name="description"
          content="TableFinder helps diners discover restaurants worth booking — then sends them straight to the reservation page."
        />
        <link rel="canonical" href="https://tablefinder.ai/" />
      </Helmet>
      <Toaster position="top-center" richColors />

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="max-w-2xl w-full text-center space-y-8">
          <h1 className="font-heading text-5xl md:text-7xl font-extrabold tracking-tight leading-none">
            <span className="text-foreground">Table</span>
            <span className="text-primary">Finder</span>
          </h1>

          <p className="font-heading text-xl md:text-2xl text-foreground/90 leading-snug max-w-xl mx-auto">
            A new way to discover where to eat — before you even know what you want.
          </p>

          <p className="font-body text-base md:text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
            Tell us "a romantic Italian spot Friday at 7" and we'll surface restaurants
            worth booking — then send you straight to the reservation page to book.
            Coming soon.
          </p>

          {joined ? (
            <div className="font-body text-base text-foreground bg-card border border-border rounded-lg px-5 py-4 max-w-md mx-auto">
              You're on the list. We'll let you know the moment we launch.
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto pt-2"
            >
              <Input
                type="email"
                required
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                className="font-body h-11 bg-card border-border"
                aria-label="Email address"
              />
              <Button
                type="submit"
                disabled={submitting}
                className="font-body h-11 px-6 whitespace-nowrap"
              >
                {submitting ? "Joining…" : "Join the waitlist"}
              </Button>
            </form>
          )}
        </div>
      </main>

      <footer className="py-6 px-6 text-center border-t border-border">
        <p className="text-xs text-muted-foreground font-body">
          Questions or partnerships?{" "}
          <a
            href="mailto:hello@tablefinder.ai"
            className="text-foreground hover:text-primary transition-colors underline-offset-4 hover:underline"
          >
            hello@tablefinder.ai
          </a>
        </p>
      </footer>
    </div>
  );
};

export default App;
