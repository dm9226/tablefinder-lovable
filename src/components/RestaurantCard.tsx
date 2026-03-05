import { Restaurant } from "@/types/restaurant";
import { Star, MapPin, ExternalLink } from "lucide-react";

const PLATFORM_STYLES: Record<string, string> = {
  resy: "bg-red-500/15 text-red-400",
  opentable: "bg-emerald-500/15 text-emerald-400",
  yelp: "bg-orange-500/15 text-orange-400",
};

interface RestaurantCardProps {
  restaurant: Restaurant;
}

export function RestaurantCard({ restaurant }: RestaurantCardProps) {
  const dist = restaurant.distanceMiles;
  const distLabel = dist != null ? (dist < 0.1 ? "< 0.1 mi" : `${dist.toFixed(1)} mi`) : null;

  return (
    <a
      href={restaurant.platformUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border hover:bg-muted/50 transition-colors group"
    >
      <div className="flex items-center gap-3 min-w-0">
        <span
          className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-body font-semibold uppercase tracking-wider ${PLATFORM_STYLES[restaurant.platform] || ""}`}
        >
          {restaurant.platform === "opentable" ? "OT" : restaurant.platform}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-heading text-sm font-semibold text-foreground truncate">
              {restaurant.name}
            </h3>
            {restaurant.rating && (
              <span className="flex items-center gap-0.5 text-primary shrink-0">
                <Star className="h-3 w-3 fill-current" />
                <span className="text-xs font-body font-medium">{restaurant.rating}</span>
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground font-body truncate">
            {restaurant.cuisine}
            {restaurant.priceRange && ` · ${restaurant.priceRange}`}
            {restaurant.neighborhood && ` · ${restaurant.neighborhood}`}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {distLabel && (
          <span className="flex items-center gap-0.5 text-xs text-muted-foreground font-body">
            <MapPin className="h-3 w-3" />
            {distLabel}
          </span>
        )}
        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
      </div>
    </a>
  );
}
