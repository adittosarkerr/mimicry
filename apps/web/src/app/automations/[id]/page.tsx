import { AutomationDetail } from '@/components/automation/automation-detail';

export const metadata = { title: 'Automation' };

export default async function AutomationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { id } = await params;
  const { new: isNew } = await searchParams;
  return <AutomationDetail id={id} isNew={isNew === '1'} />;
}
