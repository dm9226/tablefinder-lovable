export interface TimeSlot {
  time: string; // e.g. "7:30 PM"
  token?: string; // Resy reservation token
  type?: string; // e.g. "Dining Room", "Bar"
}

export interface Restaurant {
  id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  rating?: number;
  priceRange?: string; // e.g. "$$", "$$$"
  imageUrl?: string;
  platform: "resy" | "opentable" | "yelp";
  platformUrl: string;
  timeSlots: TimeSlot[];
}

export interface SearchParams {
  cuisine?: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM (24h)
  partySize: number;
  city: string;
  state?: string;
  lat?: number;
  lng?: number;
}

export interface SearchState {
  query: string;
  isLoading: boolean;
  results: Restaurant[];
  error: string | null;
  parsedParams: SearchParams | null;
}
