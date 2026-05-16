import { useState, useCallback, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { SearchBar } from "@/components/SearchBar";
import { ResultsGrid } from "@/components/ResultsGrid";
import { Restaurant, SearchMeta } from "@/types/restaurant";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Demo results for non-Resy platforms — real restaurants, real booking URLs.
// These illustrate the multi-platform experience while API integrations are finalized.
const DEMO_RESULTS: Restaurant[] = [
  { id: "demo-ot-iberian-pig", name: "The Iberian Pig", cuisine: "Spanish Tapas", neighborhood: "Decatur", rating: 4.7, platform: "opentable", platformUrl: "https://www.opentable.com/r/the-iberian-pig-decatur", timeSlots: [{ time: "6:30 PM", url: "https://www.opentable.com/r/the-iberian-pig-decatur" }, { time: "7:00 PM", url: "https://www.opentable.com/r/the-iberian-pig-decatur" }, { time: "8:15 PM", url: "https://www.opentable.com/r/the-iberian-pig-decatur" }], distanceMiles: 3.2, description: "Acclaimed Spanish tapas and charcuterie in the heart of Decatur.", vibeTags: ["Date Night", "Wine Bar"] },
  { id: "demo-ot-white-bull", name: "The White Bull", cuisine: "New American", neighborhood: "Decatur", rating: 4.6, platform: "opentable", platformUrl: "https://www.opentable.com/r/white-bull-decatur", timeSlots: [{ time: "6:00 PM", url: "https://www.opentable.com/r/white-bull-decatur" }, { time: "7:30 PM", url: "https://www.opentable.com/r/white-bull-decatur" }, { time: "9:00 PM", url: "https://www.opentable.com/r/white-bull-decatur" }], distanceMiles: 3.5 },
  { id: "demo-ot-aria", name: "Aria", cuisine: "Fine Dining", neighborhood: "Buckhead", rating: 4.8, platform: "opentable", platformUrl: "https://www.opentable.com/r/aria-atlanta", timeSlots: [{ time: "6:15 PM", url: "https://www.opentable.com/r/aria-atlanta" }, { time: "7:45 PM", url: "https://www.opentable.com/r/aria-atlanta" }], distanceMiles: 8.1, description: "Landmark fine dining in Buckhead.", vibeTags: ["Fine Dining", "Special Occasion"] },
  { id: "demo-tock-lazy-betty", name: "Lazy Betty", cuisine: "New American", neighborhood: "Candler Park", rating: 4.9, platform: "tock", platformUrl: "https://www.exploretock.com/lazybetty", timeSlots: [{ time: "6:00 PM", url: "https://www.exploretock.com/lazybetty" }, { time: "8:30 PM", url: "https://www.exploretock.com/lazybetty" }], distanceMiles: 4.8, description: "Intimate tasting menu in Candler Park.", vibeTags: ["Tasting Menu", "Fine Dining", "Date Night"] },
  { id: "demo-tock-staplehouse", name: "Staplehouse", cuisine: "New American", neighborhood: "Old Fourth Ward", rating: 4.9, platform: "tock", platformUrl: "https://www.exploretock.com/staplehouse", timeSlots: [{ time: "5:30 PM", url: "https://www.exploretock.com/staplehouse" }, { time: "7:00 PM", url: "https://www.exploretock.com/staplehouse" }, { time: "9:00 PM", url: "https://www.exploretock.com/staplehouse" }], distanceMiles: 5.3, description: "Award-winning New American in Old Fourth Ward.", vibeTags: ["Chef's Table", "Fine Dining"] },
  { id: "demo-yelp-leons", name: "Leon's Full Service", cuisine: "American", neighborhood: "Decatur", rating: 4.6, platform: "yelp", platformUrl: "https://www.yelp.com/reservations/leons-full-service-decatur", timeSlots: [{ time: "6:15 PM", url: "https://www.yelp.com/reservations/leons-full-service-decatur" }, { time: "7:30 PM", url: "https://www.yelp.com/reservations/leons-full-service-decatur" }, { time: "8:45 PM", url: "https://www.yelp.com/reservations/leons-full-service-decatur" }], distanceMiles: 3.8, description: "Beloved Decatur neighborhood restaurant with a lively bar scene.", vibeTags: ["Casual", "Lively"] },
  { id: "demo-yelp-deer-dove", name: "The Deer & The Dove", cuisine: "Southern", neighborhood: "Decatur", rating: 4.7, platform: "yelp", platformUrl: "https://www.yelp.com/reservations/the-deer-and-the-dove-decatur", timeSlots: [{ time: "6:00 PM", url: "https://www.yelp.com/reservations/the-deer-and-the-dove-decatur" }, { time: "7:15 PM", url: "https://www.yelp.com/reservations/the-deer-and-the-dove-decatur" }], distanceMiles: 3.4, description: "Southern-inspired small plates in a warm, intimate setting.", vibeTags: ["Date Night", "Romantic"] },
  { id: "demo-sr-canoe", name: "Canoe", cuisine: "American", neighborhood: "Vinings", rating: 4.7, platform: "sevenrooms", platformUrl: "https://www.sevenrooms.com/reservations/canoeatlanta", timeSlots: [{ time: "6:30 PM", url: "https://www.sevenrooms.com/reservations/canoeatlanta" }, { time: "7:00 PM", url: "https://www.sevenrooms.com/reservations/canoeatlanta" }, { time: "8:30 PM", url: "https://www.sevenrooms.com/reservations/canoeatlanta" }], distanceMiles: 11.2, description: "Scenic riverside dining with upscale American cuisine.", vibeTags: ["Romantic", "Outdoor Seating"] },
  { id: "demo-tock-gunshow", name: "Gunshow", cuisine: "New American", neighborhood: "Glenwood Park", rating: 4.8, platform: "tock", platformUrl: "https://www.exploretock.com/gunshow", timeSlots: [{ time: "5:45 PM", url: "https://www.exploretock.com/gunshow" }, { time: "7:30 PM", url: "https://www.exploretock.com/gunshow" }], distanceMiles: 5.1, description: "Kevin Gillespie's unconventional dim-sum-style New American.", vibeTags: ["Unique Experience", "Chef-Driven"] },
  { id: "demo-wi-bones", name: "Bones", cuisine: "Steakhouse", neighborhood: "Buckhead", rating: 4.8, platform: "wisely", platformUrl: "https://bones.com/reservations", timeSlots: [{ time: "6:00 PM", url: "https://bones.com/reservations" }, { time: "7:15 PM", url: "https://bones.com/reservations" }, { time: "8:30 PM", url: "https://bones.com/reservations" }], distanceMiles: 9.3, description: "Atlanta's premier power-lunch steakhouse since 1979.", vibeTags: ["Fine Dining", "Business Dining", "Classic"] },
  { id: "demo-ti-bacchanalia", name: "Bacchanalia", cuisine: "New American", neighborhood: "West Midtown", rating: 4.9, platform: "tablein", platformUrl: "https://starprovisions.com/bacchanalia", timeSlots: [{ time: "6:00 PM", url: "https://starprovisions.com/bacchanalia" }, { time: "8:00 PM", url: "https://starprovisions.com/bacchanalia" }], distanceMiles: 6.4, description: "Atlanta's most celebrated fine dining restaurant.", vibeTags: ["Fine Dining", "Special Occasion", "Tasting Menu"] },
  { id: "demo-ea-antico", name: "Antico Pizza Napoletana", cuisine: "Italian", neighborhood: "Home Park", rating: 4.7, platform: "eatapp", platformUrl: "https://anticopizza.it", timeSlots: [{ time: "6:30 PM", url: "https://anticopizza.it" }, { time: "7:45 PM", url: "https://anticopizza.it" }, { time: "9:00 PM", url: "https://anticopizza.it" }], distanceMiles: 5.8, description: "Legendary wood-fired Neapolitan pizza in a bustling communal space.", vibeTags: ["Casual", "Lively", "Group Friendly"] },
  { id: "demo-bk-nikolais", name: "Nikolai's Roof", cuisine: "French", neighborhood: "Downtown", rating: 4.6, platform: "bookatable", platformUrl: "https://www.hilton.com/en/hotels/atlahhh-hilton-atlanta/dining/nikolais-roof/", timeSlots: [{ time: "6:15 PM", url: "https://www.hilton.com/en/hotels/atlahhh-hilton-atlanta/dining/nikolais-roof/" }, { time: "7:30 PM", url: "https://www.hilton.com/en/hotels/atlahhh-hilton-atlanta/dining/nikolais-roof/" }], distanceMiles: 7.2, description: "Elegant rooftop French-continental cuisine with sweeping Atlanta skyline views.", vibeTags: ["Fine Dining", "Views", "Romantic"] },
];

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
        // Merge real Resy results with demo results for other platforms, sorted by distance
        const resyResults: Restaurant[] = data?.results || [];
        const merged = [...resyResults, ...DEMO_RESULTS].sort((a, b) => {
          const dA = a.distanceMiles ?? 999;
          const dB = b.distanceMiles ?? 999;
          if (Math.abs(dA - dB) > 0.5) return dA - dB;
          return (b.rating ?? 0) - (a.rating ?? 0);
        });
        setResults(merged);
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
          <span className="px-2 py-0.5 rounded text-xs font-body font-semibold bg-teal-500/15 text-teal-400">Tablein</span>
          <span className="px-2 py-0.5 rounded text-xs font-body font-semibold bg-amber-500/15 text-amber-400">Wisely</span>
          <span className="px-2 py-0.5 rounded text-xs font-body font-semibold bg-rose-500/15 text-rose-400">Eat App</span>
          <span className="px-2 py-0.5 rounded text-xs font-body font-semibold bg-indigo-500/15 text-indigo-400">Bookatable</span>
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

      <footer className="py-6 text-center border-t border-border space-y-2">
        <p className="text-xs text-muted-foreground font-body">
          Resy · OpenTable · Tock · Yelp · SevenRooms · Tablein · Wisely · Eat App · Bookatable
        </p>
        <nav className="flex justify-center gap-4">
          <Link to="/about" className="text-xs text-muted-foreground hover:text-primary transition-colors font-body">About</Link>
          <Link to="/how-it-works" className="text-xs text-muted-foreground hover:text-primary transition-colors font-body">How It Works</Link>
        </nav>
      </footer>
    </div>
  );
};

export default Index;
