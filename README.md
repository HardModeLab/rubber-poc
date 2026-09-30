# Rubber PoC

Rubber is a proof of concept of a **voice-enabled chatbot for the terminal**. You type a message, a local LLM answers in streaming, and the answer is spoken aloud by a local text-to-speech (XTTS) server, sentence by sentence, while the LLM is still writing.

Everything runs locally: no cloud service is involved.

## How it works

```
 terminal input ──► LM Studio (LLM, streaming) ──► sentence splitter ──► XTTS (WAV per sentence) ──► paplay / aplay
```

1. **Input**: `index.js` reads a line from stdin (`Vous:` prompt). Typing `exit` quits.
2. **LLM**: the message is sent, with the system prompt from `config/system.txt`, to the OpenAI-compatible endpoint of LM Studio (`http://localhost:1234/v1/chat/completions`, model `google/gemma-3n-e4b`, `stream: true`). Tokens are printed as they arrive.
3. **Sentence splitting**: tokens are buffered and cut at punctuation (`. ! ? ; :`) once the buffer exceeds 50 characters. Each chunk is pushed in a generation queue.
4. **Text-to-speech**: chunks are sent one at a time to the XTTS API (`http://localhost:8020/tts_to_audio/`, language `fr`), which clones the voice from `config/reference.wav`. Each chunk is saved as `outputs/stream_part_N.wav`.
5. **Playback**: WAV files are played in order with `paplay` (fallback `aplay`) and deleted once played.
6. **Interruption**: submitting a new line at any time stops the current audio (process group killed, leftover `paplay`/`aplay` processes killed), empties both queues, invalidates in-flight requests via a session id and removes leftover WAV files, then starts the new answer.

### Adaptive buffering

The player measures the **real-time factor (RTF)** = generation time / audio duration (smoothed with a 0.7/0.3 moving average):

- **LIVE (Stream)**, RTF <= 1.1: TTS is faster than speech, playback starts after ~1 s of audio is buffered (3 s before the first measure).
- **SAFE (Wait)**, RTF > 1.1: TTS is slower than speech. Playback waits until the LLM has finished, then until enough audio is buffered to avoid gaps (estimated from remaining characters, at 15 chars/s of audio).

A status bar pinned at the top of the terminal shows `RTF`, the audio queue size (`Q`), pending generations (`P`), the mode and the current state (`THINKING...`, `STREAMING...`, `BUFFERING`, `PLAYING`, `FINISHED`, `INTERRUPTED`, `XTTS ERR`...).

## Repository layout

| Path | Role |
| --- | --- |
| `index.js` | The whole application: UI, LLM streaming, TTS queue, audio player, interruption handling |
| `config/system.txt` | System prompt defining Rubber's personality (French, written to be read aloud) |
| `config/reference.wav` | Reference voice sample used by XTTS for voice cloning |
| `docker-compose.yml` | Runs the XTTS API server (`daswer123/xtts-api-server`) on port 8020 |
| `outputs/` | Temporary generated audio files (git-ignored) |
| `package.json` | Node.js project (ES modules), `yarn start` script |

## Prerequisites

- Node.js and Yarn
- Docker and Docker Compose
- A Linux audio stack providing `paplay` (PulseAudio/PipeWire) or `aplay` (ALSA)
- A local LLM API: [LM Studio](https://lmstudio.ai/) with the `google/gemma-3n-e4b` model installed and its local server started on port 1234

## Installation

```bash
git clone git@github.com:HardModeLab/rubber-poc.git
cd rubber-poc
yarn install
```

## Run

1. Start the XTTS server (the first start downloads the model and accepts the Coqui TOS through `COQUI_TOS_AGREED=1`):
   ```bash
   docker compose up -d
   ```
2. Start the LM Studio server with `google/gemma-3n-e4b` loaded.
3. Start the chatbot:
   ```bash
   yarn start
   ```
4. Type a message at the `Vous:` prompt. Type again at any time to interrupt the current answer, or `exit` to quit.

## Configuration

Settings are constants at the top of `index.js`:

| Constant | Default | Meaning |
| --- | --- | --- |
| `LM_STUDIO_URL` | `http://localhost:1234/v1/chat/completions` | LLM endpoint |
| `LLM_MODEL` | `google/gemma-3n-e4b` | Model name sent to the LLM |
| `XTTS_API_URL` | `http://localhost:8020/tts_to_audio/` | TTS endpoint |
| `SPEAKER_PATH` | `/data/reference.wav` | Reference voice path **inside the XTTS container** (mounted from `config/reference.wav`) |
| `BYTES_PER_SECOND` | `48000` | Used to compute WAV duration from file size |
| `CHARS_PER_SECOND_AUDIO` | `15` | Estimated speech rate for buffer calculation |

To change the personality, edit `config/system.txt`. The TTS language is hardcoded to `fr` in `processGenerationQueue`.

## Known limitations

- Proof of concept: no tests, no error recovery beyond status messages (`XTTS ERR` / `XTTS FAIL`).
- Linux only in practice (`paplay`/`aplay`, shell `rm` with a glob, process-group kill).
- `package.json` lists `@huggingface/transformers`, `speaker` and `wavefile`, which are not used by the current `index.js`.
