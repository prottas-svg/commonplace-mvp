# Commonplace Capture Prototype (V0.1)

This is an intentionally narrow internal prototype for testing the hardest product loop:

**natural language → structured entry/entries → metadata lookup → confirmation cards**

It does **not** yet include accounts, persistence, hamlets, comments, privacy, photo synthesis, or production audio transcription.

## What works now

- Type a natural-language reflection.
- In browsers that expose Web Speech Recognition, speak directly into the capture box.
- OpenAI Structured Outputs split/interpret one or more entries.
- Books resolve against Open Library with real cover/author metadata.
- Movies/TV resolve through TMDB when `TMDB_BEARER_TOKEN` is configured.
- Music and Places intentionally degrade to a valid unresolved entry until their adapters are configured.
- Memories never require an external object.
- Ten test utterances are built into the UI.

## Setup

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Add `OPENAI_API_KEY`.
4. Optional: add `TMDB_BEARER_TOKEN`.
5. Run:

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Why metadata resolution is server-side

Provider credentials stay off the client, adapters remain replaceable, and the internal object model does not depend on one provider.

## Current metadata routing

- Books → Open Library
- Movies/TV → TMDB (optional token)
- Music → Apple Music adapter planned
- Places/restaurants → Google Places adapter planned
- Memories → no lookup

Open Library describes its web APIs as appropriate for low-volume, human-triggered lookup rather than as a high-traffic third-party backend. For an MVP/private test that is a reasonable fit; at scale the architecture should move to bulk/commercial data as appropriate.

## Next engineering step

Run the fixed benchmark utterances and log, for each one:

- extraction correct?
- split correct?
- state correct?
- object match correct?
- user voice preserved?
- correction required?
- processing latency?

Only after this loop feels excellent should persistence/social UI be added.
