import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FormattedText } from '../apps/web/src/formatted-text';

test('classroom formatted text renders styles and keeps pasted HTML and dangerous links inert', () => {
  const html = renderToStaticMarkup(
    createElement(FormattedText, {
      text: '## عنوان\n**سلام** و *متن* و __زیرخط__\n- مورد اول\n> نقل‌قول\n`<script>alert(1)</script>`\n[امن](https://example.org/a)\n[ناامن](javascript:alert)\n<img src=x onerror=alert(1)>',
    }),
  );
  assert.match(html, /<strong>سلام<\/strong>/);
  assert.match(html, /<em>متن<\/em>/);
  assert.match(html, /<u>زیرخط<\/u>/);
  assert.match(html, /formatted-list-item/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /href="https:\/\/example.org\/a"/);
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img/);
});
