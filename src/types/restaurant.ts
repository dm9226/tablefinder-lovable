export interface TimeSlot {
  time: string;
  url?: string;   // platform booking URL pre-filled with this slot's exact time
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
  platform: "resy";
  platformUrl: string;
  timeSlots: TimeSlot[];
  distanceMiles?: number | null;
  softVerified?: boolean;
  _lat?: number;
  _lng?: number;
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
  date: string;       // formatted display e.g. "Tonight"
  dateRaw?: string;   // YYYY-MM-DD
  time: string;
  partySize: number;
  city: string;
  state?: string;
  country?: string;
  hasMore?: boolean;
  remainingCandidates?: Restaurant[];
}

export interface SearchState {
  query: string;
  isLoading: boolean;
  results: Restaurant[];
  error: string | null;
  parsedParams: SearchParams | null;
}
