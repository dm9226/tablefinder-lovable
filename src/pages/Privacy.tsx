import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { SiteFooter } from "@/components/SiteFooter";

const Privacy = () => (
  <div className="min-h-screen bg-background flex flex-col">
    <Helmet>
      <title>Privacy Policy — TableFinder</title>
      <meta name="description" content="TableFinder privacy policy — how we handle your search queries and location data." />
      <link rel="canonical" href="https://tablefinder.ai/privacy" />
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
        Privacy Policy
      </h2>
      <p className="text-xs text-muted-foreground font-body mb-8">Last updated: May 2025</p>

      <div className="space-y-8">
        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">1. Information We Collect</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            We collect the search queries you type into TableFinder and, only if you grant permission, your device's GPS location. TableFinder does not create user accounts and does not store any personal data on our servers.
          </p>
        </section>

        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">2. How We Use It</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            Your search query and location are used solely to search restaurant reservation platforms — Resy, OpenTable, Tock, Yelp, SevenRooms, and TheFork — on your behalf and return results. Your location is used only to rank results by distance and is never stored.
          </p>
        </section>

        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">3. Third-Party Platforms</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            Results link to third-party reservation platforms. Their privacy policies govern any data you share when completing a booking. OpenTable reservations are powered by{" "}
            <a
              href="https://www.opentable.com/legal/privacy-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              OpenTable
            </a>
            , and their privacy policy applies to any booking made through their service.
          </p>
        </section>

        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">4. Cookies &amp; Analytics</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            We do not use tracking cookies or third-party analytics. Standard server logs (IP address, timestamp) may be retained for up to 30 days for debugging purposes only.
          </p>
        </section>

        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">5. Data Sharing</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            We do not sell, rent, or share your data with any third parties.
          </p>
        </section>

        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">6. Contact</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            Questions about this policy? <Link to="/contact" className="text-primary hover:underline">Contact us</Link> via the link in the footer.
          </p>
        </section>

        <section className="p-4 rounded-lg bg-card border border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-2">7. Changes</h3>
          <p className="text-muted-foreground font-body text-sm leading-relaxed">
            We may update this policy from time to time. The "last updated" date at the top of this page will reflect any changes.
          </p>
        </section>
      </div>
    </main>

    <SiteFooter />
  </div>
);

export default Privacy;
