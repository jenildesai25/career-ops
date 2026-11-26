#!/usr/bin/env node
// Resolve the candidate's current employer(s) dynamically.
//
// Source of truth (in order):
//   1. config/profile.yml → current_employers (explicit override / aliases)
//   2. cv.md Experience entries whose date line ends in Present / Current / Ongoing
//
// Agents and local/company-gate.mjs call this before scan / triage / evaluate /
// apply / form-fill so the current employer is never treated as an external
// target. When cv.md later shows a new Present employer, exclusion follows —
// no code edit for the new name.
//
// Usage:
//   node local/current-employer.mjs              # JSON summary
//   node local/current-employer.mjs --check "Zscaler Inc"
//   node local/current-employer.mjs --self-test

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from '../lib/yaml-document.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const ROOT = getCareerOpsRoot();

/** Legal / ATS noise stripped before fuzzy compare (mirrors company-gate). */
const SUFFIXES = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'ltd', 'limited', 'llc', 'plc',
  'lp', 'llp', 'co', 'company', 'pc', 'pllc', 'pbc', 'sa', 'nv', 'bv', 'ag', 'gmbh',
]);

const PRESENT_RE = /\b(present|current|ongoing|today)\b/i;

export function coreName(value) {
  let tokens = String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens[0] === 'the') tokens = tokens.slice(1);
  const folded = [];
  for (let i = 0; i < tokens.length; i++) {
    let j = i;
    while (tokens[j]?.length === 1 && j + 1 < tokens.length && tokens[j + 1].length === 1) j++;
    if (j > i) {
      folded.push(tokens.slice(i, j + 1).join(''));
      i = j;
    } else {
      folded.push(tokens[i]);
    }
  }
  tokens = folded;
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  const core = tokens.join(' ');
  return core.length >= 2 ? core : '';
}

/**
 * Parse Work Experience from cv.md. A role is "current" when its date line
 * contains Present / Current / Ongoing (case-insensitive).
 *
 * Expected shape (Jenil / common markdown CV):
 *   ### Company — Location
 *   **Title**
 *   May 2026 – Present
 */
export function parsePresentEmployersFromCv(cvText) {
  const text = String(cvText || '');
  const expIdx = text.search(/^##\s+Work Experience\s*$/im);
  const slice = expIdx === -1 ? text : text.slice(expIdx);
  // Stop at next top-level ## section when present
  const nextSection = slice.search(/\n##\s+(?!Work Experience)/);
  const body = nextSection === -1 ? slice : slice.slice(0, nextSection);

  const employers = [];
  const blocks = body.split(/^###\s+/m).slice(1);
  for (const block of blocks) {
    const firstLine = block.split('\n')[0] || '';
    // "Zscaler — United States" / "Zscaler - US" / "Zscaler"
    const company = firstLine.split(/\s+[—–\-]\s+/)[0].replace(/\*+/g, '').trim();
    if (!company) continue;

    // Catch date lines, including bold-wrapped markdown.
    const looseDates = [...block.matchAll(
      /(?:^|\n)\s*\**\s*([A-Za-z]+\s+\d{4}|\d{4})\s*[–—\-]\s*([^*\n]+)\**/g,
    )];
    const allDateSnippets = [...new Set(looseDates.map(m => `${m[1]} – ${String(m[2]).trim()}`))];

    const isPresent = allDateSnippets.some(d => PRESENT_RE.test(d));
    const missingDates = allDateSnippets.length === 0;
    employers.push({
      name: company,
      present: isPresent,
      missingDates,
      dateHints: allDateSnippets.map(s => s.trim()),
    });
  }
  return employers;
}

function loadProfile(root = ROOT) {
  const path = join(root, 'config/profile.yml');
  if (!existsSync(path)) return null;
  return loadYaml(readFileSync(path, 'utf8'));
}

function loadCv(root = ROOT) {
  const path = join(root, 'cv.md');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function normalizeOverrideList(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ name: item.trim(), aliases: [] });
    } else if (item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim()) {
      const aliases = Array.isArray(item.aliases)
        ? item.aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim())
        : [];
      out.push({ name: item.name.trim(), aliases });
    }
  }
  return out;
}

/**
 * Resolve current employers for gating.
 * @returns {{
 *   employers: string[],
 *   cores: string[],
 *   aliases: string[],
 *   source: 'profile.yml'|'cv.md'|'profile.yml+cv.md'|'none',
 *   ambiguous: boolean,
 *   ambiguity_reasons: string[],
 *   roles: object[],
 * }}
 */
export function resolveCurrentEmployers({ root = ROOT, cvText = null, profile = null } = {}) {
  const prof = profile ?? loadProfile(root);
  const cv = cvText ?? loadCv(root);
  const overrides = normalizeOverrideList(prof?.current_employers);

  const roles = cv ? parsePresentEmployersFromCv(cv) : [];
  const presentRoles = roles.filter(r => r.present);
  const missingDateRoles = roles.filter(r => r.missingDates);

  const ambiguity_reasons = [];
  if (presentRoles.length > 1 && overrides.length === 0) {
    ambiguity_reasons.push(
      `cv.md has ${presentRoles.length} Present roles (${presentRoles.map(r => r.name).join(', ')}); confirm which to exclude or set current_employers in config/profile.yml`,
    );
  }
  if (missingDateRoles.length > 0 && presentRoles.length === 0 && overrides.length === 0) {
    ambiguity_reasons.push(
      `cv.md Experience entries missing dates (${missingDateRoles.map(r => r.name).join(', ')}); ask before excluding`,
    );
  }
  if (/contractor|consulting|freelance/i.test(presentRoles.map(r => r.name).join(' ')) && overrides.length === 0) {
    ambiguity_reasons.push('Present role name looks contractor/freelance; ask before excluding');
  }

  const fromCv = presentRoles.map(r => r.name);
  const fromProfile = overrides.map(o => o.name);
  const aliasList = overrides.flatMap(o => o.aliases);

  // Prefer profile override names when set; always merge CV Present names for fuzzy cores
  // unless profile is set as the only authority with empty merge — we UNION so CV drift
  // still expands exclusion when someone adds a second Present job.
  let employers;
  let source;
  if (fromProfile.length && fromCv.length) {
    employers = [...new Set([...fromProfile, ...fromCv])];
    source = 'profile.yml+cv.md';
  } else if (fromProfile.length) {
    employers = [...new Set(fromProfile)];
    source = 'profile.yml';
  } else if (fromCv.length) {
    employers = [...new Set(fromCv)];
    source = 'cv.md';
  } else {
    employers = [];
    source = 'none';
  }

  const cores = [...new Set([
    ...employers.map(coreName).filter(Boolean),
    ...aliasList.map(coreName).filter(Boolean),
  ])];

  return {
    employers,
    cores,
    aliases: aliasList,
    source,
    ambiguous: ambiguity_reasons.length > 0,
    ambiguity_reasons,
    roles: presentRoles.map(r => ({ name: r.name, dates: r.dateHints })),
  };
}

/** Fuzzy match: company name / slug / ATS board alias against resolved cores. */
export function matchesCurrentEmployer(candidate, resolved) {
  const res = resolved || resolveCurrentEmployers();
  if (!res.cores.length) return false;
  const candCore = coreName(candidate);
  if (!candCore) return false;
  if (res.cores.includes(candCore)) return true;
  // Slug-style: "zscaler" vs "zscaler inc" already handled by coreName.
  // Also allow token containment when one core is a single token and equals the other.
  for (const core of res.cores) {
    if (candCore === core) return true;
    // "zscaler" board vs "zscaler technologies" — only when the shorter is a
    // full token prefix of the longer (not a shared first word of unrelated names).
    const a = candCore.split(' ');
    const b = core.split(' ');
    if (a.length === 1 && b[0] === a[0] && b.length <= 2) return true;
    if (b.length === 1 && a[0] === b[0] && a.length <= 2) return true;
  }
  return false;
}

export function isExcludedBoard(boardName, careersUrl, resolved) {
  const res = resolved || resolveCurrentEmployers();
  if (matchesCurrentEmployer(boardName, res)) return true;
  if (careersUrl) {
    const url = String(careersUrl).toLowerCase();
    for (const core of res.cores) {
      const slug = core.replace(/\s+/g, '');
      if (slug.length >= 3 && (url.includes(`/${slug}`) || url.includes(`${slug}.`) || url.includes(`=${slug}`))) {
        return true;
      }
    }
  }
  return false;
}

function selfTest() {
  const sample = `# Name

## Work Experience

### Zscaler — United States

**Applied AI Engineer**
May 2026 – Present

- Built things.

### Palo Alto Networks — United States

**Senior Staff Software Engineer**
November 2021 – May 2026

- Built things.
`;
  const roles = parsePresentEmployersFromCv(sample);
  const present = roles.filter(r => r.present).map(r => r.name);
  if (present.length !== 1 || present[0] !== 'Zscaler') {
    console.error('expected Present=Zscaler only, got', present);
    process.exit(1);
  }
  const resolved = resolveCurrentEmployers({ cvText: sample, profile: {} });
  if (!matchesCurrentEmployer('Zscaler Inc', resolved)) {
    console.error('fuzzy Zscaler Inc failed');
    process.exit(1);
  }
  if (!matchesCurrentEmployer('zscaler', resolved)) {
    console.error('fuzzy zscaler slug failed');
    process.exit(1);
  }
  if (matchesCurrentEmployer('Palo Alto Networks', resolved)) {
    console.error('past employer must not match');
    process.exit(1);
  }
  if (!isExcludedBoard('Zscaler', 'https://job-boards.greenhouse.io/zscaler', resolved)) {
    console.error('ATS url exclusion failed');
    process.exit(1);
  }
  const withOverride = resolveCurrentEmployers({
    cvText: sample,
    profile: { current_employers: [{ name: 'Zscaler', aliases: ['ZS'] }] },
  });
  if (!matchesCurrentEmployer('ZS', withOverride)) {
    console.error('alias match failed');
    process.exit(1);
  }
  console.log('current-employer self-test: ok');
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const resolved = resolveCurrentEmployers();
  const checkIdx = process.argv.indexOf('--check');
  if (checkIdx !== -1) {
    const name = process.argv[checkIdx + 1] || '';
    console.log(JSON.stringify({
      candidate: name,
      excluded: matchesCurrentEmployer(name, resolved),
      ...resolved,
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    employers: resolved.employers,
    source: resolved.source,
    cores: resolved.cores,
    aliases: resolved.aliases,
    ambiguous: resolved.ambiguous,
    ambiguity_reasons: resolved.ambiguity_reasons,
    roles: resolved.roles,
  }, null, 2));
}

const invoked = process.argv[1] && (
  fileURLToPath(import.meta.url) === join(process.cwd(), process.argv[1])
  || process.argv[1].endsWith('current-employer.mjs')
);
if (invoked) {
  main();
}
