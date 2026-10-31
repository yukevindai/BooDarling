# Baroness pre-generated clips

MP3 versions of the Baroness's scripted lines (framing guidance, flow
announcements and preset critiques from `lib/critic/lines.ts`). Each clip is
named `<line-id>.mp3`, and `manifest.json` lists `{ id, text, file }` plus the
ElevenLabs `voiceId` / `modelId` used.

These clips are optional. They save credits and latency for lines that never
change. When a clip is missing the client falls back to `POST /api/speech`,
and if that fails too it shows the text only.

Generate them (needs `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in
`.env.local` or the environment):

    npx tsx lib/critic/generate-audio.ts            # skip clips that already exist
    npx tsx lib/critic/generate-audio.ts --force    # regenerate everything
    npx tsx lib/critic/generate-audio.ts --only guidance-   # only ids with this prefix

Regenerate with `--force` after changing the voice, the model or a line's text.
Never put API keys in this folder.
