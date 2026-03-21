import { useState, useCallback, useRef, useEffect } from "react";
import { Helmet } from "react-helmet-async";
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
  const [locationDenied, setLocationDenied] = useState(false);
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isExtending, setIsExtending] = useState(false);
  const [remainingCandidates, setRemainingCandidates] = useState<Restaurant[]>([]);
  const [lastQuery, setLastQuery] = useState<string>("");
  const [lastParams, setLastParams] = useState<any>(null);
  const abortRef = useRef<AbortController | null>(null);

  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationLoading(false);
      setLocationDenied(true);
      return;
    }
    setLocationLoading(true);
    setLocationDenied(false);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        setCoords({ lat: latitude, lng: longitude });
        setLocationDenied(false);
        try {
          const resp = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`
          );
          const data = await resp.json();
          const city = data.address?.city || data.address?.town || data.address?.village || "";
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
        setLocationDenied(true);
        setLocationLoading(false);
      }
    );
  }, []);

  useEffect(() => {
    requestLocation();
  }, [requestLocation]);

  const cancelSearch = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
    setIsExtending(false);
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
      setHasMore(false);
      setRemainingCandidates([]);
      setLastQuery(query);
      setLastParams(null);

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
          setLastParams(data.params);
        }
        setHasMore(!!data?.hasMore);
        setRemainingCandidates(data?.remainingCandidates || []);
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

  const handleExtendedSearch = useCallback(async () => {
    if (remainingCandidates.length === 0 || !lastParams) return;

    setIsExtending(true);
    try {
      const { data, error: fnError } = await supabase.functions.invoke("search", {
        body: {
          query: lastQuery,
          extended: true,
          remainingCandidates,
          extendedParams: lastParams,
        },
      });

      if (data?.error) throw new Error(data.error);
      if (fnError) throw new Error(fnError.message || "Extended search failed");

      const newResults = data?.results || [];
      if (newResults.length > 0) {
        setResults(prev => [...prev, ...newResults]);
        toast.success(`Found ${newResults.length} more result${newResults.length !== 1 ? "s" : ""}`);
      } else {
        toast.info("No additional results found");
      }
      setHasMore(!!data?.hasMore);
      setRemainingCandidates(data?.remainingCandidates || []);
    } catch (err: any) {
      console.error("Extended search error:", err);
      toast.error(err.message || "Extended search failed");
    } finally {
      setIsExtending(false);
    }
  }, [remainingCandidates, lastParams, lastQuery]);

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      <header className="pt-6 pb-3 px-4 text-center">
        <h1 className="font-heading text-4xl md:text-5xl font-bold text-foreground mb-2 tracking-tight">
          Table<span className="text-primary">Finder</span>
        </h1>
        <p className="text-muted-foreground font-body text-base md:text-lg max-w-md mx-auto">
          Multiple Reservation Platforms, One Search
        </p>
      </header>

      <section className="px-4 pb-3">
        <SearchBar
          onSearch={handleSearch}
          isLoading={isLoading}
          location={location}
          locationLoading={locationLoading}
          locationDenied={locationDenied}
          onRequestLocation={requestLocation}
        />
      </section>

      <section className="flex-1 overflow-y-auto pb-4">
        <ResultsGrid
          results={results}
          isLoading={isLoading}
          isRefreshing={false}
          error={error}
          hasSearched={hasSearched}
          onCancel={cancelSearch}
          searchMeta={searchMeta}
          hasMore={hasMore}
          isExtending={isExtending}
          onExtendSearch={handleExtendedSearch}
        />
      </section>

      <footer className="py-6 text-center border-t border-border">
        <p className="text-xs text-muted-foreground font-body">
          TableFinder aggregates availability from Resy, OpenTable & Yelp
        </p>
      </footer>
    </div>
  );
};

export default Index;
