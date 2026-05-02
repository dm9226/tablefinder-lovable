import { Restaurant } from "@/types/restaurant";
import { Star, MapPin, ChevronRight, Clock } from "lucide-react";

const PLATFORM_STYLES: Record<string, string> = {
  resy: "bg-red-500/15 text-red-400",
  opentable: "bg-emerald-500/15 text-emerald-400",
  yelp: "bg-orange-500/15 text-orange-400",
};

interface RestaurantCardProps {
  restaurant: Restaurant;
}

function formatReviewCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
}

export function RestaurantCard({ restaurant }: RestaurantCardProps) {
  const dist = restaurant.distanceMiles;
  const distLabel = dist != null ? (dist < 0.1 ? "< 0.1 mi" : `${dist.toFixed(1)} mi`) : null;
  const slots = restaurant.timeSlots || [];
  const vibeTags = restaurant.vibeTags || [];

  const handleClick = () => {
    window.location.href = restaurant.platformUrl;
  };

  return (
    <button
      onClick={handleClick}
      className="flex gap-3 px-4 py-3.5 border-b border-border hover:bg-muted/50 transition-colors group w-full text-left"
    >
      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        {/* Row 1: platform badge + name */}
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`shrink-0 px-1.5 py-0.5 rounded text-xs font-body font-semibold uppercase tracking-wider ${PLATFORM_STYLES[restaurant.platform] || ""}`}
          >
            {restaurant.platform === "opentable" ? "OT" : restaurant.platform}
          </span>
          <h3 className="font-heading text-base font-semibold text-foreground truncate">
            {restaurant.name}
          </h3>
        </div>

        {/* Row 2: rating + distance + chevron */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {restaurant.rating && (
              <span className="flex items-center gap-0.5 text-primary shrink-0">
                <Star className="h-3.5 w-3.5 fill-current" />
                <span className="text-sm font-body font-medium">{restaurant.rating}</span>
                {restaurant.reviewCount && (
                  <span className="text-xs text-muted-foreground font-body">
                    ({formatReviewCount(restaurant.reviewCount)})
                  </span>
                )}
              </span>
            )}
            {distLabel && (
              <span className="flex items-center gap-0.5 text-sm text-muted-foreground font-body">
                <MapPin className="h-3.5 w-3.5" />
                {distLabel}
              </span>
            )}
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
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

        {/* Time slots — max 3 */}
        {slots.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            {slots.slice(0, 3).map((slot, i) => (
              <span
                key={i}
                className="px-1.5 py-0.5 rounded text-[13px] font-body font-medium bg-primary/10 text-primary"
              >
                {slot.time}
              </span>
            ))}
            {slots.length > 3 && (
              <span className="text-[13px] text-muted-foreground font-body">
                +{slots.length - 3} more
              </span>
            )}
          </div>
        )}
        {slots.length === 0 && restaurant._softVerified && (
          <span className="inline-flex items-center self-start px-1.5 py-0.5 rounded border border-border text-[11px] font-body text-muted-foreground">
            Availability not confirmed — tap to check
          </span>
        )}
      </div>
    </button>
  );
}
