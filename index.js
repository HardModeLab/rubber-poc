import readline from 'readline';
import fs from 'fs';
import { exec } from 'child_process';

// --- 1. CONFIGURATION ---
const LM_STUDIO_URL = "http://localhost:1234/v1/chat/completions";
const XTTS_API_URL = "http://localhost:8020/tts_to_audio/";

const SPEAKER_PATH = "/data/reference.wav";
const LLM_MODEL = "google/gemma-3n-e4b";
const LLM_SYSTEM_PROMPT = fs.readFileSync("config/system.txt", "utf-8").trim();

const BYTES_PER_SECOND = 48000;
const CHARS_PER_SECOND_AUDIO = 15;

// --- 2. ÉTATS DU SYSTÈME ---
let generationQueue = [];
let audioQueue = [];

let isGenerating = false;
let isPlaying = false;
let hasStartedPlayback = false;
let isLLMStreamFinished = false;
let currentAudioProcess = null; // Référence pour kill le son

// Métriques & Session
let audioCounter = 0;
let pendingGenerations = 0;
let pendingChars = 0;
let totalBufferedSeconds = 0;
let currentRTF = 0;
let uiStatus = "IDLE";
let requiredBuffer = 0;
let currentSessionId = 0; // Pour invalider les anciennes tâches

// Timer UI
let uiInterval = null;

// --- 3. UI ENGINE (Épuré) ---
const UI = {
    draw: () => {
        process.stdout.write("\x1b7"); // Save position
        process.stdout.write("\x1b[H"); // Move to top-left

        const rtfStr = currentRTF > 0 ? `${currentRTF.toFixed(1)}x` : "CALC..";
        const modeStr = currentRTF > 1.1 ? "SAFE (Wait)" : "LIVE (Stream)";

        // Ligne de Statut unique et propre
        // On combine les infos clés
        const statusContent = ` RTF:${rtfStr} | Q:${audioQueue.length} P:${pendingGenerations} | Mode:${modeStr} | ${uiStatus} `;
        const filledStatus = statusContent.padEnd(process.stdout.columns || 80, ' ');

        // Affichage Fond Bleu / Texte Blanc
        process.stdout.write(`\x1b[44m\x1b[37m${filledStatus}\x1b[0m\n`);

        // Ligne de séparation simple
        const separator = "─".repeat(process.stdout.columns || 80);
        process.stdout.write(`\x1b[90m${separator}\x1b[0m`);

        process.stdout.write("\x1b8"); // Restore position
    }
};

// --- 4. GESTIONNAIRE D'INTERRUPTION ---
function stopEverything() {
    // 1. Changer l'ID de session (invalide les retours de fetch en cours)
    currentSessionId++;

    // 2. Tuer le lecteur audio (GROUPE DE PROCESSUS + KILL HARD)
    if (currentAudioProcess) {
        try {
            // On utilise un PID négatif pour viser le groupe et SIGKILL pour forcer l'arrêt
            process.kill(-currentAudioProcess.pid, 'SIGKILL');
        } catch (e) {
            // Fallback classique
            try { currentAudioProcess.kill('SIGKILL'); } catch (e2) { }
        }
        currentAudioProcess = null;
    }

    // 3. Option Nucléaire : On s'assure qu'aucun lecteur orphelin ne traîne
    // Cela tue tous les processus paplay/aplay lancés par l'utilisateur courant
    exec('pkill -9 paplay; pkill -9 aplay', () => { });

    // 4. Vider les files
    generationQueue = [];
    audioQueue = [];

    // 5. Reset États
    isPlaying = false;
    isGenerating = false;
    hasStartedPlayback = false;
    pendingGenerations = 0;
    pendingChars = 0;
    totalBufferedSeconds = 0;
    uiStatus = "INTERRUPTED";

    // 6. Nettoyage disque
    exec("rm outputs/stream_part_*.wav", () => { });

    UI.draw();
}

// --- 5. AUDIO UTILS ---
function getWavDuration(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return Math.max(0, stats.size - 44) / BYTES_PER_SECOND;
    } catch (e) { return 0; }
}

// --- 6. LECTEUR INTELLIGENT (PLAYER) ---
function tryToStartPlayback() {
    const mySessionId = currentSessionId; // Capture l'ID au moment de l'appel

    // Calcul de la durée audio restante estimée
    const estimatedRemainingAudio = pendingChars / CHARS_PER_SECOND_AUDIO;

    // --- LOGIQUE SAFE vs LIVE ---
    if (currentRTF > 1.1) {
        if (!isLLMStreamFinished) {
            requiredBuffer = 9999;
            if (!hasStartedPlayback) uiStatus = "WAITING LLM...";
        } else {
            const deficit = Math.max(0, currentRTF - 1) * estimatedRemainingAudio;
            requiredBuffer = Math.max(0.5, deficit * 1.2);
        }
    } else {
        requiredBuffer = 1.0;
        if (currentRTF === 0) requiredBuffer = 3.0;
    }

    // Si interruption entre temps, on arrête tout
    if (mySessionId !== currentSessionId) return;

    // Gestion Fin / Famine
    if (!isPlaying && audioQueue.length === 0) {
        if (isLLMStreamFinished && pendingGenerations === 0) {
            uiStatus = "FINISHED";
            // On ne clear pas l'intervalle ici pour garder l'UI active si l'utilisateur n'a pas encore répondu
        } else if (hasStartedPlayback) {
            uiStatus = "BUFFERING (Lag)...";
            hasStartedPlayback = false;
        } else if (uiStatus !== "WAITING LLM...") {
            const percent = requiredBuffer > 0 ? Math.round((totalBufferedSeconds / requiredBuffer) * 100) : 0;
            uiStatus = `BUFFERING ${Math.min(percent, 99)}%`;
        }
        UI.draw();
        return;
    }

    if (isPlaying) {
        UI.draw();
        return;
    }

    // --- DÉCISION ---
    let shouldStart = false;

    if (hasStartedPlayback) {
        uiStatus = "PLAYING";
        shouldStart = true;
    }
    else if (isLLMStreamFinished && pendingGenerations === 0) {
        uiStatus = "FLUSHING";
        shouldStart = true;
    }
    else if (totalBufferedSeconds >= requiredBuffer && totalBufferedSeconds > 0) {
        uiStatus = "PLAYING (Start)";
        shouldStart = true;
    }
    else if (uiStatus.includes("Lag") && totalBufferedSeconds >= (requiredBuffer * 0.8)) {
        uiStatus = "PLAYING (Rescue)";
        shouldStart = true;
    }

    if (shouldStart) {
        isPlaying = true;
        hasStartedPlayback = true;

        const file = audioQueue.shift();
        const duration = getWavDuration(file);

        totalBufferedSeconds = Math.max(0, totalBufferedSeconds - duration);
        UI.draw();

        // Lecture avec stockage du processus pour pouvoir le tuer
        // detached: true est CRUCIAL pour pouvoir tuer le groupe de processus plus tard
        currentAudioProcess = exec(`paplay ${file} || aplay ${file}`, { detached: true }, (err) => {
            // Callback de fin de lecture
            if (mySessionId !== currentSessionId) return; // Si session changée, on arrête

            try { fs.unlinkSync(file); } catch (e) { }

            isPlaying = false;
            currentAudioProcess = null;
            tryToStartPlayback();
        });
    } else {
        UI.draw();
    }
}

// --- 7. GÉNÉRATEUR (XTTS) ---
async function processGenerationQueue() {
    UI.draw();
    if (isGenerating || generationQueue.length === 0) return;

    const mySessionId = currentSessionId;
    isGenerating = true;
    const textToSpeak = generationQueue.shift();
    const currentFile = `outputs/stream_part_${audioCounter++}.wav`;

    if (textToSpeak.length < 3) {
        isGenerating = false;
        pendingGenerations--;
        processGenerationQueue();
        return;
    }

    const startTime = Date.now();

    try {
        const response = await fetch(XTTS_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                "text": textToSpeak,
                "language": "fr",
                "speaker_wav": SPEAKER_PATH
            })
        });

        // Vérification post-fetch : l'utilisateur a-t-il coupé la parole ?
        if (mySessionId !== currentSessionId) {
            isGenerating = false;
            return; // On abandonne sans rien faire
        }

        if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            fs.writeFileSync(currentFile, buffer);

            const genTime = (Date.now() - startTime) / 1000;
            const audioDuration = (buffer.length - 44) / BYTES_PER_SECOND;

            totalBufferedSeconds += audioDuration;
            pendingGenerations--;
            pendingChars -= textToSpeak.length;

            const ratio = genTime / audioDuration;
            if (currentRTF === 0) currentRTF = ratio;
            else currentRTF = (currentRTF * 0.7) + (ratio * 0.3);

            audioQueue.push(currentFile);
            tryToStartPlayback();

        } else {
            uiStatus = "XTTS ERR";
            pendingGenerations--;
        }
    } catch (e) {
        uiStatus = "XTTS FAIL";
        pendingGenerations--;
    } finally {
        // Si la session a changé, on ne relance pas la queue de cette session
        if (mySessionId === currentSessionId) {
            isGenerating = false;
            processGenerationQueue();
        }
    }
}

function addToGenerationQueue(text) {
    if (!text || text.trim().length === 0) return;
    pendingGenerations++;
    pendingChars += text.length;
    generationQueue.push(text.trim());
    processGenerationQueue();
}

// --- 8. STREAMING LLM (Input) ---
async function streamAndSpeak(userPrompt) {
    // Reset complet via stopEverything pour être propre
    audioCounter = 0;
    isLLMStreamFinished = false;
    currentRTF = 0;
    requiredBuffer = 0;
    uiStatus = "THINKING...";

    // Nettoyage écran initial (scrollback)
    process.stdout.write("\x1b[2J\x1b[H");
    console.log("\n\n"); // Place pour le header

    if (uiInterval) clearInterval(uiInterval);
    uiInterval = setInterval(UI.draw, 200);

    const mySessionId = currentSessionId;

    try {
        const response = await fetch(LM_STUDIO_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: LLM_MODEL,
                messages: [
                    { role: "system", content: LLM_SYSTEM_PROMPT },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.7,
                stream: true
            })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        uiStatus = "STREAMING...";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Interruption utilisateur pendant le stream
            if (mySessionId !== currentSessionId) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (!line.trim().startsWith('data: ')) continue;
                const dataStr = line.replace('data: ', '').trim();
                if (dataStr === '[DONE]') break;

                try {
                    const json = JSON.parse(dataStr);
                    const token = json.choices[0].delta.content;

                    if (token) {
                        process.stdout.write(token);
                        buffer += token;

                        // Découpage strict ponctuation
                        if (/[.!?;:]/.test(token) && buffer.length > 50) {
                            const splitMatch = buffer.match(/([.!?;:])\s+/);
                            if (splitMatch) {
                                const cutIndex = splitMatch.index + 1;
                                const chunkToSend = buffer.substring(0, cutIndex);
                                const remainder = buffer.substring(cutIndex);
                                addToGenerationQueue(chunkToSend);
                                buffer = remainder;
                            }
                        }
                    }
                } catch (e) { }
            }
        }

        if (buffer.trim().length > 0 && mySessionId === currentSessionId) {
            addToGenerationQueue(buffer);
        }

    } catch (e) {
        console.error(`\nERREUR: ${e.message}`);
    } finally {
        if (mySessionId === currentSessionId) {
            isLLMStreamFinished = true;
            tryToStartPlayback();
        }
    }
}

// --- 9. BOUCLE PRINCIPALE ---
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function main() {
    exec("rm outputs/stream_part_*.wav", () => { });

    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║           HARDMODELAB - OPTIMIZED VOICE ASSISTANT            ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");

    const ask = () => {
        rl.question('\nVous: ', async (input) => {
            // INTERRUPTION : Dès que l'utilisateur valide une entrée, on coupe tout ce qui précède
            stopEverything();

            if (input === 'exit') process.exit(0);

            // On lance le nouveau stream
            await streamAndSpeak(input);

            // On redonne la main immédiatement pour permettre l'interruption
            // (Le stream tourne en fond, ainsi que l'audio)
            ask();
        });
    };
    ask();
}

main();