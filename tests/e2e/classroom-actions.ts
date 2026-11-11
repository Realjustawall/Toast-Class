import type { Page, Locator } from '@playwright/test';

export async function setAppLanguage(page: Page, language: 'en' | 'fa') {
  await page.locator('.application-settings-trigger').first().click();
  const settings = page.locator('.application-settings-page');
  await settings.locator('[data-setting="language"]').selectOption(language);
  await page.keyboard.press('Escape');
}
export async function chooseMicrophone(page: Page) {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Use microphone/ })
    .click();
}
export async function selectEditorText(editor: Locator, from: number, to: number) {
  await editor.evaluate(
    (element, { from, to }) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT),
        entries: { node: Node; start: number; end: number }[] = [];
      let count = 0,
        node;
      while ((node = walker.nextNode())) {
        entries.push({ node, start: count, end: count + (node.textContent?.length ?? 0) });
        count += node.textContent?.length ?? 0;
      }
      const start = entries.find((item) => from <= item.end),
        end = entries.find((item) => to <= item.end);
      if (!start || !end) throw new Error('Editor selection is outside text');
      const range = document.createRange();
      range.setStart(start.node, from - start.start);
      range.setEnd(end.node, to - end.start);
      element.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    { from, to },
  );
}
export async function openDocumentMenu(page: Page) {
  const menu = page.locator('.document-editor header .overflow-menu').first();
  if ((await menu.count()) && !(await menu.getAttribute('open').then((value) => value !== null)))
    await menu.locator('summary').click();
}
export async function boardAction(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  const menu = page.locator('.board-status .overflow-menu').first();
  if (
    !(await button.isVisible()) &&
    (await menu.count()) &&
    !(await menu.getAttribute('open').then((value) => value !== null))
  )
    await menu.locator('summary').click();
  await button.click();
}
