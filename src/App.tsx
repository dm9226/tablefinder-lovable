import { Helmet } from "react-helmet-async";

const App = () => (
  <div className="min-h-screen bg-background flex items-center justify-center px-6">
    <Helmet>
      <title>TableFinder — Coming Soon</title>
      <meta
        name="description"
        content="A new way to discover where to eat — coming soon."
      />
      <link rel="canonical" href="https://tablefinder.ai/" />
    </Helmet>
    <main className="max-w-2xl text-center space-y-6">
      <h1 className="font-heading text-5xl md:text-7xl font-extrabold tracking-tight leading-none">
        <span className="text-foreground">Table</span>
        <span className="text-primary">Finder</span>
      </h1>
      <p className="font-heading text-xl md:text-2xl text-foreground/90 leading-snug">
        A new way to discover where to eat — before you even know what you want.
      </p>
      <p className="font-body text-base md:text-lg text-muted-foreground">
        Coming soon.
      </p>
    </main>
  </div>
);

export default App;
