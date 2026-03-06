
-- Cache table for search results (public, no auth needed)
CREATE TABLE public.search_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  query_text TEXT NOT NULL,
  parsed_params JSONB,
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index for fast cache lookups
CREATE INDEX idx_search_cache_key ON public.search_cache (cache_key);
CREATE INDEX idx_search_cache_updated ON public.search_cache (updated_at);

-- Enable RLS (public read/write via service role only from edge function)
ALTER TABLE public.search_cache ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read cache (results are public restaurant data)
CREATE POLICY "Cache is publicly readable"
ON public.search_cache FOR SELECT TO anon, authenticated
USING (true);

-- Only service role can insert/update/delete (edge function uses service role)
-- No explicit policy needed for service role as it bypasses RLS
