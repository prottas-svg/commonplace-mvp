// Usage: node test-parse.mjs [baseUrl]
// Default: the Railway deployment. Runs the benchmark transcripts and scores them.
const BASE = process.argv[2] || 'https://secure-creativity-production.up.railway.app';

const CASES = [
  {
    name: 'Central Park / Europe Central / Vivaldi',
    text: "Today I was in Central Park with my kids, loving all the people and the whole atmosphere. I read Europe Central by William Vollmann, and I was listening to Vivaldi. The whole day felt beautiful and like something I'll remember for a long time.",
    count: [3, 4],
    mustFind: ['central park', 'europe central', 'vivaldi'],
    forbidden: ['four seasons', 'primavera'], // not said
  },
  {
    name: 'Met / unnamed room / Middlemarch',
    text: "I went to the Metropolitan Museum of Art which I loved just in general and then this one room was incredible, all the paintings there were awesome, very cool, and then I read Middlemarch. I'm almost done and it is just such a gripping tale and something that I knew about in college because there was a theme party but never really even knew what the book was and now it's one of my all-time favorites.",
    count: [2, 3],
    mustFind: ['metropolitan', 'middlemarch'],
    forbidden: ['cezanne', 'monet', 'van gogh', 'rembrandt', 'vermeer'], // never said
    expectState: { middlemarch: 'reading' },
    expectRelated: { middlemarch: { name: 'eliot', source: 'resolved' } },
  },
  {
    name: 'Author named, no book',
    text: "I've been thinking a lot about Toni Morrison lately, she just writes sentences nobody else could.",
    count: [1, 1],
    mustFind: ['morrison'],
    forbidden: ['beloved', 'song of solomon', 'sula', 'bluest eye'],
  },
  {
    name: 'Messy real-speech version',
    text: "all right so today I was reading some book let's see what's in Central Park and uh the kids were running around the fountain which was great and then later I put on some Vivaldi",
    count: [2, 4],
    mustFind: ['central park', 'vivaldi'],
    forbidden: ['europe central', 'four seasons'],
  },
];

const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

let failures = 0;
for (const c of CASES) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/capture`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: c.text }),
  });
  const ms = Date.now() - t0;
  const data = await res.json();
  console.log(`\n=== ${c.name}  (${ms} ms) ===`);
  if (!res.ok) { console.log('  FAIL  HTTP', res.status, data.error); failures++; continue; }

  const problems = [], warnings = [];
  const E = data.entries || [];
  if (data.extraction_mode !== 'claude') problems.push(`extraction_mode=${data.extraction_mode} (Claude not called)`);
  if (E.length < c.count[0] || E.length > c.count[1]) problems.push(`${E.length} entries, expected ${c.count[0]}-${c.count[1]}`);
  if (E.some(e => norm(e.display_text).trim() === norm(c.text).trim())) problems.push('an entry is the whole transcript');

  const titles = E.map(e => norm(`${e.candidate_title} ${e.candidate_creator} ${e.display_text}`));
  for (const m of c.mustFind) if (!titles.some(t => t.includes(m))) problems.push(`missing: ${m}`);
  const allOut = norm(JSON.stringify(E.map(({ resolution, ...e }) => e)));
  for (const f of c.forbidden) if (allOut.includes(f)) problems.push(`INVENTED: ${f}`);
  for (const [k, st] of Object.entries(c.expectState || {})) {
    const e = E.find(e => norm(e.candidate_title).includes(k));
    if (e && e.state !== st) problems.push(`${k} state=${e.state}, expected ${st}`);
  }
  for (const [k, want] of Object.entries(c.expectRelated || {})) {
    const e = E.find(e => norm(e.candidate_title).includes(k));
    const r = e?.related?.find(r => r.role === 'author');
    if (!r || !norm(r.name).includes(want.name) || r.source !== want.source)
      problems.push(`${k}: expected author ~${want.name} (${want.source}), got ${r ? `${r.name} (${r.source})` : 'none'}`);
  }
  for (const e of E) {
    if (e.checks && !e.checks.quote_verbatim) warnings.push(`quote not verbatim: "${e.source_quote}"`);
    if (e.checks && !e.checks.title_grounded) problems.push(`title not in transcript: ${e.candidate_title}`);
    if (e.checks && !e.checks.creator_grounded) problems.push(`INVENTED creator: ${e.candidate_creator}`);
    if (e.subtype === 'author' && e.related?.length) problems.push(`author entry has attached works`);
  }

  E.forEach((e, i) => console.log(
    `  ${i + 1}. [${e.entry_type}/${e.subtype ?? '-'}] ${e.candidate_title ?? '(unnamed)'}` +
    `${e.candidate_creator ? ' — ' + e.candidate_creator : ''} | state=${e.state ?? '-'} affect=${e.affect ?? '-'} | ${e.resolution?.status}` +
    `${e.related?.length ? ' | ' + e.related.map(r => `${r.role}: ${r.name} (${r.source})`).join(', ') : ''}\n` +
    `     "${e.display_text}"`));
  problems.forEach(p => console.log('  FAIL ', p));
  warnings.forEach(w => console.log('  WARN ', w));
  if (!problems.length) console.log('  PASS');
  failures += problems.length ? 1 : 0;
}
console.log(`\n${CASES.length - failures}/${CASES.length} cases passed. Run 3x; extraction is nondeterministic.`);
process.exit(failures ? 1 : 0);
