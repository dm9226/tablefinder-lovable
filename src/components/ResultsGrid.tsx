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
    <div className="w-full max-w-6xl mx-auto px-4">
      <p className="text-sm text-muted-foreground font-body mb-4">
        {results.length} table{results.length !== 1 ? "s" : ""} found
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {results.map((r) => (
          <RestaurantCard key={r.id} restaurant={r} />
        ))}
      </div>
    </div>
  );
}
