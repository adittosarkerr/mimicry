import { Suspense } from 'react';
import { AuthForm } from '@/components/auth/auth-form';

export const metadata = {
  title: 'Sign in',
  description: 'Sign in to your Mimic account.',
};

export default function SignInPage() {
  // useSearchParams needs a boundary — the page reads `?next=` to return you
  // to whatever you were trying to reach.
  return (
    <Suspense>
      <AuthForm mode="sign-in" />
    </Suspense>
  );
}
