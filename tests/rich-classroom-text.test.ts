import test from 'node:test';
import React from 'react';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RichMarkdown,
  normalizeClassroomMarkdown,
  safeClassroomLink,
} from '../apps/web/src/rich-markdown';
import { participantAvatarStyle, participantColor } from '../apps/web/src/participant-identity';

test('classroom Markdown renders visual marks, lists and safe links without executing HTML', () => {
  const html = renderToStaticMarkup(
    React.createElement(RichMarkdown, {
      text: '**Bold** *Italic* <u>Under **both**</u>\n\n1. First\n2. Second\n\n[Docs](https://example.com)\n\n<img src=x onerror=alert(1)>\n\n[Unsafe](javascript:alert(1))',
    }),
  );
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<em>Italic<\/em>/);
  assert.match(html, /<u>Under <strong>both<\/strong><\/u>/);
  assert.match(html, /<ol/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<img|href="javascript:/);
  assert.equal(safeClassroomLink('data:text/html,x'), undefined);
  assert.equal(safeClassroomLink('javascript:alert(1)'), undefined);
  assert.equal(normalizeClassroomMarkdown('__old__ `__code__`'), '<u>old</u> `__code__`');
});
test('participant color belongs to user identity and role controls avatar shape', () => {
  const color = participantColor('learner-id');
  for (let index = 0; index < 100; index++) assert.equal(participantColor('learner-id'), color);
  assert.equal(participantAvatarStyle('learner-id', false).borderRadius, '50%');
  assert.equal(participantAvatarStyle('teacher-id', true).borderRadius, '6px');
});
