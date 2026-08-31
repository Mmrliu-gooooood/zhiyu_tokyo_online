import type { Page, Locator } from '@playwright/test';

export class HomePage {
  readonly page: Page;
  readonly logo: Locator;
  readonly createCard: Locator;
  readonly textarea: Locator;
  readonly enterButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.logo = page.getByTestId('zhiyu-brand-lockup');
    this.createCard = page.getByTestId('zhiyu-home-create-card');
    this.textarea = page.locator('textarea');
    this.enterButton = page
      .getByRole('button', { name: /start class|开课|进入课堂/i });
  }

  async goto() {
    await this.page.goto('/');
  }

  async fillRequirement(text: string) {
    await this.textarea.fill(text);
  }

  async submit() {
    await this.enterButton.click();
  }
}
