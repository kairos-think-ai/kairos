import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import DashboardClient from './DashboardClient';

/**
 * Dashboard Page (Server Component)
 *
 * Checks auth server-side where cookies are immediately available
 * (no client-side race condition). If authenticated, renders the
 * client dashboard. If not, redirects to login.
 */
export default async function DashboardPage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
      },
    },
  );

  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  return <DashboardClient />;
}
