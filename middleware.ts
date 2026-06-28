import { clerkMiddleware } from '@clerk/nextjs/server';
import { updateSession } from '@/utils/supabase/middleware';

// Clerk wraps the existing Supabase session refresh: clerkMiddleware attaches
// auth context to every matched request, and we still run updateSession so the
// Supabase SSR cookies stay fresh. clerkMiddleware does not protect any route by
// default — pages stay public until we explicitly call auth.protect().
export default clerkMiddleware(async (_auth, request) => {
  return await updateSession(request);
});

export const config = {
  matcher: [
    // Everything except static assets and image optimization.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
    // Always run for API routes.
    '/(api|trpc)(.*)',
  ],
};
