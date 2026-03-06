import { Restaurant } from "@/types/restaurant";
import { RestaurantCard } from "./RestaurantCard";
import { SearchX, RefreshCw } from "lucide-react";
import { SearchProgress } from "./SearchProgress";

interface ResultsGridProps {
  results: Restaurant[];
  isLoading: boolean;
  isRefreshing?: boolean;
  error: string | null;
  hasSearched: boolean;
  onCancel: () => void;
}

export function ResultsGrid({ results, isLoading, isRefreshing, error, hasSearched, onCancel }: ResultsGridProps) {
  if (isLoading) {
    return <SearchProgress onCancel={onCancel} />;
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
      <div className="flex items-center justify-between mb-2 px-4">
        <p className="text-xs text-muted-foreground font-body">
          {results.length} result{results.length !== 1 ? "s" : ""}
        </p>
        {isRefreshing && (
          <div className="flex items-center gap-1.5 text-xs text-primary font-body animate-pulse">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Updating results…
          </div>
        )}
      </div>
      <div className="border border-border rounded-lg overflow-hidden bg-card">
        {results.map((r) => (
          <RestaurantCard key={r.id} restaurant={r} />
        ))}
      </div>
    </div>
  );
}
