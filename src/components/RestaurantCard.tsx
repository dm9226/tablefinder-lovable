import { Restaurant } from "@/types/restaurant";
import { Star, MapPin, ExternalLink, Clock } from "lucide-react";
import { toast } from "sonner";

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
  const slots = restaurant.timeSlots || [];

  const handleClick = () => {
    toast("Your results are still here — just switch back to this tab", {
      duration: 4000,
      icon: "↩️",
    });
  };

  return (
    <a
      href={restaurant.platformUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className="flex flex-col gap-2 px-4 py-3 border-b border-border hover:bg-muted/50 transition-colors group"
    >
      <div className="flex items-center justify-between gap-3">
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
      </div>
      {slots.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap pl-9">
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
    </a>
  );
}
