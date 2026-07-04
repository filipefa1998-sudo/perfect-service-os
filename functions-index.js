/**
 * ============================================================
 *  PSOS — RIDE-ALONG ANALYSIS PIPELINE
 *  Firebase Cloud Functions (Node 20, functions v2)
 *
 *  Flow:
 *    1. PWA uploads 30s audio chunks to Storage:
 *         recordings/{techId}/{apptId}/chunk-000.webm ...
 *    2. PWA sets appointment doc status -> "uploaded"
 *         appointments/{apptId} { techId, trade, chunkCount, ... }
 *    3. onApptUploaded fires:
 *         a. download + concatenate chunks
 *         b. Deepgram -> diarized transcript
 *         c. Claude   -> scorecard JSON (rubric from Firestore)
 *         d. write scorecard, push FCM "driveway debrief"
 *
 *  Deploy:
 *    firebase deploy --only functions
 *  Secrets (one-time):
 *    firebase functions:secrets:set DEEPGRAM_API_KEY
 *    firebase functions:secrets:set ANTHROPIC_API_KEY
 * ============================================================
 */

const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

initializeApp();
const db = getFirestore();

const DEEPGRAM_API_KEY = defineSecret("DEEPGRAM_API_KEY");
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

/* ------------------------------------------------------------------
 * MAIN TRIGGER — appointment audio finished uploading
 * ---------------------------------------------------------------- */
exports.onApptUploaded = onDocumentUpdated(
  {
    document: "jobs/{jobId}",
    secrets: [DEEPGRAM_API_KEY, ANTHROPIC_API_KEY],
    timeoutSeconds: 540,      // long appointments need headroom
    memory: "1GiB",
    region: "us-central1",
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const jobId = event.params.jobId;

    // Only run on the uploading -> uploaded transition (idempotent guard)
    if (before.recStatus === after.recStatus || after.recStatus !== "uploaded") return;

    const ref = event.data.after.ref;
    await ref.update({ recStatus: "processing", processingStartedAt: FieldValue.serverTimestamp() });

    try {
      // ---- 1. Assemble audio ------------------------------------
      const audio = await assembleChunks(after.uid, jobId, after.recChunkCount);

      // ---- 2. Transcribe (Deepgram, diarized) -------------------
      const transcript = await transcribe(
        audio,
        DEEPGRAM_API_KEY.value(),
        after.recContentType || "audio/webm"
      );
      await ref.collection("artifacts").doc("transcript").set({
        segments: transcript.segments,
        durationSec: transcript.durationSec,
        createdAt: FieldValue.serverTimestamp(),
      });

      // ---- 3. Score with Claude ---------------------------------
      const rubric = await loadRubric(after.callType || "plumbing");
      const scorecard = await scoreWithClaude(
        transcript,
        rubric,
        after,
        ANTHROPIC_API_KEY.value()
      );

      // ---- 4. Persist + notify ----------------------------------
      await ref.update({
        recStatus: "scored",
        scorecard,
        scoredAt: FieldValue.serverTimestamp(),
      });
      await updateWeeklyRollup(after.uid, scorecard);
      // Debrief delivery: the PSOS app listens via onSnapshot on this doc — no FCM needed.
    } catch (err) {
      console.error(`[${jobId}] pipeline failed:`, err);
      await ref.update({ recStatus: "error", recError: String(err.message || err) });
    }
  }
);

/* ------------------------------------------------------------------
 * 1. CHUNK ASSEMBLY
 * MediaRecorder webm/opus chunks from one session concatenate
 * cleanly (header lives in chunk-000). Order by zero-padded index.
 * ---------------------------------------------------------------- */
async function assembleChunks(techId, apptId, chunkCount) {
  const bucket = getStorage().bucket();
  const buffers = [];
  for (let i = 0; i < chunkCount; i++) {
    const name = `recordings/${techId}/${apptId}/chunk-${String(i).padStart(3, "0")}.webm`;
    const [buf] = await bucket.file(name).download();
    buffers.push(buf);
  }
  const audio = Buffer.concat(buffers);
  if (audio.length < 10_000) throw new Error("Audio too short — check chunk uploads");
  return audio;
}

/* ------------------------------------------------------------------
 * 2. TRANSCRIPTION — Deepgram nova-2 with diarization
 * Returns { segments:[{speaker,start,end,text}], durationSec }
 * ---------------------------------------------------------------- */
async function transcribe(audioBuffer, dgKey, contentType) {
  const res = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-2&diarize=true&smart_format=true&utterances=true",
    {
      method: "POST",
      headers: { Authorization: `Token ${dgKey}`, "Content-Type": contentType },
      body: audioBuffer,
    }
  );
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const utterances = data.results?.utterances || [];
  if (!utterances.length) throw new Error("Empty transcript");

  // Heuristic: the speaker with the most words is the tech.
  const wordCount = {};
  for (const u of utterances) {
    wordCount[u.speaker] = (wordCount[u.speaker] || 0) + u.transcript.split(" ").length;
  }
  const techSpeaker = Number(
    Object.entries(wordCount).sort((a, b) => b[1] - a[1])[0][0]
  );

  return {
    durationSec: Math.round(data.metadata?.duration || 0),
    segments: utterances.map((u) => ({
      speaker: u.speaker === techSpeaker ? "TECH" : "CUSTOMER",
      start: Math.round(u.start),
      end: Math.round(u.end),
      text: u.transcript,
    })),
  };
}

/* ------------------------------------------------------------------
 * 3a. RUBRIC — coach-editable, per trade, lives in Firestore
 * config/rubrics/{trade} { steps:[{id,label,weight,description}] }
 * Falls back to the default Perfect Service process.
 * ---------------------------------------------------------------- */
async function loadRubric(trade) {
  const snap = await db.doc(`config/rubrics-${trade}`).get();
  if (snap.exists) return snap.data();
  return {
    steps: [
      { id: "arrival",    label: "Professional arrival, intro & rapport",          weight: 8 },
      { id: "agenda",     label: "Set the agenda for the visit",                   weight: 7 },
      { id: "discovery",  label: "Discovery questions before diagnosis",           weight: 15 },
      { id: "inspection", label: "Inspection findings explained in plain talk",    weight: 15 },
      { id: "options",    label: "All three options presented before pricing",     weight: 25 },
      { id: "objections", label: "Objections acknowledged and worked, not dodged", weight: 10 },
      { id: "close",      label: "Clear close attempt (asked for the job)",        weight: 20 },
    ],
  };
}

/* ------------------------------------------------------------------
 * 3b. CLAUDE SCORING
 * One call, strict JSON out, validated before write.
 * ---------------------------------------------------------------- */
async function scoreWithClaude(transcript, rubric, appt, anthropicKey) {
  const transcriptText = transcript.segments
    .map((s) => `[${fmt(s.start)}] ${s.speaker}: ${s.text}`)
    .join("\n");

  const system = `You are the sales coach engine inside Perfect Service OS at a home-services company.
You analyze in-home sales appointment transcripts for a ${appt.callType || "plumbing"} call.
Be direct, specific, and encouraging — coach language a tradesman respects, no corporate fluff.
Score against this process rubric (weights sum to 100):
${rubric.steps.map((s) => `- ${s.id} (${s.weight} pts): ${s.label}`).join("\n")}

Respond with ONLY a JSON object, no markdown fences, no preamble, in exactly this shape:
{
  "overallScore": <0-100 integer>,
  "steps": [{ "id": "<rubric step id>", "hit": <bool>, "points": <int>, "note": "<one short sentence>" }],
  "talkRatio": { "tech": <0-100 int>, "customer": <0-100 int> },
  "moments": [{ "t": <seconds int>, "type": "win"|"miss", "tag": "<3-5 word label>", "quote": "<verbatim short quote>", "note": "<one sentence why it matters>" }],
  "focusBehavior": "<the ONE behavior to work on next, one sentence, imperative voice>",
  "drivewayNote": "<2-3 sentences to the rep: one genuine win, the one focus, delivered like a coach between innings>"
}
Rules: max 4 moments. Exactly one focusBehavior. Never invent quotes — only verbatim transcript text.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: `Appointment transcript (${fmt(transcript.durationSec)} total):\n\n${transcriptText}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const raw = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  let card;
  try {
    card = JSON.parse(raw);
  } catch {
    throw new Error("Claude returned non-JSON scorecard");
  }
  validateScorecard(card, rubric);
  // Attach human labels so the in-app debrief renders step names directly
  card.steps = card.steps.map((s) => {
    const r = rubric.steps.find((x) => x.id === s.id);
    return { ...s, label: r ? r.label : s.id };
  });
  return card;
}

function validateScorecard(card, rubric) {
  const ok =
    Number.isInteger(card.overallScore) &&
    card.overallScore >= 0 &&
    card.overallScore <= 100 &&
    Array.isArray(card.steps) &&
    card.steps.length === rubric.steps.length &&
    typeof card.focusBehavior === "string" &&
    typeof card.drivewayNote === "string" &&
    Array.isArray(card.moments) &&
    card.moments.length <= 4;
  if (!ok) throw new Error("Scorecard failed validation");
}

/* ------------------------------------------------------------------
 * 4a. WEEKLY ROLLUP — powers gauge, leaderboard, coach KPIs
 * rollups/{techId}-{isoWeek} updated transactionally.
 * ---------------------------------------------------------------- */
async function updateWeeklyRollup(techId, scorecard) {
  const week = isoWeek(new Date());
  const ref = db.doc(`rollups/${techId}-${week}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : { count: 0, scoreSum: 0 };
    tx.set(
      ref,
      {
        techId,
        week,
        count: cur.count + 1,
        scoreSum: cur.scoreSum + scorecard.overallScore,
        avgScore: Math.round((cur.scoreSum + scorecard.overallScore) / (cur.count + 1)),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

/* ---------------- utils ---------------- */
function fmt(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}
