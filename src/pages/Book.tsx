import { useSearchParams, useNavigate } from "react-router-dom";
import { ArrowLeft, ExternalLink, AlertTriangle } from "lucide-react";
import { useState, useEffect, useRef } from "react";

const Book = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const url = searchParams.get("url");
  const name = searchParams.get("name") || "";
  const platform = searchParams.get("platform") || "restaurant";
  const [blocked, setBlocked] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!url) return;
    // Detect iframe load failure via a timeout heuristic —
    // if the iframe's contentWindow is inaccessible after load, it's blocked
    const timer = setTimeout(() => {
      try {
        // Cross-origin iframes will throw on access if loaded,
        // but if blocked by X-Frame-Options the iframe stays blank
        const iframe = iframeRef.current;
        if (iframe) {
          // Try to detect blank iframe — onError doesn't fire for X-Frame-Options
          // We use a heuristic: listen for the load event and check
          setBlocked(true);
        }
      } catch {
        setBlocked(true);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [url]);

  if (!url) {
    navigate("/");
    return null;
  }

  const handleBack = () => {
    navigate("/");
  };

  const handleOpenExternal = () => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card shrink-0">
        <button
          onClick={handleBack}
          className="flex items-center gap-2 text-sm font-body font-medium text-primary hover:text-primary/80 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Return to TableFinder results</span>
          <span className="sm:hidden">Back to results</span>
        </button>
        <div className="ml-auto flex items-center gap-2">
          {name && (
            <span className="text-xs text-foreground font-body font-medium truncate max-w-[150px]">
              {name}
            </span>
          )}
          <span className="text-xs text-muted-foreground font-body capitalize">
            {platform}
          </span>
        </div>
      </header>

      {/* Blocked fallback */}
      {blocked ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <AlertTriangle className="h-10 w-10 text-primary" />
          <h2 className="font-heading text-lg font-semibold text-foreground">
            {platform.charAt(0).toUpperCase() + platform.slice(1)} doesn't allow embedded viewing
          </h2>
          <p className="text-sm text-muted-foreground font-body max-w-sm">
            Tap the button below to open the reservation page. Your results will be right here when you come back.
          </p>
          <button
            onClick={handleOpenExternal}
            className="flex items-center gap-2 px-5 py-3 rounded-lg bg-primary text-primary-foreground font-body font-semibold text-sm hover:bg-primary/90 transition-colors"
          >
            Open on {platform.charAt(0).toUpperCase() + platform.slice(1)}
            <ExternalLink className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={url}
          className="flex-1 w-full border-none"
          title={`Reserve on ${platform}`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        />
      )}
    </div>
  );
};

export default Book;
