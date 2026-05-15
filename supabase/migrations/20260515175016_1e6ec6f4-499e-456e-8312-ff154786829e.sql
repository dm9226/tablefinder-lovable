DROP POLICY "Anyone can join waitlist" ON public.waitlist;
CREATE POLICY "Anyone can join waitlist with valid email"
ON public.waitlist FOR INSERT TO anon, authenticated
WITH CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' AND length(email) <= 254);