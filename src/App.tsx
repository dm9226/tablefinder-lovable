import { Helmet } from "react-helmet-async";

const App = () => (
  <div className="h-screen bg-background flex items-center justify-center px-6">
    <Helmet>
      <title>TableFinder — Coming Soon</title>
      <meta name="robots" content="noindex, nofollow" />
    </Helmet>
    <main className="max-w-md text-center space-y-4">
      <h1 className="font-heading text-4xl md:text-5xl font-extrabold tracking-tight">
        <span className="text-foreground">Table</span><span className="text-primary">Finder</span>
      </h1>
      <p className="text-muted-foreground font-body text-base md:text-lg">
        A better way to find restaurant reservations is coming soon.
      </p>
    </main>
  </div>
);

export default App;
