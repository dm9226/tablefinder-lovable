import { Restaurant } from "@/types/restaurant";
import { Star, MapPin, Clock } from "lucide-react";

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
    <div className="border-b border-border">
      <a
        href={restaurant.platformUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-between gap-3 px-4 pt-3 pb-2 hover:bg-muted/50 transition-colors group"
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
        </div>
      </a>

      {/* Time slots */}
      {restaurant.timeSlots.length > 0 && (
        <div className="px-4 pb-3 pt-1 flex items-center gap-1.5 flex-wrap">
          <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
          {restaurant.timeSlots.map((slot, i) => (
            <a
              key={i}
              href={restaurant.platformUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2 py-1 rounded-md bg-primary/10 text-primary text-xs font-body font-medium hover:bg-primary/20 transition-colors"
              title={slot.type || undefined}
            >
              {slot.time}
              {slot.type && (
                <span className="ml-1 text-[10px] text-muted-foreground">{slot.type}</span>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
