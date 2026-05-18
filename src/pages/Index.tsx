import { useState, useCallback, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { SiteFooter } from "@/components/SiteFooter";
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
  const extendAbortRef = useRef<AbortController | null>(null);
  const searchIdRef = useRef<number>(0);
  const autoExtendedRef = useRef<number>(0);

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
    extendAbortRef.current?.abort();
    setIsLoading(false);
    setIsExtending(false);
    toast.info("Search cancelled");
  }, []);

  const handleSearch = useCallback(
    async (query: string) => {
      abortRef.current?.abort();
      extendAbortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const searchId = ++searchIdRef.current;

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

        if (searchId !== searchIdRef.current) return;
        // Results already sorted by backend (Resy live + OT pending mixed by distance)
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

    extendAbortRef.current?.abort();
    const controller = new AbortController();
    extendAbortRef.current = controller;
    const searchId = searchIdRef.current;

    setIsExtending(true);
    try {
      const { data, error: fnError } = await supabase.functions.invoke("search", {
        body: {
          query: lastQuery,
          extended: true,
          remainingCandidates,
          extendedParams: lastParams,
          lat: coords?.lat,
          lng: coords?.lng,
        },
      });

      if (controller.signal.aborted || searchId !== searchIdRef.current) return;
      if (data?.error) throw new Error(data.error);
      if (fnError) throw new Error(fnError.message || "Extended search failed");

      const newResults: Restaurant[] = data?.results || [];
      if (newResults.length > 0) {
        setResults(prev => {
          const seen = new Set<string>();
          const merged: Restaurant[] = [];
          for (const r of [...prev, ...newResults]) {
            const key = `${(r.name || "").toLowerCase().trim()}|${r.platform}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(r);
          }
          merged.sort((a, b) => {
            const dA = a.distanceMiles ?? Number.POSITIVE_INFINITY;
            const dB = b.distanceMiles ?? Number.POSITIVE_INFINITY;
            if (Math.abs(dA - dB) > 0.5) return dA - dB;
            return (b.rating ?? 0) - (a.rating ?? 0);
          });
          return merged;
        });
      }
      // Auto-extend runs once per search; do not chain further rounds.
      setHasMore(false);
      setRemainingCandidates([]);
    } catch (err: any) {
      if (controller.signal.aborted) return;
      console.error("Extended search error:", err);
      // Silent failure for auto-extend — initial results remain visible.
    } finally {
      if (!controller.signal.aborted && searchId === searchIdRef.current) {
        setIsExtending(false);
      }
    }
  }, [remainingCandidates, lastParams, lastQuery]);

  // Auto-trigger the extended search once per search when more candidates exist.
  useEffect(() => {
    if (isLoading || isExtending) return;
    if (!hasMore || remainingCandidates.length === 0 || !lastParams) return;
    if (autoExtendedRef.current === searchIdRef.current) return;
    autoExtendedRef.current = searchIdRef.current;
    handleExtendedSearch();
  }, [isLoading, isExtending, hasMore, remainingCandidates, lastParams, handleExtendedSearch]);

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      <Helmet>
        <title>TableFinder — Find Resy Restaurant Reservations Near You</title>
        <meta name="description" content="Search Resy, Tock, Yelp, and OpenTable reservations in one place. Find available tables near you with natural language search." />
        <link rel="canonical" href="https://tablefinder.ai/" />
        <script type="application/ld+json">{JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebSite",
              "@id": "https://tablefinder.ai/#website",
              "url": "https://tablefinder.ai/",
              "name": "TableFinder",
              "description": "Search Resy reservations with natural language. Find available tables near you instantly.",
              "potentialAction": {
                "@type": "SearchAction",
                "target": {
                  "@type": "EntryPoint",
                  "urlTemplate": "https://tablefinder.ai/?q={search_term_string}"
                },
                "query-input": "required name=search_term_string"
              }
            },
            {
              "@type": "Organization",
              "@id": "https://tablefinder.ai/#organization",
              "name": "TableFinder",
              "url": "https://tablefinder.ai/",
              "logo": {
                "@type": "ImageObject",
                "url": "https://tablefinder.ai/og-image.png"
              }
            }
          ]
        })}</script>
      </Helmet>
      <header className="pt-6 pb-3 px-4 text-center">
        <Link to="/">
          <h1 className="font-heading text-4xl md:text-5xl font-extrabold tracking-tight leading-none">
            <span className="text-foreground">Table</span><span className="text-primary">Finder</span>
          </h1>
        </Link>
        <p className="text-muted-foreground font-body text-base md:text-lg max-w-md mx-auto mt-2">
          One Search Across Every Reservation Platform
        </p>
        <div className="flex items-center justify-center mt-2">
          <span className="px-3 py-1 rounded border border-emerald-500/40 text-xs font-body font-semibold bg-emerald-500/10 text-emerald-400">
            OpenTable — Integration Pending Approval
          </span>
        </div>
        <div className="flex items-center justify-center gap-2 mt-2 flex-wrap">
          <span className="px-2 py-0.5 rounded text-xs font-body font-semibold bg-red-500/15 text-red-400">Resy</span>
          <span className="px-2 py-0.5 rounded text-xs font-body font-semibold bg-purple-500/15 text-purple-400">Tock</span>
          <span className="px-2 py-0.5 rounded text-xs font-body font-semibold bg-orange-500/15 text-orange-400">Yelp</span>
          <span className="px-2 py-0.5 rounded text-xs font-body font-semibold bg-blue-500/15 text-blue-400">SevenRooms</span>
          <span className="px-2 py-0.5 rounded text-xs font-body font-semibold bg-lime-500/15 text-lime-400">TheFork</span>
        </div>
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
          isExtending={isExtending}
        />
      </section>

      <SiteFooter />
    </div>
  );
};

export default Index;
