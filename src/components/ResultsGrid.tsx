import { Restaurant } from "@/types/restaurant";
import { RestaurantCard } from "./RestaurantCard";
import { Loader2, SearchX } from "lucide-react";

interface ResultsGridProps {
  results: Restaurant[];
  isLoading: boolean;
  error: string | null;
  hasSearched: boolean;
}

export function ResultsGrid({ results, isLoading, error, hasSearched }: ResultsGridProps) {
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <Loader2 className="h-8 w-8 text-primary animate-spin" />
        <p className="text-muted-foreground font-body text-sm">Searching for tables…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <SearchX className="h-8 w-8 text-destructive" />
        <p className="text-destructive font-body text-sm">{error}</p>
      </div>
    );
  }

  if (hasSearched && results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <SearchX className="h-8 w-8 text-muted-foreground" />
        <p className="text-muted-foreground font-body text-sm">No tables found. Try a different search.</p>
      </div>
    );
  }

  if (!hasSearched) return null;

  return (
    <div className="w-full max-w-2xl mx-auto px-4">
      <p className="text-xs text-muted-foreground font-body mb-2 px-4">
        {results.length} result{results.length !== 1 ? "s" : ""}
      </p>
      <div className="border border-border rounded-lg overflow-hidden bg-card">
        {results.map((r) => (
          <RestaurantCard key={r.id} restaurant={r} />
        ))}
      </div>
    </div>
  );
}
