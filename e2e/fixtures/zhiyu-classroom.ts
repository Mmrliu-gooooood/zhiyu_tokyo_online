import type { Page } from '@playwright/test';
import { createSettingsStorage } from './test-data/settings';
import { defaultTheme } from './test-data/scene-content';

export const ZHIYU_CLASSROOM_STAGE_ID = 'e2e-zhiyu-classroom';

/** Seed the same real IndexedDB records consumed by the classroom route. */
export async function seedClassroomDatabase(
  page: Page,
  settingsOverrides: Record<string, unknown> = {},
) {
  const settingsStorage = createSettingsStorage({
    sidebarCollapsed: false,
    chatAreaCollapsed: false,
    ttsEnabled: false,
    autoPlayLecture: false,
    ...settingsOverrides,
  });
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
    localStorage.setItem('locale', 'en-US');
  }, settingsStorage);

  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(
    ({ stageId, theme }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');
        request.onsuccess = (event) => {
          const database = (event.target as IDBOpenDBRequest).result;
          const transaction = database.transaction(
            ['stages', 'scenes', 'stageOutlines'],
            'readwrite',
          );
          const now = Date.now();
          transaction.objectStore('stages').put({
            id: stageId,
            name: 'Photosynthesis',
            description: '',
            language: 'en-US',
            style: 'professional',
            createdAt: now,
            updatedAt: now,
          });
          const makeSlideContent = (title: string, id: string) => ({
            type: 'slide',
            canvas: {
              id: `slide-${id}`,
              viewportSize: 1000,
              viewportRatio: 0.5625,
              theme,
              elements: [
                {
                  type: 'text',
                  id: `element-${id}`,
                  content: title,
                  left: 50,
                  top: 50,
                  width: 900,
                  height: 100,
                },
              ],
            },
          });
          ['Foundations', 'Light reactions', 'Carbon cycle'].forEach((title, order) => {
            transaction.objectStore('scenes').put({
              id: `zhiyu-scene-${order}`,
              stageId,
              type: 'slide',
              title,
              order,
              content: makeSlideContent(title, String(order)),
              actions: [
                {
                  id: `speech-${order}`,
                  type: 'speech',
                  text: `${title} classroom explanation.`,
                },
              ],
              createdAt: now,
              updatedAt: now,
            });
          });
          transaction.objectStore('stageOutlines').put({
            stageId,
            outlines: [],
            createdAt: now,
            updatedAt: now,
          });
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { stageId: ZHIYU_CLASSROOM_STAGE_ID, theme: defaultTheme },
  );
}
