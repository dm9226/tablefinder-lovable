import { Restaurant } from "@/types/restaurant";
import { Star, ExternalLink } from "lucide-react";

const PLATFORM_COLORS: Record<string, string> = {
  resy: "bg-red-500/20 text-red-400",
  opentable: "bg-emerald-500/20 text-emerald-400",
  yelp: "bg-orange-500/20 text-orange-400",
};

interface RestaurantCardProps {
  restaurant: Restaurant;
}

export function RestaurantCard({ restaurant }: RestaurantCardProps) {
  return (
    <a
      href={restaurant.platformUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block bg-card border border-border rounded-xl overflow-hidden hover:border-primary/30 transition-all duration-300 group"
    >
      {/* Image */}
      <div className="relative h-40 overflow-hidden bg-muted">
        {restaurant.imageUrl ? (
          <img
            src={restaurant.imageUrl}
            alt={restaurant.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground font-heading text-2xl">
            {restaurant.name.charAt(0)}
          </div>
        )}
        <span
          className={`absolute top-3 left-3 px-2 py-0.5 rounded-md text-xs font-body font-medium uppercase tracking-wide ${PLATFORM_COLORS[restaurant.platform] || ""}`}
        >
          {restaurant.platform}
        </span>
      </div>

      {/* Content */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-1">
          <h3 className="font-heading text-lg font-semibold text-foreground leading-tight">
            {restaurant.name}
          </h3>
          {restaurant.rating && (
            <div className="flex items-center gap-0.5 text-primary shrink-0">
              <Star className="h-3.5 w-3.5 fill-current" />
              <span className="text-xs font-body font-medium">{restaurant.rating}</span>
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground font-body mb-1">
          {restaurant.cuisine}
          {restaurant.priceRange && ` · ${restaurant.priceRange}`}
        </p>
        <p className="text-xs text-muted-foreground font-body mb-3">
          {restaurant.neighborhood}
        </p>

        {/* Book button */}
        <div className="flex items-center gap-1 text-sm text-primary font-body font-medium group-hover:underline">
          Reserve on {restaurant.platform}
          <ExternalLink className="h-3.5 w-3.5" />
        </div>
      </div>
    </a>
  );
}
