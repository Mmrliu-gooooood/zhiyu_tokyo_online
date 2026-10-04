'use client';

import { useState } from 'react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { calendarDateIn, daysUntilExam } from '@/lib/study/spaces/contracts';

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function RelativeTime({ iso }: { iso: string }) {
  const { locale } = useI18n();
  // Relative to when the view mounted; the pages reload their data on every visit.
  const [now] = useState(() => Date.now());
  const diff = Date.parse(iso) - now;
  let text: string;
  try {
    const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const unit = UNITS.find(([, ms]) => Math.abs(diff) >= ms);
    text = unit ? format.format(Math.round(diff / unit[1]), unit[0]) : format.format(0, 'minute');
  } catch {
    text = new Date(iso).toLocaleString();
  }
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString(locale)}>
      {text}
    </time>
  );
}

/** "23 days to the exam" / "exam today" / "exam was 3 days ago", in the space's time zone. */
export function ExamCountdown({
  examDate,
  timezone,
}: {
  examDate: string;
  timezone: string | null;
}) {
  const { t } = useI18n();
  const days = daysUntilExam(examDate, calendarDateIn(timezone));
  if (days === null) return null;
  const text =
    days > 0
      ? t('study.exam.daysLeft', { count: days })
      : days === 0
        ? t('study.exam.today')
        : t('study.exam.passed', { count: -days });
  return <span data-testid="study-exam-countdown">{text}</span>;
}
