import type { Metadata } from 'next';

import { LandingPage } from '@/components/landing/LandingPage';
import { BRAND_ENGLISH_NAME, DEFAULT_BRAND } from '@/lib/brand/brand-config';

export const metadata: Metadata = {
  title: `${DEFAULT_BRAND.productName} · ${BRAND_ENGLISH_NAME} — 一句话，生成一堂为你而上的课`,
  description:
    '说出想学的内容，AI 老师和同学会备好课件、讲解和练习，陪你在课堂里边问边学；学科空间、题库、错题本和复习计划让学习继续下去。',
};

export default function WelcomePage() {
  return <LandingPage />;
}
