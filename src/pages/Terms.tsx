import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { SiteFooter } from "@/components/SiteFooter";

const Terms = () => (
  <div className="min-h-screen bg-background flex flex-col">
    <Helmet>
      <title>Terms of Service — TableFinder</title>
      <meta name="description" content="TableFinder terms of service — how you may use the service and what to expect." />
      <link rel="canonical" href="https://tablefinder.ai/terms" />
    </Helmet>

    <header className="pt-6 pb-3 px-4 text-center">
      <Link to="/" className="inline-block">
        <h1 className="font-heading text-3xl md:text-4xl font-bold text-foreground tracking-tight">
          Table<span className="text-primary">Finder</span>
        </h1>
      </Link>
    </header>

    <main className="flex-1 max-w-2xl mx-auto px-4 py-10">
      <h2 className="font-heading text-3xl md:text-4xl font-bold text-foreground mb-2">
        Terms of Service
      </h2>
      <p className="text-xs text-muted-foreground font-body mb-8">Last updated: May 2025</p>

      <div className="space-y-8">
        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">1. About TableFinder</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            TableFinder is a restaurant reservation discovery tool that searches multiple platforms to help you find available tables. We are an independent service and are not affiliated with Resy, OpenTable, Tock, Yelp, SevenRooms, or TheFork.
          </p>
        </section>

        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">2. OpenTable</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            OpenTable availability displayed on TableFinder is powered by OpenTable. By using OpenTable results, you agree to{" "}
            <a
              href="https://www.opentable.com/legal/terms-and-conditions"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              OpenTable's Terms of Use
            </a>
            .
          </p>
        </section>

        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">3. No Guarantees</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            Availability shown is based on real-time data but is not guaranteed. TableFinder is not responsible for reservations that become unavailable between the time they are displayed and the time you attempt to book.
          </p>
        </section>

        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">4. Use of Service</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            TableFinder is provided for personal, non-commercial use only. You agree not to scrape, automate, or otherwise misuse the service.
          </p>
        </section>

        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">5. Disclaimer</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            The service is provided "as is" without warranties of any kind, express or implied. TableFinder is not liable for any damages arising from use of the service.
          </p>
        </section>

        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">6. Contact</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            Questions? Reach us via the <Link to="/contact" className="text-primary hover:underline">Contact page</Link>.
          </p>
        </section>
      </div>
    </main>

    <SiteFooter />
  </div>
);

export default Terms;
