import { useSearchParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

const Book = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const url = searchParams.get("url");
  const platform = searchParams.get("platform") || "restaurant";

  if (!url) {
    navigate("/");
    return null;
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card shrink-0">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-sm font-body font-medium text-primary hover:text-primary/80 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Return to TableFinder results
        </button>
        <span className="ml-auto text-xs text-muted-foreground font-body capitalize">
          {platform}
        </span>
      </header>
      <iframe
        src={url}
        className="flex-1 w-full border-none"
        title={`Reserve on ${platform}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  );
};

export default Book;
