import { Restaurant } from "@/types/restaurant";
import { Star, MapPin, Clock, ExternalLink } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";

const PLATFORM_LABELS: Record<string, string> = {
  resy: "Resy",
  opentable: "OpenTable",
  yelp: "Yelp",
};

const PLATFORM_COLORS: Record<string, string> = {
  resy: "bg-red-500/15 text-red-400",
  opentable: "bg-emerald-500/15 text-emerald-400",
  yelp: "bg-orange-500/15 text-orange-400",
};

interface BookingDrawerProps {
  restaurant: Restaurant | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BookingDrawer({ restaurant, open, onOpenChange }: BookingDrawerProps) {
  if (!restaurant) return null;

  const dist = restaurant.distanceMiles;
  const distLabel = dist != null ? (dist < 0.1 ? "< 0.1 mi" : `${dist.toFixed(1)} mi`) : null;
  const slots = restaurant.timeSlots || [];

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[85vh]">
        <DrawerHeader className="text-left pb-2">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`px-2 py-0.5 rounded text-[11px] font-body font-semibold uppercase tracking-wider ${PLATFORM_COLORS[restaurant.platform] || ""}`}
            >
              {PLATFORM_LABELS[restaurant.platform] || restaurant.platform}
            </span>
            {restaurant.rating && (
              <span className="flex items-center gap-0.5 text-primary">
                <Star className="h-3.5 w-3.5 fill-current" />
                <span className="text-xs font-body font-medium">{restaurant.rating}</span>
              </span>
            )}
          </div>
          <DrawerTitle className="font-heading text-xl text-foreground">
            {restaurant.name}
          </DrawerTitle>
          <DrawerDescription className="font-body text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
            <span>{restaurant.cuisine}</span>
            {restaurant.priceRange && (
              <>
                <span className="text-border">·</span>
                <span>{restaurant.priceRange}</span>
              </>
            )}
            {restaurant.neighborhood && (
              <>
                <span className="text-border">·</span>
                <span>{restaurant.neighborhood}</span>
              </>
            )}
            {distLabel && (
              <>
                <span className="text-border">·</span>
                <span className="flex items-center gap-0.5">
                  <MapPin className="h-3 w-3" />
                  {distLabel}
                </span>
              </>
            )}
          </DrawerDescription>
        </DrawerHeader>

        <div className="px-4 pb-2">
          {/* Time slots */}
          {slots.length > 0 && (
            <div className="mb-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-body mb-2">
                <Clock className="h-3.5 w-3.5" />
                <span>Available times</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {slots.map((slot, i) => (
                  <span
                    key={i}
                    className="px-2.5 py-1 rounded-md text-xs font-body font-medium bg-primary/10 text-primary"
                  >
                    {slot.time}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* CTA */}
          <a
            href={restaurant.platformUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl bg-primary text-primary-foreground font-body font-semibold text-sm hover:bg-primary/90 transition-colors mb-3"
          >
            Reserve on {PLATFORM_LABELS[restaurant.platform] || restaurant.platform}
            <ExternalLink className="h-4 w-4" />
          </a>

          <p className="text-[11px] text-muted-foreground font-body text-center mb-2">
            Opens the reservation page — your results stay here
          </p>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
