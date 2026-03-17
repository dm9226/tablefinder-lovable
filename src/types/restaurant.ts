export interface TimeSlot {
  time: string;
  token?: string;
  type?: string;
}

export interface Restaurant {
  id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  rating?: number;
  reviewCount?: number;
  priceRange?: string;
  imageUrl?: string;
  description?: string;
  vibeTags?: string[];
  platform: "resy" | "opentable" | "yelp";
  platformUrl: string;
  timeSlots: TimeSlot[];
  distanceMiles?: number | null;
}

export interface SearchParams {
  cuisine?: string;
  date: string;
  time: string;
  partySize: number;
  city: string;
  state?: string;
  country?: string;
  lat?: number;
  lng?: number;
}

export interface SearchMeta {
  date: string;
  time: string;
  partySize: number;
  city: string;
  state?: string;
  country?: string;
}

export interface SearchState {
  query: string;
  isLoading: boolean;
  results: Restaurant[];
  error: string | null;
  parsedParams: SearchParams | null;
}
