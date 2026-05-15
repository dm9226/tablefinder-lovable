import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { Search, Utensils, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

const About = () => (
  <div className="min-h-screen bg-background flex flex-col">
    <Helmet>
      <title>About TableFinder — Find Resy Reservations Near You</title>
      <meta name="description" content="TableFinder searches Resy so you can find restaurant reservations near you with a simple natural language search." />
      <link rel="canonical" href="https://tablefinder.ai/about" />
    </Helmet>

    <header className="pt-6 pb-3 px-4 text-center">
      <Link to="/" className="inline-block">
        <h1 className="font-heading text-3xl md:text-4xl font-bold text-foreground tracking-tight">
          Table<span className="text-primary">Finder</span>
        </h1>
      </Link>
    </header>

    <main className="flex-1 max-w-2xl mx-auto px-4 py-10">
      <h2 className="font-heading text-3xl md:text-4xl font-bold text-foreground mb-6">
        Resy Reservations, Instantly.
      </h2>

      <p className="text-muted-foreground font-body text-lg leading-relaxed mb-8">
        Finding a restaurant reservation shouldn't be complicated.
        TableFinder searches <strong className="text-foreground">Resy</strong> with natural language so you can find available tables near you in seconds.
      </p>

      <div className="grid gap-6 mb-10">
        <div className="flex items-start gap-4 p-4 rounded-lg bg-card border border-border">
          <Search className="w-6 h-6 text-primary mt-0.5 shrink-0" />
          <div>
            <h3 className="font-heading text-lg font-semibold text-foreground mb-1">Natural Language Search</h3>
            <p className="text-muted-foreground font-body text-sm">
              Search the way you think — "Italian dinner for 4 in Atlanta Saturday night" — and we'll handle the rest.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-4 p-4 rounded-lg bg-card border border-border">
          <Clock className="w-6 h-6 text-primary mt-0.5 shrink-0" />
          <div>
            <h3 className="font-heading text-lg font-semibold text-foreground mb-1">Verified Availability</h3>
            <p className="text-muted-foreground font-body text-sm">
              Every time slot shown is verified in real-time. No guessing — if you see it, you can book it.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-4 p-4 rounded-lg bg-card border border-border">
          <Utensils className="w-6 h-6 text-primary mt-0.5 shrink-0" />
          <div>
            <h3 className="font-heading text-lg font-semibold text-foreground mb-1">Direct Booking Links</h3>
            <p className="text-muted-foreground font-body text-sm">
              Click any time slot and go straight to the booking page with your date, time, and party size pre-filled.
            </p>
          </div>
        </div>
      </div>

      <div className="text-center">
        <Link to="/">
          <Button size="lg" className="font-body">Try a Search</Button>
        </Link>
      </div>
    </main>

    <footer className="py-6 text-center border-t border-border">
      <nav className="flex justify-center gap-6 mb-3">
        <Link to="/" className="text-xs text-muted-foreground hover:text-foreground font-body transition-colors">Home</Link>
        <Link to="/how-it-works" className="text-xs text-muted-foreground hover:text-foreground font-body transition-colors">How It Works</Link>
      </nav>
      <p className="text-xs text-muted-foreground font-body">
        TableFinder searches Resy for available reservations near you
      </p>
    </footer>
  </div>
);

export default About;
