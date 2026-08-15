'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { api, formatMoney, type AutomationSummary } from '@/lib/api';
import { Button } from '@/components/ui';

/**
 * Putting an automation on the marketplace.
 *
 * Price is entered in whole taka and stored in minor units, because a price
 * kept as a float is a rounding error waiting to be somebody's bill.
 */
export function PublishDialog({
  automation,
  userId,
  sellerName,
  onClose,
  onPublished,
}: {
  automation: AutomationSummary;
  userId: string;
  sellerName: string;
  onClose: () => void;
  onPublished: () => void;
}) {
  const [title, setTitle] = useState(automation.name);
  const [tagline, setTagline] = useState(automation.description.slice(0, 140));
  const [price, setPrice] = useState('0');
  const [interval, setInterval] = useState<'month' | 'year' | 'one_time'>('month');
  const [trialDays, setTrialDays] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceMinor = Math.max(0, Math.round(Number(price) * 100)) || 0;

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.publishListing(userId, {
        automationId: automation.id,
        title: title.trim(),
        tagline: tagline.trim(),
        description: automation.description,
        sellerName,
        priceMinor,
        currency: 'BDT',
        interval,
        trialDays: Math.max(0, Math.round(Number(trialDays)) || 0),
        coverEmoji: automation.emoji,
      });
      onPublished();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-5 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.22 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-[20px] border border-sand-200 bg-white p-6 shadow-xl"
      >
        <h2 className="font-display text-2xl text-ink-900">Publish to the marketplace</h2>
        <p className="mt-1 text-[13.5px] text-ink-500">
          Anyone can subscribe and run it with their own values. Your recorded values stay as the
          defaults.
        </p>

        <div className="mt-5 space-y-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink-700">Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink-700">One line about it</span>
            <input value={tagline} onChange={(e) => setTagline(e.target.value)} className="input" />
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink-700">Price (BDT)</span>
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                className="input"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink-700">Billing</span>
              <select
                value={interval}
                onChange={(e) => setInterval(e.target.value as typeof interval)}
                className="input"
              >
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
                <option value="one_time">One-time</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink-700">Trial days</span>
              <input
                value={trialDays}
                onChange={(e) => setTrialDays(e.target.value)}
                inputMode="numeric"
                className="input"
              />
            </label>
          </div>

          <p className="text-[12.5px] text-ink-400">
            Listed at {priceMinor ? `${formatMoney(priceMinor)} ${interval === 'one_time' ? 'once' : `per ${interval}`}` : 'no charge'}.
            Payments are sandboxed — nothing real is taken.
          </p>
        </div>

        {error && (
          <p className="mt-4 rounded-xl border border-red-200 bg-rust-100 px-3 py-2 text-[13px] text-rust-500">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={publish} disabled={!title.trim()}>
            Publish
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
