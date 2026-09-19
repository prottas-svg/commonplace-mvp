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
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'entry_type','subtype','candidate_title','candidate_creator','state',
          'ownership_state','affect','display_text','lookup_required','confidence'
        ],
        properties: {
          entry_type: { type: 'string', enum: ['culture','place','memory','other'] },
          subtype: { type: ['string','null'], enum: ['book','movie','tv','album','song','podcast','restaurant','museum','location','article','artwork','artist','other',null] },
          candidate_title: { type: ['string','null'] },
          candidate_creator: { type: ['string','null'] },
          state: { type: ['string','null'], enum: ['want_to_read','owned','reading','finished','want_to_watch','watching','watched','want_to_listen','listening','heard','want_to_go','visited','want_to_try','went','saved','experienced',null] },
          ownership_state: { type: ['string','null'], enum: ['owned','borrowed','unknown',null] },
          affect: { type: ['string','null'], enum: ['loved','liked','mixed','disliked','excited',null] },
          display_text: { type: 'string' },
          lookup_required: { type: 'boolean' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
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
      lookup_required: false, confidence: 0.5
    }]
  };
}

async function extractEntries(text) {
  if (!anthropicApiKey) return fallbackExtract(text);

  const system = `You extract entries for a private digital commonplace book. Preserve the user's meaning and voice. Split a single utterance into multiple entries whenever the PRIMARY OBJECT OF ATTENTION changes, even when the items are related or nested. A place visit, a distinct reflection on an artist or artwork there, a book reflection, a music reflection, and a personal/family moment can all be separate entries from one recording if each would be independently useful to retrieve later. Do not split every sentence: split only when each resulting entry has its own meaningful object of attention or memory.

Examples:
- "I went to the Met, loved the Cezannes, then read Middlemarch" should normally create 3 entries: Met/place, Cezanne/artist or artwork, Middlemarch/book.
- "We were in Central Park, the kids were running around and I want to remember it, I read Europe Central, and listened to Vivaldi" should normally create 4 entries: Central Park/place, family memory, Europe Central/book, Vivaldi/music.

If a named artist is discussed without a specific work, use entry_type=culture, subtype=artist, candidate_title=the artist's name, lookup_required=false. If a specific artwork is named, use subtype=artwork. Infer only what is directly supported by the words. You may repair an obvious speech-transcription artifact only when the intended entity is strongly supported by context; otherwise keep it unresolved. Never invent authors, dates, identifiers, addresses, room names, artworks, or other factual metadata. If a user says they bought a book, ownership_state may be owned but state must not become reading unless they say they started it. If they express enthusiasm about a future item, affect may be excited. display_text should preserve the user's actual thought with only light cleanup. lookup_required should be true only when an external real-world entity should be resolved.`;

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
  const textBlock = (data.content || []).find((block) => block.type === 'text');
  if (!textBlock?.text) throw new Error('Claude returned no structured text output.');
  return JSON.parse(textBlock.text);
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
  if (['album','song'].includes(subtype)) return 'apple_music';
  if (['restaurant','museum','location'].includes(subtype)) return 'google_places';
  if (['artist','artwork'].includes(subtype)) return 'art_metadata';
  return 'generic';
}

function normalize(s='') { return s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function resolutionFrom(candidates) {
  if (!candidates.length) return { status: 'unresolved', candidates: [] };
  return { status: candidates.length === 1 ? 'matched' : 'candidates', candidates };
}

app.post('/api/capture', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Text is required.' });
  try {
    const extracted = await extractEntries(text);
    const enriched = await Promise.all(extracted.entries.map(async (entry) => ({
      ...entry,
      resolution: await resolve(entry)
    })));
    res.json({ input: text, entries: enriched });
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
