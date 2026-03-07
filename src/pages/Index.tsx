import { useState, useCallback, useRef, useEffect } from "react";
import { SearchBar } from "@/components/SearchBar";
import { ResultsGrid } from "@/components/ResultsGrid";
import { Restaurant, SearchMeta } from "@/types/restaurant";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const SESSION_KEY = "tablefinder_results";
const SESSION_META_KEY = "tablefinder_meta";

const Index = () => {
  const [results, setResults] = useState<Restaurant[]>(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(() => {
    try { return !!sessionStorage.getItem(SESSION_KEY); } catch { return false; }
  });
  const [location, setLocation] = useState<string | null>(null);
  const [locationLoading, setLocationLoading] = useState(true);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_META_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
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
          const state = data.address?.state || "";
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
    setIsRefreshing(false);
    toast.info("Search cancelled");
  }, []);

  const handleSearch = useCallback(
    async (query: string) => {
      // Cancel any in-flight search
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsLoading(true);
      setIsRefreshing(false);
      setError(null);
      setHasSearched(true);
      setResults([]);

      const searchBody = {
        query,
        lat: coords?.lat,
        lng: coords?.lng,
        location: location,
      };

      try {
        // Phase 1: Try cache-only (instant)
        const { data: cacheData, error: cacheFnError } = await supabase.functions.invoke("search", {
          body: { ...searchBody, cacheOnly: true },
        });

        if (controller.signal.aborted) return;

        if (!cacheFnError && cacheData?.cached && cacheData.results?.length > 0) {
          // Store search meta from cached response
          if (cacheData.params) {
            setSearchMeta(cacheData.params as SearchMeta);
            sessionStorage.setItem(SESSION_META_KEY, JSON.stringify(cacheData.params));
          }
          // Show cached results immediately
          setResults(cacheData.results);
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(cacheData.results));
          setIsLoading(false);
          setIsRefreshing(true); // show "updating" indicator

          // Phase 2: Run fresh search in background
          try {
            const { data: freshData, error: freshFnError } = await supabase.functions.invoke("search", {
              body: searchBody,
            });

            if (controller.signal.aborted) return;

            if (freshData?.error) {
              // Fresh search failed but we have cached results — just stop refreshing
              console.warn("Fresh search error (cached results retained):", freshData.error);
            } else if (!freshFnError && freshData?.results) {
              const freshResults = freshData.results;
              setResults(freshResults);
              sessionStorage.setItem(SESSION_KEY, JSON.stringify(freshResults));
              if (freshData.params) {
                setSearchMeta(freshData.params as SearchMeta);
                sessionStorage.setItem(SESSION_META_KEY, JSON.stringify(freshData.params));
              }
            }
          } catch (err) {
            if (controller.signal.aborted) return;
            console.warn("Background refresh failed:", err);
          } finally {
            if (!controller.signal.aborted) {
              setIsRefreshing(false);
            }
          }
          return;
        }

        // No cache hit — do full search (show loading state)
        const { data, error: fnError } = await supabase.functions.invoke("search", {
          body: searchBody,
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

        const newResults = data?.results || [];
        setResults(newResults);
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(newResults));
        if (data?.params) {
          setSearchMeta(data.params as SearchMeta);
          sessionStorage.setItem(SESSION_META_KEY, JSON.stringify(data.params));
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
          isRefreshing={isRefreshing}
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
