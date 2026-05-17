import { Restaurant, TimeSlot, SearchMeta } from "@/types/restaurant";
import { Star, MapPin, Clock } from "lucide-react";

const PLATFORM_STYLES: Record<string, string> = {
  resy:       "bg-red-500/15 text-red-400",
  opentable:  "bg-emerald-500/15 text-emerald-400",
  tock:       "bg-purple-500/15 text-purple-400",
  yelp:       "bg-orange-500/15 text-orange-400",
  sevenrooms: "bg-blue-500/15 text-blue-400",
  tablein:    "bg-teal-500/15 text-teal-400",
  quandoo:    "bg-cyan-500/15 text-cyan-400",
  wisely:     "bg-amber-500/15 text-amber-400",
  eatapp:     "bg-rose-500/15 text-rose-400",
  bookatable: "bg-indigo-500/15 text-indigo-400",
};

const PLATFORM_LABELS: Record<string, string> = {
  resy:       "Resy",
  opentable:  "OpenTable",
  tock:       "Tock",
  yelp:       "Yelp",
  sevenrooms: "SevenRooms",
  tablein:    "Tablein",
  quandoo:    "Quandoo",
  wisely:     "Wisely",
  eatapp:     "Eat App",
  bookatable: "Bookatable",
};

interface RestaurantCardProps {
  restaurant: Restaurant;
  searchMeta?: SearchMeta | null;
}

function formatReviewCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
}

function getSlotUrl(restaurant: Restaurant, slot: TimeSlot, searchMeta?: SearchMeta | null): string {
  // Use pre-computed slot URL from backend if available
  if (slot.url) return slot.url;
  // Fallback: use general platform URL (already has date + party size from search)
  return restaurant.platformUrl;
}

export function RestaurantCard({ restaurant, searchMeta }: RestaurantCardProps) {
  const dist = restaurant.distanceMiles;
  const distLabel = dist != null ? (dist < 0.1 ? "< 0.1 mi" : `${dist.toFixed(1)} mi`) : null;
  const slots = restaurant.timeSlots || [];
  const vibeTags = restaurant.vibeTags || [];

  return (
    <div
      className="flex gap-3 px-4 py-3.5 border-b border-border hover:bg-muted/30 transition-colors w-full text-left cursor-pointer"
      onClick={() => window.open(restaurant.platformUrl, "_blank", "noopener")}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && window.open(restaurant.platformUrl, "_blank", "noopener")}
      aria-label={`Open ${restaurant.name} on ${PLATFORM_LABELS[restaurant.platform] ?? restaurant.platform}`}
    >
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        {/* Row 1: platform badge + name */}
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`shrink-0 px-1.5 py-0.5 rounded text-xs font-body font-semibold uppercase tracking-wider ${PLATFORM_STYLES[restaurant.platform] || ""}`}
          >
            {PLATFORM_LABELS[restaurant.platform] ?? restaurant.platform}
          </span>
          <h3 className="font-heading text-base font-semibold text-foreground truncate">
            <span className="hover:text-primary transition-colors">
              {restaurant.name}
            </span>
          </h3>
        </div>

        {/* Row 2: rating + distance */}
        <div className="flex items-center gap-2">
          {restaurant.rating != null && (
            <span className="flex items-center gap-0.5 text-primary shrink-0">
              <Star className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              <span className="text-sm font-body font-medium">{Number(restaurant.rating).toFixed(1)}</span>
              {restaurant.reviewCount != null && (
                <span className="text-xs text-muted-foreground font-body">
                  ({formatReviewCount(restaurant.reviewCount)})
                </span>
              )}
            </span>
          )}
          {distLabel && (
            <span className="flex items-center gap-0.5 text-sm text-muted-foreground font-body">
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              {distLabel}
            </span>
          )}
        </div>

        {/* Meta row: cuisine · price · neighborhood */}
        <p className="text-sm text-muted-foreground font-body truncate">
          {restaurant.cuisine}
          {restaurant.priceRange && ` · ${restaurant.priceRange}`}
          {restaurant.neighborhood && ` · ${restaurant.neighborhood}`}
        </p>

        {/* Description */}
        {restaurant.description && (
          <p className="text-sm text-muted-foreground/80 font-body italic">
            {restaurant.description}
          </p>
        )}

        {/* Vibe tags */}
        {vibeTags.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {vibeTags.slice(0, 3).map((tag, i) => (
              <span
                key={i}
                className="px-1.5 py-0.5 rounded-full text-xs font-body font-medium bg-accent text-accent-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Time slots or pending state */}
        {slots.length > 0 ? (
          <div className="flex items-center gap-1.5 flex-wrap">
            <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
            {slots.slice(0, 6).map((slot, i) => (
              <a
                key={i}
                href={getSlotUrl(restaurant, slot, searchMeta)}
                target="_blank"
                rel="noopener noreferrer"
                className="px-2 py-0.5 rounded text-[13px] font-body font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
                aria-label={`Book ${restaurant.name} at ${slot.time}`}
                onClick={(e) => e.stopPropagation()}
              >
                {slot.time}
              </a>
            ))}
          </div>
        ) : restaurant.availabilityPending ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground/70 font-body italic">
              Live availability pending integration —
            </span>
            <a
              href={restaurant.platformUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-body font-medium text-primary hover:text-primary/80 transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              Book on {PLATFORM_LABELS[restaurant.platform] ?? restaurant.platform} →
            </a>
          </div>
        ) : null}

      </div>
    </div>
  );
}
