import { Restaurant } from "@/types/restaurant";
import { Star, MapPin, ChevronRight, Clock, Users } from "lucide-react";

const PLATFORM_STYLES: Record<string, string> = {
  resy: "bg-red-500/15 text-red-400",
  opentable: "bg-emerald-500/15 text-emerald-400",
  yelp: "bg-orange-500/15 text-orange-400",
};

const PLATFORM_LOGOS: Record<string, string> = {
  resy: "https://logo.clearbit.com/resy.com",
  opentable: "https://logo.clearbit.com/opentable.com",
  yelp: "https://logo.clearbit.com/yelp.com",
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
      className="flex gap-3 px-4 py-3 border-b border-border hover:bg-muted/50 transition-colors group w-full text-left"
    >
      {/* Thumbnail */}
      <div className="shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-muted flex items-center justify-center">
        {restaurant.imageUrl ? (
          <img
            src={restaurant.imageUrl}
            alt={restaurant.name}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => {
              // Fallback to platform logo if restaurant image fails
              const img = e.currentTarget;
              img.className = "w-8 h-8 object-contain opacity-60";
              img.src = PLATFORM_LOGOS[restaurant.platform] || "";
            }}
          />
        ) : (
          <img
            src={PLATFORM_LOGOS[restaurant.platform] || ""}
            alt={restaurant.platform}
            className="w-8 h-8 object-contain opacity-60"
            loading="lazy"
          />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        {/* Top row: platform badge + name + rating + chevron */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-body font-semibold uppercase tracking-wider ${PLATFORM_STYLES[restaurant.platform] || ""}`}
            >
              {restaurant.platform === "opentable" ? "OT" : restaurant.platform}
            </span>
            <h3 className="font-heading text-sm font-semibold text-foreground truncate">
              {restaurant.name}
            </h3>
            {restaurant.rating && (
              <span className="flex items-center gap-0.5 text-primary shrink-0">
                <Star className="h-3 w-3 fill-current" />
                <span className="text-xs font-body font-medium">{restaurant.rating}</span>
                {restaurant.reviewCount && (
                  <span className="text-[10px] text-muted-foreground font-body">
                    ({formatReviewCount(restaurant.reviewCount)})
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {distLabel && (
              <span className="flex items-center gap-0.5 text-xs text-muted-foreground font-body">
                <MapPin className="h-3 w-3" />
                {distLabel}
              </span>
            )}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
          </div>
        </div>

        {/* Meta row: cuisine · price · neighborhood */}
        <p className="text-xs text-muted-foreground font-body truncate">
          {restaurant.cuisine}
          {restaurant.priceRange && ` · ${restaurant.priceRange}`}
          {restaurant.neighborhood && ` · ${restaurant.neighborhood}`}
        </p>

        {/* Description */}
        {restaurant.description && (
          <p className="text-xs text-muted-foreground/80 font-body italic truncate">
            {restaurant.description}
          </p>
        )}

        {/* Vibe tags */}
        {vibeTags.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {vibeTags.slice(0, 3).map((tag, i) => (
              <span
                key={i}
                className="px-1.5 py-0.5 rounded-full text-[10px] font-body font-medium bg-accent text-accent-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Time slots */}
        {slots.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
            {slots.slice(0, 6).map((slot, i) => (
              <span
                key={i}
                className="px-1.5 py-0.5 rounded text-[11px] font-body font-medium bg-primary/10 text-primary"
              >
                {slot.time}
              </span>
            ))}
            {slots.length > 6 && (
              <span className="text-[11px] text-muted-foreground font-body">
                +{slots.length - 6} more
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
