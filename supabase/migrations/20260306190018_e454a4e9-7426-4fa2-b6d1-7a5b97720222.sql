
-- Cache table for NLP query parsing results (7-day TTL)
CREATE TABLE public.parse_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  query_hash TEXT NOT NULL UNIQUE,
  query_text TEXT NOT NULL,
  parsed_params JSONB NOT NULL,
  location_hint TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_parse_cache_hash ON public.parse_cache (query_hash);

ALTER TABLE public.parse_cache ENABLE ROW LEVEL SECURITY;

-- Public read (edge function uses service role for writes)
CREATE POLICY "Parse cache is publicly readable"
ON public.parse_cache FOR SELECT TO anon, authenticated
USING (true);
