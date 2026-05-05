import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { SearchX } from "lucide-react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404: non-existent route accessed:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Helmet>
        <title>Page Not Found — TableFinder</title>
        <meta name="description" content="This page doesn't exist. Head back to TableFinder to find restaurant reservations." />
      </Helmet>

      <header className="pt-6 pb-3 px-4 text-center">
        <Link to="/" className="inline-block">
          <span className="font-heading text-3xl font-bold text-foreground tracking-tight">
            Table<span className="text-primary">Finder</span>
          </span>
        </Link>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 gap-5">
        <SearchX className="h-14 w-14 text-muted-foreground" aria-hidden="true" />
        <h1 className="font-heading text-4xl font-bold text-foreground">404</h1>
        <p className="text-muted-foreground font-body text-lg text-center max-w-sm">
          This page doesn't exist. Let's find you a table instead.
        </p>
        <Link
          to="/"
          className="mt-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-lg font-body font-medium hover:bg-primary/90 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Back to Search
        </Link>
      </main>

      <footer className="py-6 text-center border-t border-border">
        <nav className="flex justify-center gap-6 mb-3">
          <Link to="/about" className="text-xs text-muted-foreground hover:text-foreground font-body transition-colors">About</Link>
          <Link to="/how-it-works" className="text-xs text-muted-foreground hover:text-foreground font-body transition-colors">How It Works</Link>
        </nav>
      </footer>
    </div>
  );
};

export default NotFound;
