import { Restaurant, SearchMeta } from "@/types/restaurant";
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
  searchMeta?: SearchMeta | null;
  isExtending?: boolean;
}

function formatSearchMeta(meta: SearchMeta): string {
  const parts: string[] = [];
  if (meta.date) parts.push(meta.date);
  if (meta.time) parts.push(meta.time);
  if (meta.partySize) parts.push(`${meta.partySize} guest${meta.partySize !== 1 ? "s" : ""}`);
  const loc = [meta.city, meta.state].filter(Boolean).join(", ");
  if (loc) parts.push(loc);
  return parts.join(" · ");
}

export function ResultsGrid({ results, isLoading, isRefreshing, error, hasSearched, onCancel, searchMeta, isExtending }: ResultsGridProps) {
  if (isLoading) {
    return <SearchProgress onCancel={onCancel} />;
  }

  if (!hasSearched) return null;

  const metaSummary = searchMeta ? (
    <div className="w-full max-w-2xl mx-auto px-4">
      <p className="text-xs text-muted-foreground font-body mb-1.5 px-4">
        {formatSearchMeta(searchMeta)}
      </p>
    </div>
  ) : null;

  if (error) {
    return (
      <>
        {metaSummary}
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <SearchX className="h-8 w-8 text-destructive" />
          <p className="text-destructive font-body text-sm">{error}</p>
        </div>
      </>
    );
  }

  if (results.length === 0) {
    return (
      <>
        {metaSummary}
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <SearchX className="h-8 w-8 text-muted-foreground" />
          <p className="text-muted-foreground font-body text-sm">No tables found. Try a different search.</p>
        </div>
      </>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto px-4">
      {metaSummary}

      {/* OpenTable integration banner — top of results */}
      <div className="mb-3 px-4 py-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 flex items-center gap-3 flex-wrap">
        <span className="shrink-0 px-1.5 py-0.5 rounded text-xs font-body font-semibold uppercase tracking-wider bg-emerald-500/15 text-emerald-400">OpenTable</span>
        <p className="text-xs text-muted-foreground font-body">
          OpenTable integration pending approval — <span className="text-emerald-400 font-medium">Powered by OpenTable</span>
        </p>
      </div>

      <div className="flex items-center justify-between mb-2 px-4">
        <p className="text-xs text-muted-foreground font-body">
          {results.length} result{results.length !== 1 ? "s" : ""} · <span className="text-emerald-400">OpenTable pending</span>
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
          <RestaurantCard key={r.id} restaurant={r} searchMeta={searchMeta} />
        ))}
      </div>

      {isExtending && (
        <div className="flex items-center justify-center gap-2 mt-4 py-3">
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground font-body">Searching for more…</span>
        </div>
      )}
    </div>
  );
}
