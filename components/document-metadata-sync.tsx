'use client';

import { useEffect } from 'react';

import { DEFAULT_BRAND } from '@/lib/brand/brand-config';
import { useI18n } from '@/lib/hooks/use-i18n';

/** Keep browser-visible metadata aligned with the active client locale. */
export function DocumentMetadataSync() {
  const { locale, t } = useI18n();

  useEffect(() => {
    document.title = `${DEFAULT_BRAND.productName} · ${t('home.headline')}`;

    let description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!description) {
      description = document.createElement('meta');
      description.name = 'description';
      document.head.appendChild(description);
    }
    description.content = t('home.slogan');
  }, [locale, t]);

  return null;
}
