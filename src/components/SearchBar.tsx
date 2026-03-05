import { useState, useRef, useEffect } from "react";
import { Search, MapPin, Loader2 } from "lucide-react";

interface SearchBarProps {
  onSearch: (query: string) => void;
  isLoading: boolean;
  location: string | null;
  locationLoading: boolean;
}

const SUGGESTIONS = [
  "Italian for 2 Friday night",
  "Sushi near me tonight",
  "Romantic brunch for 2 Saturday",
  "Thai food tomorrow 7pm party of 4",
  "Steakhouse this weekend",
];

export function SearchBar({ onSearch, isLoading, location, locationLoading }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [placeholder, setPlaceholder] = useState(SUGGESTIONS[0]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      i = (i + 1) % SUGGESTIONS.length;
      setPlaceholder(SUGGESTIONS[i]);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim() && !isLoading) {
      onSearch(query.trim());
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl mx-auto">
      <div className="relative group">
        <div className="absolute -inset-0.5 bg-primary/20 rounded-xl blur-md opacity-0 group-focus-within:opacity-100 transition-opacity duration-300" />
        <div className="relative flex items-center bg-card border border-border rounded-xl overflow-hidden transition-colors focus-within:border-primary/50">
          <Search className="ml-4 h-5 w-5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            className="flex-1 bg-transparent px-3 py-4 text-foreground placeholder:text-muted-foreground focus:outline-none font-body text-base"
            disabled={isLoading}
          />
          {isLoading ? (
            <Loader2 className="mr-4 h-5 w-5 text-primary animate-spin" />
          ) : (
            <button
              type="submit"
              disabled={!query.trim()}
              className="mr-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg font-body font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-40"
            >
              Search
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-center mt-3 gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-body">
          <MapPin className="h-3.5 w-3.5" />
          {locationLoading ? (
            <span className="flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Detecting location…
            </span>
          ) : (
            location || "Location not available"
          )}
        </div>
      </div>
    </form>
  );
}
