import { Link } from "react-router-dom";

export function SiteFooter() {
  return (
    <footer className="py-6 text-center border-t border-border space-y-2">
      <nav className="flex justify-center gap-4 flex-wrap">
        <Link to="/" className="text-xs text-muted-foreground hover:text-primary transition-colors font-body">Home</Link>
        <Link to="/about" className="text-xs text-muted-foreground hover:text-primary transition-colors font-body">About</Link>
        <Link to="/how-it-works" className="text-xs text-muted-foreground hover:text-primary transition-colors font-body">How It Works</Link>
        <Link to="/contact" className="text-xs text-muted-foreground hover:text-primary transition-colors font-body">Contact</Link>
        <Link to="/privacy" className="text-xs text-muted-foreground hover:text-primary transition-colors font-body">Privacy</Link>
        <Link to="/terms" className="text-xs text-muted-foreground hover:text-primary transition-colors font-body">Terms</Link>
      </nav>
      <p className="text-xs text-muted-foreground font-body">
        Resy · Tock · Yelp · SevenRooms · TheFork ·{" "}
        <a
          href="https://www.opentable.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-emerald-400 hover:text-emerald-300 transition-colors"
        >
          Powered by OpenTable
        </a>
      </p>
      <p className="text-xs text-muted-foreground/60 font-body">© {new Date().getFullYear()} TableFinder</p>
    </footer>
  );
}
