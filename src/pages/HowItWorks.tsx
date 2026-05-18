import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { MessageSquare, Radar, CalendarCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/SiteFooter";

const steps = [
  {
    icon: MessageSquare,
    title: "Describe What You Want",
    description:
      "Type a natural language query like \"sushi for 2 Friday night in Brooklyn\" — no filters to fiddle with.",
  },
  {
    icon: Radar,
    title: "We Search Every Platform",
    description:
      "TableFinder searches Resy, OpenTable, Tock, Yelp, SevenRooms, and TheFork and verifies real-time availability for your exact date, time, and party size.",
  },
  {
    icon: CalendarCheck,
    title: "Book in One Click",
    description:
      "See all available time slots side by side. Click any slot to go directly to the booking page — pre-filled and ready to confirm.",
  },
];

const HowItWorks = () => (
  <div className="min-h-screen bg-background flex flex-col">
    <Helmet>
      <title>How TableFinder Works — Find Reservations in Seconds</title>
      <meta name="description" content="Search for Resy restaurant reservations in 3 simple steps. Describe what you want, we find available tables, and you book in one click." />
      <link rel="canonical" href="https://tablefinder.ai/how-it-works" />
    </Helmet>

    <header className="pt-6 pb-3 px-4 text-center">
      <Link to="/" className="inline-block">
        <h1 className="font-heading text-3xl md:text-4xl font-bold text-foreground tracking-tight">
          Table<span className="text-primary">Finder</span>
        </h1>
      </Link>
    </header>

    <main className="flex-1 max-w-2xl mx-auto px-4 py-10">
      <h2 className="font-heading text-3xl md:text-4xl font-bold text-foreground mb-3 text-center">
        How It Works
      </h2>

      <p className="text-muted-foreground font-body text-lg text-center mb-10">
        Three steps from hungry to booked.
      </p>

      <div className="grid gap-8 mb-12">
        {steps.map((step, i) => (
          <div key={i} className="flex items-start gap-5 p-5 rounded-lg bg-card border border-border">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 shrink-0">
              <step.icon className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-xs font-body text-muted-foreground mb-1 uppercase tracking-wider">Step {i + 1}</p>
              <h3 className="font-heading text-lg font-semibold text-foreground mb-1">{step.title}</h3>
              <p className="text-muted-foreground font-body text-sm leading-relaxed">{step.description}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="text-center">
        <Link to="/">
          <Button size="lg" className="font-body">Find a Table Now</Button>
        </Link>
      </div>
    </main>

    <SiteFooter />
  </div>
);

export default HowItWorks;
