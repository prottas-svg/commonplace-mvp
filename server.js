import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const anthropicApiKey = process.env.ANTHROPIC_API_KEY || null;
const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const entrySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'entry_type','subtype','candidate_title','candidate_creator','state',
          'ownership_state','affect','display_text','source_quote','lookup_required','confidence'
        ],
        properties: {
          entry_type: { type: 'string', enum: ['culture','place','memory','other'] },
          subtype: { type: 'string', enum: ['book','movie','tv','album','song','podcast','restaurant','museum','location','article','artwork','artist','musician','author','other','none'] },
          candidate_title: { type: ['string','null'] },
          candidate_creator: { type: ['string','null'] },
          state: { type: 'string', enum: ['want_to_read','owned','reading','finished','want_to_watch','watching','watched','want_to_listen','listening','heard','want_to_go','visited','want_to_try','went','saved','experienced','none'] },
          ownership_state: { type: 'string', enum: ['owned','borrowed','unknown','none'] },
          affect: { type: 'string', enum: ['loved','liked','mixed','disliked','excited','none'] },
          display_text: { type: 'string' },
          source_quote: { type: 'string' },
          lookup_required: { type: 'boolean' },
          confidence: { type: 'number' }
        }
      }
    }
  }
};

function fallbackExtract(text) {
  return {
    entries: [{
      entry_type: 'memory', subtype: null, candidate_title: null, candidate_creator: null,
      state: null, ownership_state: null, affect: null, display_text: text,
      source_quote: text, lookup_required: false, confidence: 0.5
    }],
    extraction_mode: 'fallback_no_api_key'
  };
}

async function extractEntries(text) {
  if (!anthropicApiKey) return fallbackExtract(text);

  const system = `You extract entries for a private digital commonplace book from one spoken or typed reflection. Return between 1 and 10 entries.

SPLITTING
Split when the PRIMARY OBJECT OF ATTENTION meaningfully changes, not merely when the category changes. A place, a distinct reaction to something within that place, a book, a piece of music, and a personal or family moment can each be separate entries if each would be independently useful to retrieve later. Do not split every sentence, and do not create an entry for a passing mention with no reaction or state attached. Never return the whole transcript as one entry when it clearly covers several objects of attention.

GROUNDING (most important)
- candidate_title and candidate_creator must come from words the user actually said, lightly normalized (capitalization, obvious transcription errors strongly supported by context). Never supply a name the user did not say.
- If the user refers to something without naming it ("this one room", "a painting", "some book"), you may still make it a separate entry if it is a distinct object of attention, but set candidate_title=null, candidate_creator=null, lookup_required=false.
- Fill candidate_creator ONLY if the user said the creator's name. Otherwise null, even for famous works; the system looks up creators separately.
- Never invent authors, dates, identifiers, addresses, room names, artworks, or other factual metadata.

FIELDS
- For subtype, state, ownership_state, and affect, use the value "none" when nothing applies.
- source_quote: an EXACT contiguous excerpt copied from the input that this entry is based on. Copy characters verbatim, including filler words and errors. Do not paraphrase.
- display_text: the user's thought for this entry in their own voice, with light cleanup only (remove filler like "um", "let's see"; keep their wording and opinions). No summarizing in third person.
- Named writer without a specific book: entry_type=culture, subtype=author, candidate_title=the writer's name, candidate_creator=null, lookup_required=true. Do not add any of their books.
- Named musician or composer without a specific work: entry_type=culture, subtype=musician. Named visual artist without a specific work: subtype=artist. Named specific artwork: subtype=artwork.
- If the user bought a book, ownership_state may be owned, but state must not become reading unless they say they started it. "Almost done" means reading.
- Past-tense "I read X" or "I was reading X" about a particular day means reading, not finished. Use finished only if the user says they finished, completed, or got to the end.
- A reaction to an unnamed thing seen inside a place (a room of paintings, an exhibit, a dish) is about the thing, not the place: use entry_type=culture with the fitting subtype (e.g. artwork), candidate_title=null, lookup_required=false.
- affect=excited for enthusiasm about a future item.
- lookup_required=true only when a named real-world entity should be resolved.

EXAMPLE (illustrative only; do not reuse its entities)
Input: "Had dinner at Lucia's with my sister, the gnocchi was unreal, and on the drive home I finally started that Robert Caro book she gave me, plus the new Radiolab episode on sleep was kind of boring."
Entries: Lucia's (place/restaurant, went, loved); dinner with sister (memory) only if the user dwells on it, otherwise fold into Lucia's; The Power Broker? NO: the user said "that Robert Caro book", so candidate_title=null, candidate_creator="Robert Caro", state=reading, lookup_required=false; Radiolab episode on sleep (culture/podcast, heard, disliked).`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 2500,
      system,
      messages: [{ role: 'user', content: text }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: entrySchema
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const detail = data?.error?.message || `Anthropic ${response.status}`;
    throw new Error(detail);
  }
  if (data.stop_reason === 'max_tokens') throw new Error('Claude hit max_tokens before finishing the JSON.');
  if (data.stop_reason === 'refusal') throw new Error('Claude declined this input.');
  const textBlock = (data.content || []).find((block) => block.type === 'text');
  if (!textBlock?.text) throw new Error('Claude returned no structured text output.');
  const parsed = JSON.parse(textBlock.text);
  const ENUM_FIELDS = ['subtype','state','ownership_state','affect'];
  parsed.entries = (parsed.entries || []).map((e) => {
    for (const f of ENUM_FIELDS) if (e[f] === 'none') e[f] = null;
    return e;
  });
  return { ...parsed, extraction_mode: 'claude' };
}

async function searchOpenLibrary(title, creator) {
  const url = new URL('https://openlibrary.org/search.json');
  url.searchParams.set('title', title || '');
  if (creator) url.searchParams.set('author', creator);
  url.searchParams.set('fields', 'key,title,author_name,first_publish_year,cover_i,isbn');
  url.searchParams.set('limit', '5');
  const res = await fetch(url, { headers: { 'User-Agent': 'CommonplacePrototype/0.1 (private MVP test)' } });
  if (!res.ok) throw new Error(`Open Library ${res.status}`);
  const data = await res.json();
  return (data.docs || []).map((d) => ({
    provider: 'open_library',
    provider_id: d.key,
    title: d.title,
    creator: d.author_name?.[0] || null,
    year: d.first_publish_year || null,
    image: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
    identifiers: { isbn: d.isbn?.slice(0, 4) || [] }
  }));
}

async function searchOpenLibraryAuthor(name) {
  const url = new URL('https://openlibrary.org/search/authors.json');
  url.searchParams.set('q', name);
  url.searchParams.set('limit', '5');
  const res = await fetch(url, { headers: { 'User-Agent': 'CommonplacePrototype/0.1 (private MVP test)' } });
  if (!res.ok) throw new Error(`Open Library ${res.status}`);
  const data = await res.json();
  // top_work is kept only as taste context for later; it is never attached to the entry.
  return (data.docs || []).map((d) => ({
    provider: 'open_library', provider_id: `/authors/${d.key}`,
    title: d.name, creator: null, year: d.birth_date || null,
    image: `https://covers.openlibrary.org/a/olid/${d.key}-M.jpg`,
    identifiers: {}, taste_context: { top_work: d.top_work || null, work_count: d.work_count || 0 }
  }));
}

async function searchTMDB(title, subtype) {
  const token = process.env.TMDB_BEARER_TOKEN;
  if (!token) return [];
  const endpoint = subtype === 'tv' ? 'tv' : 'movie';
  const url = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);
  url.searchParams.set('query', title);
  url.searchParams.set('include_adult', 'false');
  url.searchParams.set('language', 'en-US');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0,5).map((d) => ({
    provider: 'tmdb', provider_id: String(d.id),
    title: d.title || d.name,
    creator: null,
    year: (d.release_date || d.first_air_date || '').slice(0,4) || null,
    image: d.poster_path ? `https://image.tmdb.org/t/p/w342${d.poster_path}` : null,
    identifiers: {}
  }));
}

async function resolve(entry) {
  if (!entry.lookup_required || !entry.candidate_title) return { status: 'not_needed', candidates: [] };
  try {
    if (entry.subtype === 'book') {
      const candidates = await searchOpenLibrary(entry.candidate_title, entry.candidate_creator);
      return resolutionFrom(candidates);
    }
    if (entry.subtype === 'author') {
      return resolutionFrom(await searchOpenLibraryAuthor(entry.candidate_title));
    }
    if (entry.subtype === 'movie' || entry.subtype === 'tv') {
      const candidates = await searchTMDB(entry.candidate_title, entry.subtype);
      if (!process.env.TMDB_BEARER_TOKEN) return { status: 'adapter_not_configured', provider: 'tmdb', candidates: [] };
      return resolutionFrom(candidates);
    }
    return { status: 'adapter_not_configured', provider: providerFor(entry.subtype), candidates: [] };
  } catch (err) {
    return { status: 'error', message: err.message, candidates: [] };
  }
}

function providerFor(subtype) {
  if (['album','song','musician'].includes(subtype)) return 'apple_music';
  if (['restaurant','museum','location'].includes(subtype)) return 'google_places';
  if (['artist','artwork'].includes(subtype)) return 'art_metadata';
  return 'generic';
}

function normalize(s='') {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
const STOP = new Set(['the','a','an','of','and','by','in','on','at','to','de','la','le']);
// Flags names that don't appear in what the user said. Flags, never drops.
function grounding(entry, input) {
  const src = ' ' + normalize(input) + ' ';
  const quote = normalize(entry.source_quote || '');
  const nameGrounded = (name) => {
    if (!name) return true;
    const words = normalize(name).split(' ').filter(w => w && !STOP.has(w));
    return words.length > 0 && words.some(w => src.includes(' ' + w + ' '));
  };
  return {
    quote_verbatim: quote.length > 0 && src.includes(' ' + quote + ' '),
    title_grounded: nameGrounded(entry.candidate_title),
    creator_grounded: nameGrounded(entry.candidate_creator)
  };
}
function resolutionFrom(candidates) {
  if (!candidates.length) return { status: 'unresolved', candidates: [] };
  return { status: candidates.length === 1 ? 'matched' : 'candidates', candidates };
}

// A book entry carries its author as a secondary related object.
// source says whether the user said the name or the metadata supplied it.
function relatedFor(entry, resolution) {
  if (entry.subtype !== 'book') return [];
  if (entry.candidate_creator) {
    return [{ role: 'author', name: entry.candidate_creator, source: 'stated' }];
  }
  const top = resolution.candidates?.[0];
  return top?.creator ? [{ role: 'author', name: top.creator, source: 'resolved', provider: top.provider }] : [];
}

app.post('/api/capture', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Text is required.' });
  try {
    const extracted = await extractEntries(text);
    const enriched = await Promise.all(extracted.entries.map(async (entry) => {
      const resolution = await resolve(entry);
      return { ...entry, checks: grounding(entry, text), resolution, related: relatedFor(entry, resolution) };
    }));
    res.json({ input: text, extraction_mode: extracted.extraction_mode, entries: enriched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Capture failed.' });
  }
});

app.get('/api/health', (req,res) => res.json({
  ok: true,
  anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  model,
  tmdb: Boolean(process.env.TMDB_BEARER_TOKEN),
  google_places: Boolean(process.env.GOOGLE_PLACES_API_KEY),
  apple_music: Boolean(process.env.APPLE_MUSIC_DEVELOPER_TOKEN)
}));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Commonplace prototype: http://localhost:${port}`));
