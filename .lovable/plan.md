## Sync and Deploy

1. **Sync to latest main commit** — confirm local repo matches `origin/main` HEAD.
2. **Run migration** `20260518000001_contact_submissions.sql` — creates `contact_submissions` table with public INSERT RLS (already partially present; re-applying is idempotent if guarded, otherwise will be skipped if table exists).
3. **Deploy edge functions**:
   - `send-transactional-email` (new — will deploy but not function until `LOVABLE_EMAIL_API_KEY` and `LOVABLE_FROM_EMAIL` secrets are added post-DNS verification)
   - `search` (sync from v112 on main)
4. **Publish frontend** — new `/privacy`, `/terms`, `/contact` pages, updated `/about`, `/how-it-works`, footer, `RestaurantCard`, `ResultsGrid`.
5. **Skip test email send** per instruction.

No test invocations of `send-transactional-email` will be made.