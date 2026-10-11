import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const directory = new URL('../public/brands/', import.meta.url);
const assets = ['calcom.svg', 'calendly.svg', 'commonapp.svg', 'ucas.svg', 'bocconi.svg', 'campusfrance.webp'];

test('official provider logos are bundled locally and documented', () => {
  const provenance = readFileSync(new URL('README.md', directory), 'utf8');
  const component = readFileSync(new URL('../components/brand-logo.tsx', import.meta.url), 'utf8');
  for (const name of assets) {
    assert.ok(statSync(new URL(name, directory)).size < 20_000, name);
    assert.ok(provenance.includes(name), `Missing provenance for ${name}`);
    assert.ok(component.includes(name), `Missing component entry for ${name}`);
  }
});

test('SVG logos have no executable content or external dependencies', () => {
  for (const name of assets.filter((asset) => asset.endsWith('.svg'))) {
    const svg = readFileSync(new URL(name, directory), 'utf8');
    assert.match(svg, /<svg\b/);
    assert.doesNotMatch(svg, /<\s*(?:script|foreignObject|image)\b|\bon\w+\s*=|\b(?:xlink:)?href\s*=|javascript:|url\(\s*['"]?https?:/i, name);
  }
});
