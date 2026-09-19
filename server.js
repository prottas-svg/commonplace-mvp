import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const model = process.env.OPENAI_MODEL || 'gpt-5';

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
          subtype: { type: ['string','null'], enum: ['book','movie','tv','album','song','podcast','restaurant','museum','location','article','artwork','other',null] },
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
  if (!client) return fallbackExtract(text);
  const response = await client.responses.create({
    model,
    instructions: `You extract entries for a private digital commonplace book. Preserve the user's meaning and voice. Split multiple distinct cultural objects or memories when useful. Infer only what is directly supported by the words. Never invent authors, dates, identifiers, addresses, or other factual metadata. If a user says they bought a book, ownership_state may be owned but state must not become reading unless they say they started it. If they express enthusiasm about a future item, affect may be excited. display_text should preserve the user's actual thought with only light cleanup. lookup_required should be true only when an external real-world entity should be resolved.`,
    input: text,
    text: {
      format: {
        type: 'json_schema',
        name: 'commonplace_entries',
        strict: true,
        schema: entrySchema
      }
    }
  });
  return JSON.parse(response.output_text);
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
  openai: Boolean(process.env.OPENAI_API_KEY),
  tmdb: Boolean(process.env.TMDB_BEARER_TOKEN),
  google_places: Boolean(process.env.GOOGLE_PLACES_API_KEY),
  apple_music: Boolean(process.env.APPLE_MUSIC_DEVELOPER_TOKEN)
}));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Commonplace prototype: http://localhost:${port}`));
