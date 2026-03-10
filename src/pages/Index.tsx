import { useState, useCallback, useRef, useEffect } from "react";
import { SearchBar } from "@/components/SearchBar";
import { ResultsGrid } from "@/components/ResultsGrid";
import { Restaurant, SearchMeta } from "@/types/restaurant";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const Index = () => {
  const [results, setResults] = useState<Restaurant[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [location, setLocation] = useState<string | null>(null);
  const [locationLoading, setLocationLoading] = useState(true);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-detect location on mount
  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationLoading(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        setCoords({ lat: latitude, lng: longitude });
        try {
          const resp = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`
          );
          const data = await resp.json();
          const city = data.address?.city || data.address?.town || data.address?.village || "";
          // Prefer ISO state code (e.g. "US-GA") → extract "GA"; fall back to full state name
          const isoState = data.address?.["ISO3166-2-lvl4"] || "";
          const stateAbbr = isoState.includes("-") ? isoState.split("-").pop() : "";
          const state = stateAbbr || data.address?.state || "";
          setLocation(city ? `${city}, ${state}` : "Location detected");
        } catch {
          setLocation("Location detected");
        }
        setLocationLoading(false);
      },
      () => {
        setLocationLoading(false);
      }
    );
  }, []);

  const cancelSearch = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
    toast.info("Search cancelled");
  }, []);

  const handleSearch = useCallback(
    async (query: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsLoading(true);
      setError(null);
      setHasSearched(true);
      setResults([]);

      try {
        const { data, error: fnError } = await supabase.functions.invoke("search", {
          body: {
            query,
            lat: coords?.lat,
            lng: coords?.lng,
            location: location,
          },
        });

        if (controller.signal.aborted) return;

        if (data?.error) throw new Error(data.error);
        if (fnError) {
          const msg = fnError.message || "";
          if (msg.includes("non-2xx")) {
            throw new Error("Something went wrong with the search. Please try again.");
          }
          throw new Error(msg);
        }

        setResults(data?.results || []);
        if (data?.params) {
          setSearchMeta(data.params as SearchMeta);
        }
      } catch (err: any) {
        if (controller.signal.aborted) return;
        console.error("Search error:", err);
        setError(err.message || "Search failed. Please try again.");
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    },
    [coords, location]
  );

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <header className="pt-6 pb-3 px-4 text-center">
        <h1 className="font-heading text-4xl md:text-5xl font-bold text-foreground mb-2 tracking-tight">
          Table<span className="text-primary">Finder</span>
        </h1>
        <p className="text-muted-foreground font-body text-base md:text-lg max-w-md mx-auto">
          Multiple Reservation Platforms, One Search
        </p>
      </header>

      {/* Search */}
      <section className="px-4 pb-3">
        <SearchBar
          onSearch={handleSearch}
          isLoading={isLoading}
          location={location}
          locationLoading={locationLoading}
        />
      </section>

      {/* Results */}
      <section className="flex-1 overflow-y-auto pb-4">
        <ResultsGrid
          results={results}
          isLoading={isLoading}
          isRefreshing={false}
          error={error}
          hasSearched={hasSearched}
          onCancel={cancelSearch}
          searchMeta={searchMeta}
        />
      </section>

      {/* Footer */}
      <footer className="py-6 text-center border-t border-border">
        <p className="text-xs text-muted-foreground font-body">
          TableFinder aggregates availability from Resy, OpenTable & Yelp
        </p>
      </footer>
    </div>
  );
};

export default Index;
