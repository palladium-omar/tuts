import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudentBoardKanban } from '../features/student-board-kanban';
import { deadlineCaption, deadlinePreviewTime, publicLink, templateBrand } from '../lib/student-board-presentation';

test('cards expose resources as separate links and retain movement only in the accessible menu', () => {
  const html = renderToStaticMarkup(createElement(StudentBoardKanban, {
    columns: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
    cards: [{ id: 'task', title: 'Apply', columnId: 'todo', position: 0, references: [
      { kind: 'link', label: 'Application portal', url: 'https://example.org/apply' },
      { kind: 'learning_resource', label: 'Essay notes', resourceId: 'resource' },
    ] }],
    canWrite: true, canManage: false, busy: false,
    onMove: async () => {}, onEdit: () => {}, onAdd: () => {}, onColumn: () => {},
  }));
  assert.match(html, /href="https:\/\/example.org\/apply"/);
  assert.match(html, /View 2 resources for Apply/);
  assert.match(html, /<summary aria-label="Move Apply"/);
  assert.doesNotMatch(html, />Move to Done</);
  assert.ok(html.indexOf('</button><div class="planning-card-resources"') >= 0, 'resource links must not be nested inside the open-task button');
});

test('suggested targets do not claim to be official and unsafe reference URLs are excluded', () => {
  assert.equal(deadlineCaption({ kind: 'personal', status: 'requires_confirmation' }), 'Suggested target');
  assert.equal(deadlineCaption({ kind: 'official', status: 'verified' }), 'Official deadline');
  assert.equal(deadlineCaption({ kind: 'official', status: 'requires_confirmation' }), 'Official date · confirm');
  assert.equal(publicLink('javascript:alert(1)'), null);
  assert.equal(publicLink('https://user:secret@example.org/'), null);
  assert.equal(publicLink('http://example.org/'), null);
});

test('template identity uses stable provider logos across entry cycles', () => {
  assert.equal(templateBrand('common-app-2027-us'), 'commonapp');
  assert.equal(templateBrand('campus-france-2028-morocco'), 'campusfrance');
  assert.equal(templateBrand('ucas-2027-early'), 'ucas');
  assert.equal(templateBrand('bocconi-2028-international'), 'bocconi');
  assert.equal(templateBrand('sat-2027'), 'collegeboard');
});

test('template preview omits artificial suggested times while keeping official deadline times', () => {
  const suggested = deadlinePreviewTime({kind:'personal',dueAt:'2027-01-13T12:00:00Z',timeZone:'Europe/London'});
  assert.doesNotMatch(suggested, /12:00/);
  const official = deadlinePreviewTime({kind:'official',dueAt:'2027-01-13T18:00:00Z',timeZone:'Europe/London'});
  assert.match(official, /Europe\/London/);
  assert.match(official, /(?:18:00|6:00)/);
});
