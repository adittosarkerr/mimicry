import { Suspense } from 'react';
import { AuthForm } from '@/components/auth/auth-form';

export const metadata = {
  title: 'Create an account',
  description: 'Create a Mimic account to keep your automations and run history.',
};

export default function SignUpPage() {
  return (
    <Suspense>
      <AuthForm mode="sign-up" />
    </Suspense>
  );
}
